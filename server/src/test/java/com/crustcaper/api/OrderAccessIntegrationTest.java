package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.crustcaper.api.recovery.PhoneVerificationGateway;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest(properties = {
    "crustcaper.order-access.provider=local",
    "crustcaper.order-access.dispatch-delay=PT0.15S",
    "crustcaper.order-access.negative-delay=PT0S"
})
@AutoConfigureMockMvc
@ActiveProfiles("local")
class OrderAccessIntegrationTest {
    private static final String ORDERS = "/api/v1/orders";
    private static final String CHALLENGES = "/api/v1/order-access/challenges";
    private static final String KEY = "Idempotency-Key";
    private static final String PHONE = "+250700000000";
    private static final String OTP = "418263";
    private static final String CHECKOUT = "https://checkout.example.invalid/synthetic";

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired GuestSessions sessions;
    @MockitoSpyBean PhoneVerificationGateway gateway;

    private final String store = "recovery-test-" + UUID.randomUUID();
    private final List<UUID> guests = new ArrayList<>();
    private final List<UUID> operators = new ArrayList<>();

    private record ExistingOrder(UUID id, String quoteId) {
        String code() { return id.toString().substring(28).toUpperCase(Locale.ROOT); }
    }

    @BeforeEach
    void fixture() {
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, 'recovery', now() + interval '25 minutes', now() + interval '35 minutes', 4)
            """).param(store).update();
    }

    @AfterEach
    void removeFixtureOnly() {
        jdbc.sql("DELETE FROM order_erasure_requests WHERE store_id = ?").param(store).update();
        for (UUID operator : operators) {
            jdbc.sql("DELETE FROM operator_sessions WHERE operator_id = ?").param(operator).update();
            jdbc.sql("DELETE FROM operator_accounts WHERE id = ?").param(operator).update();
        }
        for (UUID guest : guests) {
            jdbc.sql("DELETE FROM order_access_challenges WHERE guest_session_id = ?").param(guest).update();
        }
        jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
            .param(store).update();
        for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
            jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
        }
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        guests.forEach(guest -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update());
    }

    @Test
    void aVerifiedGuestReadsAndReordersOneOrderWithoutTakingOwnershipOrReceivingACheckoutLink() throws Exception {
        String owner = guest();
        String newDevice = guest();
        String stranger = guest();
        ExistingOrder target = order(owner, "order-owner", PHONE);
        ExistingOrder unrelated = order(owner, "second-owner-order", PHONE);
        api.perform(post(ORDERS + "/" + target.id() + "/payments").header(HttpHeaders.AUTHORIZATION, owner)
            .header(KEY, "payment-owner")).andExpect(status().isOk());
        jdbc.sql("UPDATE payment_attempts SET checkout_url = ? WHERE order_id = ?").params(CHECKOUT, target.id()).update();

        CountDownLatch dispatched = new CountDownLatch(1);
        doAnswer(invocation -> {
            assertThat(Thread.currentThread().getName()).startsWith("order-access-");
            dispatched.countDown();
            return invocation.callRealMethod();
        }).when(gateway).send(PHONE);
        UUID challenge = challenge(newDevice, "#" + target.code(), PHONE);
        assertThat(dispatched.await(5, TimeUnit.SECONDS)).isTrue();
        awaitState(challenge, "sent");
        verifyChallenge(newDevice, challenge, "000000").andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("not_found"));
        verifyChallenge(stranger, challenge, OTP).andExpect(status().isNotFound());
        verifyChallenge(newDevice, challenge, OTP).andExpect(status().isOk())
            .andExpect(jsonPath("$.orderId").value(target.id().toString()));
        jdbc.sql("UPDATE order_access_challenges SET expires_at = clock_timestamp() WHERE id = ?")
            .param(challenge).update();
        verifyChallenge(newDevice, challenge, OTP).andExpect(status().isOk())
            .andExpect(jsonPath("$.orderId").value(target.id().toString()));
        verifyChallenge(stranger, challenge, OTP).andExpect(status().isNotFound());
        verify(gateway, times(2)).check(anyString(), anyString());

        api.perform(get(ORDERS + "/" + target.id()).header(HttpHeaders.AUTHORIZATION, newDevice))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(target.id().toString()))
            .andExpect(jsonPath("$.paymentAttempt.checkoutUrl").isEmpty())
            .andExpect(jsonPath("$.recoveryReadOnly").value(true));
        api.perform(post(ORDERS + "/" + target.id() + "/reorder").header(HttpHeaders.AUTHORIZATION, newDevice))
            .andExpect(status().isOk()).andExpect(jsonPath("$.lines[0].sku").value("double-smash"));
        api.perform(get(ORDERS + "/" + target.id()).header(HttpHeaders.AUTHORIZATION, owner))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentAttempt.checkoutUrl").value(CHECKOUT))
            .andExpect(jsonPath("$.recoveryReadOnly").doesNotExist());
        api.perform(get(ORDERS + "/" + unrelated.id()).header(HttpHeaders.AUTHORIZATION, newDevice))
            .andExpect(status().isNotFound());
        api.perform(post(ORDERS + "/" + target.id() + "/payments").header(HttpHeaders.AUTHORIZATION, newDevice)
            .header(KEY, "payment-owner")).andExpect(status().isNotFound());
        api.perform(get(ORDERS + "/recovery").header(HttpHeaders.AUTHORIZATION, newDevice).header(KEY, "order-owner"))
            .andExpect(status().isNotFound());
        api.perform(post(ORDERS).header(HttpHeaders.AUTHORIZATION, newDevice).header(KEY, "other")
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(
                new ApiModels.OrderInput(target.quoteId(), PHONE, null))))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_expired"));
        assertThat(jdbc.sql("SELECT guest_session_id FROM orders WHERE id = ?")
            .param(target.id()).query(UUID.class).single()).isEqualTo(sessions.authenticate(owner));
        assertThat(jdbc.sql("SELECT count(*) FROM order_read_grants WHERE order_id = ?")
            .param(target.id()).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    void freshOrdinaryOtpAloneGrantsPrivacyAccessAndManagerReviewDoesNotChangeTheOrder() throws Exception {
        String owner = guest();
        String verifiedGuest = guest();
        String otherGuest = guest();
        ExistingOrder target = order(owner, "privacy-owner", PHONE);
        String path = ORDERS + "/" + target.id();
        String erasure = path + "/erasure-request";
        String queue = "/api/v1/operator/erasure-requests";
        String orderBefore = jdbc.sql("SELECT row_to_json(o)::text FROM orders o WHERE id = ?")
            .param(target.id()).query(String.class).single();
        api.perform(get(path + "/data-export").header(HttpHeaders.AUTHORIZATION, owner))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("not_found"));
        api.perform(put(erasure).header(HttpHeaders.AUTHORIZATION, otherGuest)).andExpect(status().isNotFound());

        UUID challenge = challenge(verifiedGuest, target.code(), PHONE);
        awaitState(challenge, "sent");
        verifyChallenge(verifiedGuest, challenge, OTP).andExpect(status().isOk());
        JsonNode data = body(api.perform(get(path + "/data-export").header(HttpHeaders.AUTHORIZATION, verifiedGuest))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store")));
        assertThat(data.propertyNames()).containsExactlyInAnyOrder("orderId", "storeId", "phone", "email", "lines",
            "total", "tax", "currency", "status", "paymentStatus", "receiptStatus", "createdAt",
            "pickupStartsAt", "pickupEndsAt");
        assertThat(data.path("phone").asString()).isEqualTo(PHONE);
        assertThat(data.path("email").isNull()).isTrue();
        assertThat(data.path("orderId").asString()).isEqualTo(target.id().toString());
        assertThat(data.path("lines").path(0).path("sku").asString()).isEqualTo("double-smash");
        assertThat(body(api.perform(get(erasure).header(HttpHeaders.AUTHORIZATION, verifiedGuest))
            .andExpect(status().isOk())).path("request").isNull()).isTrue();
        JsonNode submitted = body(api.perform(put(erasure).header(HttpHeaders.AUTHORIZATION, verifiedGuest))
            .andExpect(status().isOk())).path("request");
        assertThat(submitted.path("status").asString()).isEqualTo("pending");
        assertThat(submitted.path("reviewedAt").isNull()).isTrue();
        assertThat(body(api.perform(put(erasure).header(HttpHeaders.AUTHORIZATION, verifiedGuest))
            .andExpect(status().isOk())).path("request")).isEqualTo(submitted);
        UUID requestId = UUID.fromString(submitted.path("requestId").asString());
        String review = queue + "/" + requestId + "/review";

        String manager = operator(store, "manager");
        String anotherManager = operator(store, "manager");
        String kitchen = operator(store, "kitchen");
        String otherStore = operator("kigali", "manager");
        api.perform(get(queue).header(HttpHeaders.AUTHORIZATION, kitchen)).andExpect(status().isForbidden());
        api.perform(get(queue).header(HttpHeaders.AUTHORIZATION, otherStore))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
        api.perform(post(review).header(HttpHeaders.AUTHORIZATION, otherStore)).andExpect(status().isNotFound());
        JsonNode pending = body(api.perform(get(queue).header(HttpHeaders.AUTHORIZATION, manager))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(1))).path(0);
        assertThat(pending.propertyNames()).containsExactlyInAnyOrder("requestId", "orderId", "submittedAt", "status", "reviewedAt");
        assertThat(pending.path("orderId").asString()).isEqualTo(target.id().toString());
        JsonNode reviewed = body(api.perform(post(review).header(HttpHeaders.AUTHORIZATION, manager))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("in_review")));
        UUID reviewer = jdbc.sql("SELECT reviewed_by FROM order_erasure_requests WHERE id = ?")
            .param(requestId).query(UUID.class).single();
        assertThat(reviewer).isEqualTo(operators.getFirst());
        assertThat(body(api.perform(post(review).header(HttpHeaders.AUTHORIZATION, anotherManager))
            .andExpect(status().isOk()))).isEqualTo(reviewed);
        assertThat(jdbc.sql("SELECT reviewed_by FROM order_erasure_requests WHERE id = ?")
            .param(requestId).query(UUID.class).single()).isEqualTo(reviewer);
        JsonNode repeated = body(api.perform(put(erasure).header(HttpHeaders.AUTHORIZATION, verifiedGuest))
            .andExpect(status().isOk())).path("request");
        assertThat(repeated.path("requestId")).isEqualTo(reviewed.path("requestId"));
        assertThat(repeated.path("status")).isEqualTo(reviewed.path("status"));
        assertThat(repeated.path("reviewedAt")).isEqualTo(reviewed.path("reviewedAt"));
        api.perform(get(queue).header(HttpHeaders.AUTHORIZATION, manager))
            .andExpect(status().isOk()).andExpect(jsonPath("$.length()").value(0));
        api.perform(get(queue).queryParam("status", "in_review").header(HttpHeaders.AUTHORIZATION, manager))
            .andExpect(status().isOk()).andExpect(jsonPath("$[0].requestId").value(requestId.toString()));

        UUID guest = sessions.authenticate(verifiedGuest);
        OffsetDateTime stale = jdbc.sql("""
            UPDATE order_read_grants SET privacy_verified_at = clock_timestamp() - interval '11 minutes'
            WHERE guest_session_id = ? AND order_id = ? RETURNING privacy_verified_at
            """).params(guest, target.id()).query(OffsetDateTime.class).single();
        verifyChallenge(verifiedGuest, challenge, OTP).andExpect(status().isOk());
        assertThat(jdbc.sql("SELECT privacy_verified_at FROM order_read_grants WHERE guest_session_id = ? AND order_id = ?")
            .params(guest, target.id()).query(OffsetDateTime.class).single()).isEqualTo(stale);
        api.perform(get(path + "/data-export").header(HttpHeaders.AUTHORIZATION, verifiedGuest))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("not_found"));
        api.perform(get(erasure).header(HttpHeaders.AUTHORIZATION, verifiedGuest)).andExpect(status().isNotFound());
        api.perform(put(erasure).header(HttpHeaders.AUTHORIZATION, verifiedGuest)).andExpect(status().isNotFound());
        assertThat(jdbc.sql("SELECT row_to_json(o)::text FROM orders o WHERE id = ?")
            .param(target.id()).query(String.class).single()).isEqualTo(orderBefore);
    }

    @Test
    void genericStartDoesNotDispatchForWrongPhoneUnknownCodeOrCollidingSuffix() throws Exception {
        String owner = guest();
        String seeker = guest();
        ExistingOrder first = order(owner, "first", PHONE);
        ExistingOrder second = order(owner, "second", "+250700000001");
        UUID wrongPhone = challenge(seeker, first.code(), "+250700000001");
        awaitState(wrongPhone, "closed");
        String unknownCode = first.code().equals("00000000") || second.code().equals("00000000") ? "EEEEEEEE" : "00000000";
        UUID unknown = challenge(seeker, unknownCode, PHONE);
        awaitState(unknown, "closed");
        UUID colliding = UUID.fromString("00000000-0000-4000-8000-0000" + first.code());
        jdbc.sql("UPDATE orders SET id = ? WHERE id = ?").params(colliding, second.id()).update();
        UUID collision = challenge(seeker, first.code(), PHONE);
        awaitState(collision, "closed");

        for (UUID challenge : List.of(wrongPhone, unknown, collision, UUID.randomUUID())) {
            verifyChallenge(seeker, challenge, OTP).andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("not_found"));
        }
        verify(gateway, times(0)).send(anyString());
        verify(gateway, times(0)).check(anyString(), anyString());
    }

    @Test
    void canonicalInputAndBearerAreRequiredAndStartRateRemainsGeneric() throws Exception {
        String seeker = guest();
        api.perform(post(CHALLENGES).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(new OrderAccessController.StartInput("00000000", PHONE))))
            .andExpect(status().isUnauthorized());
        start(seeker, "0XX00000", PHONE).andExpect(status().isBadRequest());
        start(seeker, "00000000", "250 700 000 000").andExpect(status().isBadRequest());

        UUID inRate = challenge(seeker, "00000000", PHONE);
        challenge(seeker, "00000000", PHONE);
        challenge(seeker, "00000000", PHONE);
        UUID overRate = challenge(seeker, "00000000", PHONE);
        assertThat(jdbc.sql("SELECT count(*) FROM order_access_challenges WHERE guest_session_id = ?")
            .param(sessions.authenticate(seeker)).query(Long.class).single()).isEqualTo(3);
        verifyChallenge(seeker, overRate, OTP).andExpect(status().isNotFound());
        verifyChallenge(seeker, inRate, "not a code").andExpect(status().isBadRequest());
    }

    @Test
    void globalQueueAdmitsOnlyOneOfTwoConcurrentRequestsForItsLastPlace() throws Exception {
        ExistingOrder order = order(guest(), "hold-dispatch", PHONE);
        String sendingGuest = guest();
        UUID filler = sessions.authenticate(guest());
        String firstGuest = guest();
        String secondGuest = guest();
        CountDownLatch dispatching = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        doAnswer(invocation -> {
            dispatching.countDown();
            if (!release.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
            return invocation.callRealMethod();
        }).when(gateway).send(PHONE);
        UUID active = challenge(sendingGuest, order.code(), PHONE);
        try {
            assertThat(dispatching.await(5, TimeUnit.SECONDS)).isTrue();
            jdbc.sql("""
                INSERT INTO order_access_challenges (id, guest_session_id, order_code, phone_digest, state, expires_at)
                SELECT gen_random_uuid(), ?, '00000000', decode(repeat('00', 32), 'hex'), 'queued',
                    clock_timestamp() + interval '10 minutes'
                FROM generate_series(1,119)
                """).param(filler).update();
            CountDownLatch start = new CountDownLatch(1);
            try (var pool = Executors.newFixedThreadPool(2)) {
                var a = pool.submit(() -> {
                    if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                    return challenge(firstGuest, "00000000", PHONE);
                });
                var b = pool.submit(() -> {
                    if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
                    return challenge(secondGuest, "00000000", PHONE);
                });
                start.countDown();
                assertThat(jdbc.sql("SELECT count(*) FROM order_access_challenges WHERE id IN (?, ?)")
                    .params(a.get(5, TimeUnit.SECONDS), b.get(5, TimeUnit.SECONDS)).query(Long.class).single()).isEqualTo(1);
            }
            assertThat(jdbc.sql("SELECT count(*) FROM order_access_challenges WHERE state = 'queued'")
                .query(Long.class).single()).isEqualTo(120);
        } finally {
            jdbc.sql("DELETE FROM order_access_challenges WHERE guest_session_id = ?").param(filler).update();
            release.countDown();
        }
        awaitState(active, "sent");
    }

    @Test
    void onlyOnePhoneChallengeCanSendAndFailuresAreBoundedAcrossConcurrentChecks() throws Exception {
        String owner = guest();
        String seeker = guest();
        String otherDevice = guest();
        ExistingOrder original = order(owner, "first", PHONE);
        ExistingOrder other = order(owner, "second", PHONE);
        UUID first = challenge(seeker, original.code(), PHONE);
        awaitState(first, "sent");
        UUID overlapping = challenge(otherDevice, other.code(), PHONE);
        awaitState(overlapping, "closed");
        verifyChallenge(otherDevice, overlapping, OTP).andExpect(status().isNotFound());
        verify(gateway).send(PHONE);

        CountDownLatch checking = new CountDownLatch(1);
        CountDownLatch decide = new CountDownLatch(1);
        doAnswer(invocation -> {
            checking.countDown();
            if (!decide.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test barrier timed out");
            return invocation.callRealMethod();
        }).when(gateway).check(anyString(), anyString());
        try (var pool = Executors.newSingleThreadExecutor()) {
            var pending = pool.submit(() -> verifyChallenge(seeker, first, "000001").andReturn());
            try {
                assertThat(checking.await(5, TimeUnit.SECONDS)).isTrue();
                verifyChallenge(seeker, first, OTP).andExpect(status().isNotFound());
            } finally {
                decide.countDown();
            }
            assertThat(pending.get(5, TimeUnit.SECONDS).getResponse().getStatus()).isEqualTo(404);
        }
        verify(gateway).check(anyString(), anyString());

        for (int i = 0; i < 4; i++) {
            verifyChallenge(seeker, first, "000002").andExpect(status().isNotFound());
        }
        verifyChallenge(seeker, first, OTP).andExpect(status().isNotFound());
        verify(gateway, times(5)).check(anyString(), anyString());
        assertThat(jdbc.sql("SELECT count(*) FROM order_read_grants WHERE order_id = ?")
            .param(original.id()).query(Long.class).single()).isZero();
    }

    @Test
    void expiredChallengeCannotVerifyEvenWithTheCorrectCode() throws Exception {
        ExistingOrder order = order(guest(), "original", PHONE);
        String seeker = guest();
        UUID challenge = challenge(seeker, order.code(), PHONE);
        awaitState(challenge, "sent");
        jdbc.sql("UPDATE order_access_challenges SET expires_at = clock_timestamp() WHERE id = ?")
            .param(challenge).update();
        verifyChallenge(seeker, challenge, OTP).andExpect(status().isNotFound());
        verify(gateway, times(0)).check(anyString(), anyString());
    }

    private String guest() throws Exception {
        JsonNode result = body(api.perform(post("/api/v1/guest-sessions")).andExpect(status().isOk()));
        String bearer = "Bearer " + result.path("accessToken").asString();
        guests.add(sessions.authenticate(bearer));
        return bearer;
    }

    private String operator(String location, String role) throws Exception {
        UUID id = UUID.randomUUID();
        String username = "privacy-" + id;
        operators.add(id);
        jdbc.sql("""
            INSERT INTO operator_accounts (id, store_id, username, role, password_hash)
            SELECT ?, ?, ?, ?, password_hash FROM operator_accounts WHERE username = 'demo-manager'
            """).params(id, location, username, role).update();
        JsonNode issued = body(api.perform(post("/api/v1/operator/sessions").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(Map.of("username", username, "password", "local-demo-passphrase"))))
            .andExpect(status().isCreated()));
        return "Bearer " + issued.path("accessToken").asString();
    }

    private ExistingOrder order(String bearer, String key, String phone) throws Exception {
        JsonNode quote = body(api.perform(post("/api/v1/quotes").header(HttpHeaders.AUTHORIZATION, bearer)
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"storeId":"%s","slotId":"recovery","lines":[{"sku":"double-smash","modifierIds":[],"quantity":1,"unitPrice":9200}]}
                """.formatted(store))).andExpect(status().isOk()));
        String quoteId = quote.path("quoteId").asString();
        JsonNode created = body(api.perform(post(ORDERS).header(HttpHeaders.AUTHORIZATION, bearer).header(KEY, key)
            .contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(new ApiModels.OrderInput(quoteId, phone, null))))
            .andExpect(status().isOk()));
        return new ExistingOrder(UUID.fromString(created.path("id").asString()), quoteId);
    }

    private UUID challenge(String bearer, String code, String phone) throws Exception {
        JsonNode response = body(start(bearer, code, phone).andExpect(status().isAccepted())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.challengeId").isString()));
        assertThat(response.size()).isEqualTo(1);
        return UUID.fromString(response.path("challengeId").asString());
    }

    private ResultActions start(String bearer, String code, String phone) throws Exception {
        return api.perform(post(CHALLENGES).header(HttpHeaders.AUTHORIZATION, bearer)
            .contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(new OrderAccessController.StartInput(code, phone))));
    }

    private ResultActions verifyChallenge(String bearer, UUID challenge, String code) throws Exception {
        ResultActions request = api.perform(post(CHALLENGES + "/" + challenge + "/verify")
            .header(HttpHeaders.AUTHORIZATION, bearer).contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(new OrderAccessController.VerifyInput(code))));
        var initial = request.andReturn();
        return initial.getRequest().isAsyncStarted() ? api.perform(asyncDispatch(initial)) : request;
    }

    private void awaitState(UUID challenge, String state) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        String latest;
        do {
            latest = jdbc.sql("SELECT state FROM order_access_challenges WHERE id = ?")
                .param(challenge).query(String.class).single();
            if (state.equals(latest)) return;
            Thread.sleep(20);
        } while (System.nanoTime() < deadline);
        assertThat(latest).isEqualTo(state);
    }

    private JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsByteArray());
    }
}
