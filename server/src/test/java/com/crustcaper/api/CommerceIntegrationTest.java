package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
class CommerceIntegrationTest {
    private static final String ROOT = "/api/v1";
    private static final String KEY = "Idempotency-Key";
    private static final String PHONE = "+250700000000";
    private static final String SLOT = "test-slot";

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired GuestSessions sessions;
    @Autowired OrderService orders;

    private String store;
    private final List<UUID> guests = new ArrayList<>();

    @BeforeEach
    void fixture() {
        store = "test-" + UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, open, tax_basis_points, version FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '25 minutes', now() + interval '35 minutes', 1)
            """).params(store, SLOT).update();
    }

    @AfterEach
    void removeFixtureOnly() {
        if (store == null) return;
        jdbc.sql("""
            DELETE FROM payment_exceptions WHERE attempt_id IN (
                SELECT p.id FROM payment_attempts p JOIN orders o ON o.id = p.order_id WHERE o.store_id = ?
            )
            """).param(store).update();
        jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
            .param(store).update();
        for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
            jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
        }
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        guests.forEach(guest -> jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update());
    }

    @Test
    void menuHasConditionalCachingAndGuestAccessUsesAnExpiringHashedCredential() throws Exception {
        String menu = ROOT + "/stores/" + store + "/menu";
        String etag = api.perform(get(menu)).andExpect(status().isOk())
            .andExpect(jsonPath("$.products[0].sku").value("double-smash"))
            .andReturn().getResponse().getHeader("ETag");
        assertThat(etag).isNotBlank();
        api.perform(get(menu).header(HttpHeaders.IF_NONE_MATCH, etag)).andExpect(status().isNotModified());

        String bearer = guest();
        String stored = jdbc.sql("SELECT token_hash FROM guest_access_tokens WHERE guest_session_id = ?")
            .param(guests.getFirst()).query(String.class).single();
        assertThat(stored).hasSize(64).doesNotContain(bearer.substring(7));
        jdbc.sql("UPDATE guest_sessions SET expires_at = now() WHERE id = ?").param(guests.getFirst()).update();
        api.perform(get(ROOT + "/orders/recovery").header(HttpHeaders.AUTHORIZATION, bearer).header(KEY, "unknown"))
            .andExpect(status().isUnauthorized())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("unauthenticated"));
    }

    @Test
    void refreshSurvivesLostResponseAndKeepsAnExistingOrderUnderTheSameGuest() throws Exception {
        JsonNode issued = issueGuest();
        String original = bearer(issued);
        String refreshToken = issued.path("refreshToken").asString("");
        String quoteId = quote(original).path("quoteId").asString("");
        String id = body(create(original, quoteId, "refresh-order").andExpect(status().isOk())).path("id").asString("");

        JsonNode firstRefresh = refresh(refreshToken);
        JsonNode retried = refresh(refreshToken);
        assertThat(firstRefresh.path("refreshToken").asString("")).isEqualTo(refreshToken);
        assertThat(retried.path("refreshExpiresAt").asString("")).isEqualTo(issued.path("refreshExpiresAt").asString(""));
        assertThat(retried.path("accessToken").asString("")).isNotEqualTo(issued.path("accessToken").asString(""));
        assertThat(sessions.authenticate(bearer(retried))).isEqualTo(sessions.authenticate(original));
        String savedRefreshHash = jdbc.sql("SELECT refresh_token_hash FROM guest_sessions WHERE id = ?")
            .param(guests.getFirst()).query(String.class).single();
        assertThat(savedRefreshHash).hasSize(64).isNotEqualTo(refreshToken);

        jdbc.sql("UPDATE guest_access_tokens SET expires_at = now() WHERE guest_session_id = ?")
            .param(guests.getFirst()).update();
        api.perform(get(orderPath(id)).header(HttpHeaders.AUTHORIZATION, original)).andExpect(status().isUnauthorized());
        JsonNode renewed = refresh(refreshToken);
        api.perform(get(orderPath(id)).header(HttpHeaders.AUTHORIZATION, bearer(renewed)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id));
        jdbc.sql("UPDATE guest_sessions SET expires_at = now() WHERE id = ?").param(guests.getFirst()).update();
        api.perform(post(ROOT + "/guest-sessions/refresh").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(new ApiModels.GuestRefresh(refreshToken))))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void orderReplayAndRecoveryStayWithTheOriginalGuest() throws Exception {
        String owner = guest();
        String anotherGuest = guest();
        JsonNode quote = quote(owner);
        String quoteId = quote.path("quoteId").asString("");
        assertThat(quote.path("tax").asLong()).isEqualTo(1403);
        String id = body(create(owner, quoteId, "order-1").andExpect(status().isOk())).path("id").asString("");
        jdbc.sql("UPDATE quotes SET expires_at = now() WHERE id = ?").param(UUID.fromString(quoteId)).update();
        create(owner, quoteId, "order-1").andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id));
        create(owner, quoteId, "order-2").andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("conflict"));
        api.perform(get(ROOT + "/orders/recovery").header(HttpHeaders.AUTHORIZATION, owner).header(KEY, "order-1"))
            .andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id));
        api.perform(get(ROOT + "/orders/recovery").header(HttpHeaders.AUTHORIZATION, anotherGuest).header(KEY, "order-1"))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("not_found"));
        api.perform(get(orderPath(id)).header(HttpHeaders.AUTHORIZATION, anotherGuest))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("not_found"));
        api.perform(post(orderPath(id) + "/payments").header(HttpHeaders.AUTHORIZATION, anotherGuest).header(KEY, "x"))
            .andExpect(status().isNotFound());
        Long count = jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?").param(store).query(Long.class).single();
        assertThat(count).isEqualTo(1);
    }

    @Test
    void changedPickupWindowAndPricesRequireAReviewedQuote() throws Exception {
        String owner = guest();
        JsonNode beforeSlotChange = quote(owner);
        jdbc.sql("UPDATE pickup_slots SET ends_at = ends_at + interval '2 minutes' WHERE store_id = ?")
            .param(store).update();
        create(owner, beforeSlotChange.path("quoteId").asString(""), "stale-slot")
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_changed"));

        JsonNode beforePriceChange = quote(owner);
        jdbc.sql("UPDATE menu_products SET product = jsonb_set(product, '{price}', '9800') WHERE store_id = ?")
            .param(store).update();
        create(owner, beforePriceChange.path("quoteId").asString(""), "stale-price")
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("quote_changed"));
        JsonNode updated = quote(owner);
        assertThat(updated.path("total").asLong()).isEqualTo(9800);
        assertThat(updated.path("changes").get(0).path("kind").asString("")).isEqualTo("price");
        create(owner, updated.path("quoteId").asString(""), "approved").andExpect(status().isOk());
    }

    @Test
    void simultaneousReservationsByDifferentGuestsCannotOversellTheLastSlot() throws Exception {
        String first = guest();
        String second = guest();
        String firstQuote = quote(first).path("quoteId").asString("");
        String secondQuote = quote(second).path("quoteId").asString("");
        var ready = new CountDownLatch(2);
        var start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var a = pool.submit(() -> {
                ready.countDown();
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Start barrier timed out");
                return create(first, firstQuote, "one").andReturn().getResponse().getStatus();
            });
            var b = pool.submit(() -> {
                ready.countDown();
                if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Start barrier timed out");
                return create(second, secondQuote, "two").andReturn().getResponse().getStatus();
            });
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(List.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS)))
                .containsExactlyInAnyOrder(200, 409);
        }
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?")
            .param(store).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    void stablePaymentAttemptRejectsOldOrMismatchedResultsAndLatePaymentNeedsReview() throws Exception {
        String owner = guest();
        String quoteId = quote(owner).path("quoteId").asString("");
        String orderId = body(create(owner, quoteId, "order").andExpect(status().isOk())).path("id").asString("");
        String first = beginPayment(owner, orderId, "attempt-1");
        assertThat(beginPayment(owner, orderId, "attempt-1")).isEqualTo(first);
        api.perform(post(orderPath(orderId) + "/payments").header(HttpHeaders.AUTHORIZATION, owner).header(KEY, "pending"))
            .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("payment_pending"));
        localResult(owner, orderId, first, "declined").andExpect(status().isOk())
            .andExpect(jsonPath("$.paymentStatus").value("declined"));
        String second = beginPayment(owner, orderId, "attempt-2");
        assertThat(second).isNotEqualTo(first);
        localResult(owner, orderId, first, "paid").andExpect(status().isConflict());
        assertThatThrownBy(() -> orders.settlePayment(new VerifiedPayment(second, "mismatch", 1, "RWF", PaymentResult.PAID)))
            .isInstanceOf(ApiFailure.class).hasMessage("payment_mismatch");
        api.perform(get(orderPath(orderId)).header(HttpHeaders.AUTHORIZATION, owner))
            .andExpect(jsonPath("$.paymentStatus").value("processing"));
        jdbc.sql("UPDATE orders SET reservation_expires_at = now() WHERE id = ?").param(UUID.fromString(orderId)).update();
        localResult(owner, orderId, second, "paid").andExpect(status().isOk())
            .andExpect(jsonPath("$.paymentStatus").value("refund_pending"))
            .andExpect(jsonPath("$.status").value("cancelled"))
            .andExpect(jsonPath("$.pickupCode").isEmpty());
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
            .param(UUID.fromString(second)).query(String.class).single()).isEqualTo("unavailable_reservation");
    }

    @Test
    void aSecondVerifiedChargeForTheSameAttemptLeavesOneAcceptedOrderAndAReviewRecord() throws Exception {
        String owner = guest();
        String quoteId = quote(owner).path("quoteId").asString("");
        String orderId = body(create(owner, quoteId, "first").andExpect(status().isOk())).path("id").asString("");
        String attempt = beginPayment(owner, orderId, "payment");

        var first = new VerifiedPayment(attempt, "charge-original", 9200, "RWF", PaymentResult.PAID);
        var second = new VerifiedPayment(attempt, "charge-repeat", 9200, "RWF", PaymentResult.PAID);
        orders.settlePayment(first);
        orders.settlePayment(first);
        orders.settlePayment(second);
        orders.settlePayment(second);

        api.perform(get(orderPath(orderId)).header(HttpHeaders.AUTHORIZATION, owner))
            .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("accepted"))
            .andExpect(jsonPath("$.paymentStatus").value("paid")).andExpect(jsonPath("$.pickupCode").isString());
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
            .param(UUID.fromString(attempt)).query(String.class).list()).containsExactly("duplicate_transaction");
    }

    @Test
    void captureCannotAdmitAnOrderIntoAChangedPickupWindowUnderTheSameSlotId() throws Exception {
        String owner = guest();
        String quoteId = quote(owner).path("quoteId").asString("");
        JsonNode order = body(create(owner, quoteId, "first").andExpect(status().isOk()));
        String orderId = order.path("id").asString("");
        String attempt = beginPayment(owner, orderId, "payment");
        jdbc.sql("UPDATE pickup_slots SET ends_at = ends_at + interval '10 seconds' WHERE store_id = ? AND id = ?")
            .params(store, SLOT).update();

        localResult(owner, orderId, attempt, "paid").andExpect(status().isOk())
            .andExpect(jsonPath("$.paymentStatus").value("refund_pending"))
            .andExpect(jsonPath("$.status").value("cancelled"))
            .andExpect(jsonPath("$.pickupEndsAt").value(order.path("pickupEndsAt").asString("")))
            .andExpect(jsonPath("$.pickupCode").isEmpty());
    }

    @Test
    void maximumPayableAmountAppliesToTheWholeCartBeforeStoringTheQuote() throws Exception {
        String owner = guest();
        setProductPrice(1_000_000_000L);
        JsonNode payable = body(quoteRequest(owner, 2, 1_000_000_000L).andExpect(status().isOk()));
        assertThat(payable.path("total").asLong()).isEqualTo(2_000_000_000L);

        quoteRequest(owner, 3, 1_000_000_000L).andExpect(status().isBadRequest())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
            .andExpect(jsonPath("$.code").value("invalid_input"));
        assertThat(jdbc.sql("SELECT count(*) FROM quotes WHERE store_id = ?")
            .param(store).query(Long.class).single()).isEqualTo(1);
    }

    @Test
    void legacyOversizedAmountsCannotCreateAnOrderOrEnterPaymentProcessing() throws Exception {
        String owner = guest();
        setProductPrice(1_000_000_000L);
        String legacyQuote = body(quoteRequest(owner, 2, 1_000_000_000L).andExpect(status().isOk()))
            .path("quoteId").asString("");
        jdbc.sql("""
            UPDATE quotes SET total = 3000000000, tax = 457627119, lines = jsonb_set(lines, '{0,quantity}', '3')
            WHERE id = ?
            """).param(UUID.fromString(legacyQuote)).update();
        create(owner, legacyQuote, "legacy-quote").andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.code").value("invalid_input"));
        assertThat(jdbc.sql("SELECT count(*) FROM orders WHERE store_id = ?")
            .param(store).query(Long.class).single()).isZero();

        String freshQuote = body(quoteRequest(owner, 2, 1_000_000_000L).andExpect(status().isOk()))
            .path("quoteId").asString("");
        String legacyOrder = body(create(owner, freshQuote, "old-order").andExpect(status().isOk()))
            .path("id").asString("");
        jdbc.sql("""
            UPDATE orders SET total = 3000000000, tax = 457627119, lines = jsonb_set(lines, '{0,quantity}', '3') WHERE id = ?
            """).param(UUID.fromString(legacyOrder)).update();
        api.perform(post(orderPath(legacyOrder) + "/payments").header(HttpHeaders.AUTHORIZATION, owner).header(KEY, "attempt"))
            .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_input"));
        api.perform(get(orderPath(legacyOrder)).header(HttpHeaders.AUTHORIZATION, owner))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("unpaid"))
            .andExpect(jsonPath("$.paymentAttempt").isEmpty());
        assertThat(jdbc.sql("SELECT count(*) FROM payment_attempts WHERE order_id = ?")
            .param(UUID.fromString(legacyOrder)).query(Long.class).single()).isZero();
    }

    private void setProductPrice(long amount) {
        jdbc.sql("UPDATE menu_products SET product = jsonb_set(product, '{price}', to_jsonb(CAST(? AS bigint))) WHERE store_id = ?")
            .params(amount, store).update();
    }

    private String guest() throws Exception {
        return bearer(issueGuest());
    }

    private JsonNode issueGuest() throws Exception {
        JsonNode session = body(api.perform(post(ROOT + "/guest-sessions")).andExpect(status().isOk()));
        guests.add(sessions.authenticate(bearer(session)));
        return session;
    }

    private JsonNode refresh(String token) throws Exception {
        return body(api.perform(post(ROOT + "/guest-sessions/refresh").contentType(MediaType.APPLICATION_JSON)
            .content(json.writeValueAsString(new ApiModels.GuestRefresh(token)))).andExpect(status().isOk()));
    }

    private static String bearer(JsonNode session) {
        return "Bearer " + session.path("accessToken").asString("");
    }

    private JsonNode quote(String bearer) throws Exception {
        return body(quoteRequest(bearer, 1, 9200).andExpect(status().isOk()));
    }

    private ResultActions quoteRequest(String bearer, int quantity, long unitPrice) throws Exception {
        return api.perform(post(ROOT + "/quotes")
            .header(HttpHeaders.AUTHORIZATION, bearer).contentType(MediaType.APPLICATION_JSON)
            .content("""
                {"storeId":"%s","slotId":"%s","lines":[{"sku":"double-smash","modifierIds":[],"quantity":%d,"unitPrice":%d}]}
                """.formatted(store, SLOT, quantity, unitPrice)));
    }

    private ResultActions create(String bearer, String quoteId, String key) throws Exception {
        return api.perform(post(ROOT + "/orders").header(HttpHeaders.AUTHORIZATION, bearer).header(KEY, key)
            .contentType(MediaType.APPLICATION_JSON).content("""
                {"quoteId":"%s","phone":"%s"}
                """.formatted(quoteId, PHONE)));
    }

    private String beginPayment(String bearer, String orderId, String key) throws Exception {
        return body(api.perform(post(orderPath(orderId) + "/payments")
            .header(HttpHeaders.AUTHORIZATION, bearer).header(KEY, key))
            .andExpect(status().isOk())).path("id").asString("");
    }

    private ResultActions localResult(String bearer, String orderId, String attempt, String status) throws Exception {
        return api.perform(post(ROOT + "/local/orders/" + orderId + "/payments/" + attempt + "/result")
            .header(HttpHeaders.AUTHORIZATION, bearer).contentType(MediaType.APPLICATION_JSON)
            .content("{\"status\":\"" + status + "\"}"));
    }

    private JsonNode body(ResultActions result) throws Exception {
        return json.readTree(result.andReturn().getResponse().getContentAsByteArray());
    }

    private static String orderPath(String id) {
        return ROOT + "/orders/" + id;
    }
}
