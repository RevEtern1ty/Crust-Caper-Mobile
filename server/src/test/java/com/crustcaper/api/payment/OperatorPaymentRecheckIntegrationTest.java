package com.crustcaper.api.payment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.nullValue;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.operator.OperatorMfaFixture;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.convention.TestBean;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

@SpringBootTest(properties = {
    "crustcaper.payment.provider=flutterwave",
    "crustcaper.payment.reconciliation.enabled=false",
    "spring.datasource.hikari.schema=operator_payment_recheck_test",
    "spring.flyway.schemas=operator_payment_recheck_test"
})
@AutoConfigureMockMvc
@ActiveProfiles("local")
@DirtiesContext
class OperatorPaymentRecheckIntegrationTest {
    @DynamicPropertySource
    static void operatorMfaKey(DynamicPropertyRegistry registry) {
        OperatorMfaFixture.registerKey(registry);
    }

    private static final String OPERATOR = "/api/v1/operator";
    private static final String ATTEMPTS = OPERATOR + "/payment-attempts";
    private static final String PROVIDER_TRANSACTION = "3456517";
    private static final String WEBHOOK_SECRET = "operator-recheck-webhook-fixture";
    private static final long TOTAL = 9700;

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @MockitoBean(name = "flutterwaveGateway", enforceOverride = true) FlutterwavePaymentGateway gateway;
    @TestBean(name = "flutterwaveWebhookSignature", enforceOverride = true) FlutterwaveWebhookSignature signature;

    private final List<Store> stores = new ArrayList<>();

    static FlutterwaveWebhookSignature signature() {
        return new FlutterwaveWebhookSignature(WEBHOOK_SECRET);
    }

    @AfterEach
    void removeFixtures() {
        for (Store store : stores) {
            jdbc.sql("DELETE FROM payment_exceptions WHERE attempt_id IN (SELECT p.id FROM payment_attempts p "
                + "JOIN orders o ON o.id = p.order_id WHERE o.store_id = ?)").param(store.id()).update();
            jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
                .param(store.id()).update();
            jdbc.sql("DELETE FROM operator_sessions WHERE operator_id IN (SELECT id FROM operator_accounts WHERE store_id = ?)")
                .param(store.id()).update();
            for (String table : List.of("operator_accounts", "orders", "quotes", "pickup_slots")) {
                jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store.id()).update();
            }
            jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(store.guest()).update();
            jdbc.sql("DELETE FROM stores WHERE id = ?").param(store.id()).update();
        }
    }

    @Test
    void onlyManagersCanSeeOrCheckHistoricalUnresolvedAttemptsFromTheirStore() throws Exception {
        Store own = store();
        Store other = store();
        Attempt eligible = attempt(own, 49);
        Attempt oldest = attempt(own, 72);
        Attempt nearCutoff = attempt(own, 47);
        Attempt active = attempt(own, -1);
        Attempt outsideStore = attempt(other, 80);
        Attempt declined = attempt(own, 60);
        jdbc.sql("UPDATE payment_attempts SET status = 'declined' WHERE id = ?").param(declined.id()).update();
        String manager = staff(own, "manager");

        list(null).andExpect(status().isUnauthorized());
        recheck(null, eligible).andExpect(status().isUnauthorized());
        for (String role : List.of("kitchen", "pickup")) {
            String staff = staff(own, role);
            list(staff).andExpect(status().isForbidden());
            recheck(staff, eligible).andExpect(status().isForbidden());
        }
        list(manager).andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.attempts.length()").value(2))
            .andExpect(jsonPath("$.attempts[0].merchantReference").value(oldest.reference()))
            .andExpect(jsonPath("$.attempts[1].merchantReference").value(eligible.reference()))
            .andExpect(jsonPath("$.attempts[1].orderId").value(eligible.order().toString()))
            .andExpect(jsonPath("$.attempts[1].reservationExpiresAt").value(eligible.expires().toInstant().toString()))
            .andExpect(jsonPath("$.attempts[1].lastCheckedAt").value(nullValue()))
            .andExpect(jsonPath("$.attempts[1].phone").doesNotExist())
            .andExpect(jsonPath("$.attempts[1].email").doesNotExist())
            .andExpect(jsonPath("$.hasMore").value(false));
        for (Attempt ineligible : List.of(nearCutoff, active, outsideStore, declined)) {
            recheck(manager, ineligible).andExpect(status().isNotFound());
        }
        verifyNoInteractions(gateway);
    }

    @Test
    void cursorsKeepOlderPendingPagesReachableAfterThePreviousPageChanges() throws Exception {
        Store own = store();
        Attempt foreign = attempt(store(), 120);
        var history = new ArrayList<Attempt>();
        for (int hours = 100; hours >= 49; hours--) {
            history.add(attempt(own, hours));
        }
        String manager = staff(own, "manager");
        Attempt cursor = history.get(49);

        list(manager).andExpect(status().isOk()).andExpect(jsonPath("$.attempts.length()").value(50))
            .andExpect(jsonPath("$.attempts[0].merchantReference").value(history.getFirst().reference()))
            .andExpect(jsonPath("$.attempts[49].merchantReference").value(cursor.reference()))
            .andExpect(jsonPath("$.hasMore").value(true));
        when(gateway.verifyByReference(cursor.reference()))
            .thenReturn(Optional.of(evidence(cursor, TOTAL, "RWF", PaymentResult.PAID)));
        recheck(manager, cursor).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("settled"));

        list(manager, cursor.reference()).andExpect(status().isOk()).andExpect(jsonPath("$.attempts.length()").value(2))
            .andExpect(jsonPath("$.attempts[0].merchantReference").value(history.get(50).reference()))
            .andExpect(jsonPath("$.attempts[1].merchantReference").value(history.get(51).reference()))
            .andExpect(jsonPath("$.hasMore").value(false));
        for (String unknown : List.of(foreign.reference(), UUID.randomUUID().toString())) {
            list(manager, unknown).andExpect(status().isOk()).andExpect(jsonPath("$.attempts").isEmpty())
                .andExpect(jsonPath("$.hasMore").value(false));
        }
        list(manager, "not-a-reference").andExpect(status().isNotFound());
    }

    @Test
    void uncertainOrInexactEvidenceStaysPendingUntilOneVerifiedChargeRequiresARefund() throws Exception {
        Store own = store();
        Attempt target = attempt(own, 49);
        Attempt unrelated = attempt(own, 50);
        String manager = staff(own, "manager");
        String kitchen = staff(own, "kitchen");
        when(gateway.verifyByReference(target.reference()))
            .thenReturn(Optional.empty())
            .thenReturn(Optional.of(evidence(target, TOTAL, "RWF", PaymentResult.DECLINED)))
            .thenReturn(Optional.of(evidence(unrelated, TOTAL, "RWF", PaymentResult.PAID)))
            .thenReturn(Optional.of(evidence(target, TOTAL + 1, "RWF", PaymentResult.PAID)))
            .thenReturn(Optional.of(evidence(target, TOTAL, "USD", PaymentResult.PAID)))
            .thenThrow(new PaymentGatewayException(PaymentGatewayException.Kind.UNAVAILABLE))
            .thenReturn(Optional.of(evidence(target, TOTAL, "RWF", PaymentResult.PAID)));

        recheck(manager, target).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("pending"));
        assertUnsettled(target);
        recheck(manager, target).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("payment_check_cooldown"));
        jdbc.sql("UPDATE payment_attempts SET last_checked_at = now() - interval '31 seconds' WHERE id = ?")
            .param(target.id()).update();
        api.perform(get("/api/v1/orders/{id}", target.order()).header(HttpHeaders.AUTHORIZATION, guest(own)))
            .andExpect(status().isOk()).andExpect(jsonPath("$.paymentStatus").value("processing"));
        recheck(manager, target).andExpect(status().isConflict())
            .andExpect(jsonPath("$.code").value("payment_check_cooldown"));
        verify(gateway).verifyByReference(target.reference());
        makeClaimDue(target);
        recheck(manager, target).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("pending"));
        assertUnsettled(target);
        for (int i = 0; i < 3; i++) {
            makeClaimDue(target);
            recheck(manager, target).andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("payment_mismatch"));
            assertUnsettled(target);
        }
        assertUnsettled(unrelated);
        makeClaimDue(target);
        recheck(manager, target).andExpect(status().isServiceUnavailable());
        assertUnsettled(target);

        makeClaimDue(target);
        recheck(manager, target).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("settled"));
        assertThat(orderState(target)).isEqualTo("cancelled:refund_pending");
        assertThat(jdbc.sql("SELECT provider_transaction_id FROM payment_attempts WHERE id = ? AND status = 'paid'")
            .param(target.id()).query(String.class).single()).isEqualTo(PROVIDER_TRANSACTION);
        assertThat(jdbc.sql("SELECT pickup_code IS NULL FROM orders WHERE id = ?")
            .param(target.order()).query(Boolean.class).single()).isTrue();
        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, kitchen))
            .andExpect(status().isOk()).andExpect(jsonPath("$.orders").isEmpty());
        api.perform(get(OPERATOR + "/payment-exceptions").header(HttpHeaders.AUTHORIZATION, manager))
            .andExpect(status().isOk()).andExpect(jsonPath("$.exceptions.length()").value(1))
            .andExpect(jsonPath("$.exceptions[0].merchantReference").value(target.reference()))
            .andExpect(jsonPath("$.exceptions[0].providerTransactionId").value(PROVIDER_TRANSACTION))
            .andExpect(jsonPath("$.exceptions[0].reason").value("unavailable_reservation"));
        list(manager).andExpect(status().isOk()).andExpect(jsonPath("$.attempts.length()").value(1))
            .andExpect(jsonPath("$.attempts[0].merchantReference").value(unrelated.reference()));
        recheck(manager, target).andExpect(status().isNotFound());
        verify(gateway, times(7)).verifyByReference(target.reference());
    }

    @Test
    void simultaneousManagerRequestsOnlyClaimOneProviderLookup() throws Exception {
        Store own = store();
        Attempt target = attempt(own, 49);
        String manager = staff(own, "manager");
        var providerStarted = new CountDownLatch(1);
        var finishProvider = new CountDownLatch(1);
        when(gateway.verifyByReference(target.reference())).thenAnswer(call -> {
            providerStarted.countDown();
            if (!finishProvider.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Provider fixture timed out");
            return Optional.empty();
        });

        try (var requests = Executors.newFixedThreadPool(2)) {
            var first = requests.submit(() -> recheck(manager, target)
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("pending")));
            try {
                assertThat(providerStarted.await(4, TimeUnit.SECONDS)).isTrue();
                requests.submit(() -> recheck(manager, target).andExpect(status().isConflict())
                    .andExpect(jsonPath("$.code").value("payment_check_cooldown"))).get(4, TimeUnit.SECONDS);
            } finally {
                finishProvider.countDown();
            }
            first.get(4, TimeUnit.SECONDS);
        }
        verify(gateway).verifyByReference(target.reference());
        assertUnsettled(target);
    }

    @ParameterizedTest
    @ValueSource(booleans = { false, true })
    void paidEvidenceReturningAfterAWebhookIsDeduplicatedByTransaction(boolean distinctTransaction) throws Exception {
        Store own = store();
        Attempt target = attempt(own, 49);
        String manager = staff(own, "manager");
        String verifiedByManager = distinctTransaction ? "3456518" : PROVIDER_TRANSACTION;
        var providerStarted = new CountDownLatch(1);
        var finishProvider = new CountDownLatch(1);
        when(gateway.verifyByReference(target.reference())).thenAnswer(call -> {
            providerStarted.countDown();
            if (!finishProvider.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("Provider fixture timed out");
            return Optional.of(new VerifiedPayment(target.reference(), verifiedByManager, TOTAL, "RWF", PaymentResult.PAID));
        });
        when(gateway.verify(PROVIDER_TRANSACTION)).thenReturn(evidence(target, TOTAL, "RWF", PaymentResult.PAID));

        try (var requests = Executors.newFixedThreadPool(2)) {
            var first = requests.submit(() -> recheck(manager, target)
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("settled")));
            try {
                assertThat(providerStarted.await(4, TimeUnit.SECONDS)).isTrue();
                requests.submit(() -> api.perform(post("/api/v1/webhooks/flutterwave")
                        .header("verif-hash", WEBHOOK_SECRET).contentType(MediaType.APPLICATION_JSON)
                        .content("{\"event\":\"charge.completed\",\"data\":{\"id\":" + PROVIDER_TRANSACTION + "}}"))
                    .andExpect(status().isOk())).get(4, TimeUnit.SECONDS);
            } finally {
                finishProvider.countDown();
            }
            first.get(4, TimeUnit.SECONDS);
        }
        assertThat(orderState(target)).isEqualTo("cancelled:refund_pending");
        assertThat(jdbc.sql("SELECT provider_transaction_id FROM payment_attempts WHERE id = ?")
            .param(target.id()).query(String.class).single()).isEqualTo(PROVIDER_TRANSACTION);
        var exceptions = jdbc.sql("""
            SELECT provider_transaction_id || ':' || reason
            FROM payment_exceptions WHERE attempt_id = ?
            """).param(target.id()).query(String.class).list();
        String original = PROVIDER_TRANSACTION + ":unavailable_reservation";
        if (distinctTransaction) {
            assertThat(exceptions).containsExactlyInAnyOrder(original, verifiedByManager + ":duplicate_transaction");
        } else {
            assertThat(exceptions).containsExactly(original);
        }
    }

    private Store store() {
        Store store = new Store("payment-recheck-" + UUID.randomUUID(), UUID.randomUUID());
        stores.add(store);
        jdbc.sql("INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version) "
            + "VALUES (?, '{}', '{}', '{}', true, 0, 'test')").param(store.id()).update();
        jdbc.sql("INSERT INTO guest_sessions (id, expires_at) VALUES (?, now() + interval '1 hour')")
            .param(store.guest()).update();
        return store;
    }

    private String staff(Store store, String role) throws Exception {
        UUID operator = UUID.randomUUID();
        String token = fixtureToken(operator);
        jdbc.sql("""
            INSERT INTO operator_accounts (id, username, store_id, role, password_hash, mfa_encrypted_secret)
            VALUES (?, ?, ?, ?, 'fixture', ?)
            """).params(operator, "tester-" + operator, store.id(), role, OperatorMfaFixture.encryptedSeed(operator)).update();
        jdbc.sql("""
            INSERT INTO operator_sessions (token_hash, operator_id, expires_at, mfa_verified)
            VALUES (?, ?, now() + interval '15 minutes', true)
            """)
            .params(tokenHash(token), operator).update();
        return "Bearer " + token;
    }

    private String guest(Store store) throws Exception {
        String token = fixtureToken(store.guest());
        jdbc.sql("""
            INSERT INTO guest_access_tokens (token_hash, guest_session_id, expires_at)
            VALUES (?, ?, now() + interval '5 minutes')
            """).params(tokenHash(token), store.guest()).update();
        return "Bearer " + token;
    }

    private String fixtureToken(UUID id) {
        return "x" + id.toString().replace("-", "") + "testAbCdEf";
    }

    private String tokenHash(String token) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(token.getBytes(StandardCharsets.US_ASCII)));
    }

    private Attempt attempt(Store store, int hoursSinceExpiry) {
        OffsetDateTime expires = jdbc.sql("SELECT date_trunc('second', now()) - CAST(? AS integer) * interval '1 hour'")
            .param(hoursSinceExpiry).query(OffsetDateTime.class).single();
        OffsetDateTime starts = expires.plusMinutes(20);
        OffsetDateTime ends = starts.plusMinutes(10);
        OffsetDateTime created = expires.minusMinutes(10);
        var attempt = new Attempt(UUID.randomUUID(), UUID.randomUUID(), expires);
        UUID quote = UUID.randomUUID();
        String slot = attempt.order().toString();
        jdbc.sql("INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity) VALUES (?, ?, ?, ?, 1)")
            .params(store.id(), slot, starts, ends).update();
        jdbc.sql("""
            INSERT INTO quotes (id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at, lines, total, tax, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 0, ?)
            """).params(quote, store.guest(), store.id(), slot, starts, ends, TOTAL, expires).update();
        jdbc.sql("""
            INSERT INTO orders (id, quote_id, guest_session_id, request_key, store_id, slot_id, phone, email, lines, total, tax,
                status, payment_status, created_at, reservation_expires_at, pickup_starts_at, pickup_ends_at)
            VALUES (?, ?, ?, ?, ?, ?, '+250700000000', 'fixture@example.test', '[]', ?, 0, 'awaiting_payment', 'processing', ?, ?, ?, ?)
            """).params(attempt.order(), quote, store.guest(), slot, store.id(), slot, TOTAL, created, expires, starts, ends).update();
        jdbc.sql("INSERT INTO payment_attempts (id, order_id, request_key, status, initiated_at) VALUES (?, ?, ?, 'processing', ?)")
            .params(attempt.id(), attempt.order(), attempt.reference(), created).update();
        return attempt;
    }

    private ResultActions list(String authorization) throws Exception {
        return list(authorization, null);
    }

    private ResultActions list(String authorization, String after) throws Exception {
        var request = get(ATTEMPTS + "/pending");
        if (authorization != null) request.header(HttpHeaders.AUTHORIZATION, authorization);
        if (after != null) request.param("after", after);
        return api.perform(request);
    }

    private ResultActions recheck(String authorization, Attempt attempt) throws Exception {
        var request = post(ATTEMPTS + "/{reference}/recheck", attempt.reference());
        if (authorization != null) request.header(HttpHeaders.AUTHORIZATION, authorization);
        return api.perform(request);
    }

    private void makeClaimDue(Attempt attempt) {
        jdbc.sql("UPDATE payment_attempts SET last_checked_at = now() - interval '61 seconds' WHERE id = ?")
            .param(attempt.id()).update();
    }

    private void assertUnsettled(Attempt attempt) {
        assertThat(orderState(attempt)).isEqualTo("awaiting_payment:processing");
        assertThat(jdbc.sql("SELECT status FROM payment_attempts WHERE id = ? AND provider_transaction_id IS NULL")
            .param(attempt.id()).query(String.class).single()).isEqualTo("processing");
        assertThat(jdbc.sql("SELECT count(*) FROM payment_exceptions WHERE attempt_id = ?")
            .param(attempt.id()).query(Integer.class).single()).isZero();
    }

    private String orderState(Attempt attempt) {
        return jdbc.sql("SELECT status || ':' || payment_status FROM orders WHERE id = ?")
            .param(attempt.order()).query(String.class).single();
    }

    private VerifiedPayment evidence(Attempt attempt, long amount, String currency, PaymentResult result) {
        return new VerifiedPayment(attempt.reference(), PROVIDER_TRANSACTION, amount, currency, result);
    }

    private record Store(String id, UUID guest) { }

    private record Attempt(UUID id, UUID order, OffsetDateTime expires) {
        String reference() { return id.toString(); }
    }
}
