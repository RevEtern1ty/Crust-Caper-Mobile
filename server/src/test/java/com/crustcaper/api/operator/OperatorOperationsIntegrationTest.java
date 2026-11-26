package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.OrderService;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Transactional
class OperatorOperationsIntegrationTest {
    private static final String SIGNALS = "/api/v1/operator/operations/signals";
    private static final String QUEUE = "/api/v1/operator/orders";
    private static final long TOTAL = 7900;

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OrderService orders;

    @Test
    void onlyManagersCanReadSignalsAndEachManagerSeesTheirOwnStore() throws Exception {
        Store own = store();
        Staff manager = staff(own, "manager");
        Store foreign = store();
        Staff foreignManager = staff(foreign, "manager");
        Staff kitchen = staff(own, "kitchen");
        Staff pickup = staff(own, "pickup");

        api.perform(get(SIGNALS)).andExpect(status().isUnauthorized())
            .andExpect(header().string(HttpHeaders.WWW_AUTHENTICATE, "Bearer"))
            .andExpect(jsonPath("$.code").value("unauthenticated"));
        for (Staff denied : List.of(kitchen, pickup)) {
            api.perform(get(SIGNALS).header(HttpHeaders.AUTHORIZATION, denied.authorization()))
                .andExpect(status().isForbidden());
        }

        OffsetDateTime now = databaseClock();
        paidAttempt(order(foreign, "awaiting_payment", "processing", "pending"), now.minusMinutes(2));
        collection(order(foreign, "collected", "paid", "pending"), foreignManager, "changed", now.minusHours(1));
        signals(manager, 0, 0);
        signals(foreignManager, 1, 1);
    }

    @Test
    void verifiedPaymentSignalCountsDistinctUnroutedOrdersAfterSixtySeconds() throws Exception {
        Store store = store();
        Staff manager = staff(store, "manager");
        OffsetDateTime now = databaseClock();
        OffsetDateTime old = now.minusMinutes(2);
        UUID multipleAttempts = order(store, "awaiting_payment", "processing", "pending");
        paidAttempt(multipleAttempts, old);
        paidAttempt(multipleAttempts, old);
        Attempt orphan = paidAttempt(order(store, "awaiting_payment", "paid", "pending"), old);
        exception(orphan.id(), "test-duplicate-" + UUID.randomUUID(), "duplicate_transaction");

        for (String status : List.of("accepted", "preparing", "ready", "collected")) {
            paidAttempt(order(store, status, "paid", "pending"), old);
        }
        paidAttempt(order(store, "cancelled", "refund_pending", "pending"), old);
        paidAttempt(order(store, "cancelled", "refunded", "pending"), old);
        Attempt late = paidAttempt(order(store, "awaiting_payment", "processing", "pending"), old);
        exception(late.id(), late.transaction(), "unavailable_reservation");
        Attempt superseded = paidAttempt(order(store, "awaiting_payment", "processing", "pending"), old);
        exception(superseded.id(), superseded.transaction(), "superseded_attempt");
        paidAttempt(order(store, "awaiting_payment", "processing", "pending"), null);
        attempt(order(store, "awaiting_payment", "processing", "pending"), "processing", null, null);
        signals(manager, 2, 0);

        Attempt justInside = paidAttempt(order(store, "awaiting_payment", "processing", "pending"), null);
        Attempt justOutside = paidAttempt(order(store, "awaiting_payment", "processing", "pending"), null);
        jdbc.sql("""
            UPDATE payment_attempts SET verified_at = statement_timestamp() - CASE
                WHEN id = ? THEN interval '59 seconds' ELSE interval '61 seconds' END
            WHERE id IN (?, ?)
            """).params(justInside.id(), justInside.id(), justOutside.id()).update();
        signals(manager, 3, 0);
    }

    @Test
    void receiptSignalUsesSuccessfulCollectionTimeAndExcludesOrdersWithAnAttachedDocument() throws Exception {
        Store store = store();
        Staff manager = staff(store, "manager");
        OffsetDateTime old = databaseClock().minusHours(1);
        collection(order(store, "collected", "paid", "pending"), manager, "changed", old);
        collection(order(store, "collected", "refunded", "pending"), manager, "changed", old);
        collection(order(store, "collected", "paid", "corrected"), manager, "changed", old);
        collection(order(store, "collected", "paid", "pending"), manager, "pickup_code_mismatch", old);
        order(store, "collected", "paid", "pending");
        order(store, "ready", "paid", "pending");
        UUID attached = order(store, "collected", "paid", "pending");
        collection(attached, manager, "changed", old);
        jdbc.sql("""
            INSERT INTO fiscal_receipts (order_id, store_id, reference, total_rwf, document, attached_by)
            VALUES (?, ?, 'fixture-r43-receipt', ?, ?, ?)
            """).params(attached, store.id(), TOTAL, "%PDF-1.7\nfixture operations receipt\n%%EOF".getBytes(StandardCharsets.US_ASCII),
                manager.id()).update();
        externalCollection(store, manager, old);
        signals(manager, 0, 1);

        UUID justInside = order(store, "collected", "paid", "pending");
        UUID justOutside = order(store, "collected", "paid", "pending");
        collection(justInside, manager, "changed", old);
        collection(justOutside, manager, "changed", old);
        jdbc.sql("""
            UPDATE operator_order_events SET occurred_at = statement_timestamp() - CASE
                WHEN order_id = ? THEN interval '29 minutes 59 seconds' ELSE interval '30 minutes 1 second' END
            WHERE order_id IN (?, ?)
            """).params(justInside, justInside, justOutside).update();
        signals(manager, 0, 2);
    }

    @Test
    void firstRealSettlementPersistsVerificationTimeAndAppearsOnKitchenQueue() throws Exception {
        Store store = store();
        Staff manager = staff(store, "manager");
        Staff kitchen = staff(store, "kitchen");
        UUID order = order(store, "awaiting_payment", "processing", "pending");
        Attempt pending = attempt(order, "processing", null, null);
        VerifiedPayment payment = new VerifiedPayment(pending.id().toString(), "test-paid-" + UUID.randomUUID(),
            TOTAL, "RWF", PaymentResult.PAID);
        OffsetDateTime before = databaseClock();

        orders.settlePayment(payment);
        OffsetDateTime verifiedAt = verifiedAt(pending);
        assertThat(verifiedAt).isBetween(before, databaseClock());
        orders.settlePayment(payment);
        assertThat(verifiedAt(pending)).isEqualTo(verifiedAt);
        api.perform(get(QUEUE).header(HttpHeaders.AUTHORIZATION, kitchen.authorization()))
            .andExpect(status().isOk()).andExpect(jsonPath("$.orders.length()").value(1))
            .andExpect(jsonPath("$.orders[0].id").value(order.toString()))
            .andExpect(jsonPath("$.orders[0].status").value("accepted"))
            .andExpect(jsonPath("$.orders[0].paymentStatus").value("paid"));
        signals(manager, 0, 0);
    }

    private void signals(Staff manager, int payments, int receipts) throws Exception {
        byte[] body = api.perform(get(SIGNALS).header(HttpHeaders.AUTHORIZATION, manager.authorization()))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.paymentWithoutKitchen").value(payments))
            .andExpect(jsonPath("$.fiscalReceiptsOverdue").value(receipts))
            .andExpect(jsonPath("$.fiscalReceiptOverdueAfterMinutes").value(30))
            .andReturn().getResponse().getContentAsByteArray();
        JsonNode payload = json.readTree(body);
        assertThat(payload.propertyNames()).containsExactlyInAnyOrder("observedAt", "paymentWithoutKitchen",
            "fiscalReceiptsOverdue", "fiscalReceiptOverdueAfterMinutes");
        assertThat(Instant.parse(payload.path("observedAt").asString())).isBeforeOrEqualTo(databaseClock().toInstant());
    }

    private OffsetDateTime databaseClock() {
        return jdbc.sql("SELECT statement_timestamp()").query(OffsetDateTime.class).single();
    }

    private Store store() {
        String id = "operations-" + UUID.randomUUID();
        OffsetDateTime starts = databaseClock().plusHours(2);
        OffsetDateTime ends = starts.plusMinutes(10);
        jdbc.sql("INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version) VALUES (?, '{}', '{}', '{}', true, 0, 'test')")
            .param(id).update();
        jdbc.sql("INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity) VALUES (?, 'slot', ?, ?, 80)")
            .params(id, starts, ends).update();
        return new Store(id, starts, ends);
    }

    private Staff staff(Store store, String role) throws Exception {
        UUID id = UUID.randomUUID();
        String token = "x" + UUID.randomUUID().toString().replace("-", "") + "testAbCdEf";
        String tokenHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.US_ASCII)));
        jdbc.sql("INSERT INTO operator_accounts (id, store_id, username, role, password_hash) VALUES (?, ?, ?, ?, 'fixture')")
            .params(id, store.id(), "tester-" + id, role).update();
        jdbc.sql("INSERT INTO operator_sessions (token_hash, operator_id, expires_at) VALUES (?, ?, now() + interval '10 minutes')")
            .params(tokenHash, id).update();
        return new Staff(id, "Bearer " + token);
    }

    private UUID order(Store store, String status, String paymentStatus, String receiptStatus) {
        UUID guest = UUID.randomUUID();
        UUID quote = UUID.randomUUID();
        UUID order = UUID.randomUUID();
        jdbc.sql("INSERT INTO guest_sessions (id, expires_at) VALUES (?, now() + interval '1 hour')").param(guest).update();
        jdbc.sql("""
            INSERT INTO quotes (id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at, lines, total, tax, expires_at)
            VALUES (?, ?, ?, 'slot', ?, ?, '[]', ?, 0, now() + interval '1 hour')
            """).params(quote, guest, store.id(), store.starts(), store.ends(), TOTAL).update();
        jdbc.sql("""
            INSERT INTO orders (id, quote_id, guest_session_id, request_key, store_id, slot_id, phone, email, lines,
                total, tax, status, payment_status, receipt_status, created_at, reservation_expires_at, pickup_starts_at, pickup_ends_at)
            VALUES (?, ?, ?, ?, ?, 'slot', '+250700000000', 'operations@example.test', '[]', ?, 0, ?, ?, ?,
                now() - interval '2 hours', now() + interval '1 hour', ?, ?)
            """).params(order, quote, guest, order.toString(), store.id(), TOTAL, status, paymentStatus, receiptStatus,
                store.starts(), store.ends()).update();
        return order;
    }

    private Attempt paidAttempt(UUID order, OffsetDateTime verifiedAt) {
        return attempt(order, "paid", "test-paid-" + UUID.randomUUID(), verifiedAt);
    }

    private Attempt attempt(UUID order, String status, String transaction, OffsetDateTime verifiedAt) {
        UUID attempt = UUID.randomUUID();
        jdbc.sql("""
            INSERT INTO payment_attempts (id, order_id, request_key, status, provider_transaction_id, initiated_at, verified_at)
            VALUES (?, ?, ?, ?, ?, now() - interval '2 hours', ?)
            """).params(attempt, order, attempt.toString(), status, transaction, verifiedAt).update();
        return new Attempt(attempt, transaction);
    }

    private OffsetDateTime verifiedAt(Attempt attempt) {
        return jdbc.sql("SELECT verified_at FROM payment_attempts WHERE id = ?").param(attempt.id())
            .query(OffsetDateTime.class).single();
    }

    private void exception(UUID attempt, String transaction, String reason) {
        jdbc.sql("""
            INSERT INTO payment_exceptions (attempt_id, provider_transaction_id, reason, created_at) VALUES (?, ?, ?, now())
            """).params(attempt, transaction, reason).update();
    }

    private void collection(UUID order, Staff manager, String outcome, OffsetDateTime occurredAt) {
        jdbc.sql("""
            INSERT INTO operator_order_events (order_id, store_id, operator_id, operator_role, previous_status, requested_status,
                outcome, occurred_at)
            SELECT id, store_id, ?, 'manager', 'ready', 'collected', ?, ? FROM orders WHERE id = ?
            """).params(manager.id(), outcome, occurredAt, order).update();
    }

    private void externalCollection(Store store, Staff manager, OffsetDateTime occurredAt) {
        UUID id = UUID.randomUUID();
        jdbc.sql("INSERT INTO operator_external_order_channels (store_id, id, label) VALUES (?, 'fixture', 'Fixture delivery')")
            .param(store.id()).update();
        jdbc.sql("""
            INSERT INTO operator_external_orders (id, store_id, channel, channel_label, external_reference,
                scheduled_at, lines, registered_by, accepted_at, status)
            VALUES (?, ?, 'fixture', 'Fixture delivery', 'OPS-R43-EXTERNAL', ?, CAST(? AS jsonb), ?, ?, 'collected')
            """).params(id, store.id(), occurredAt, "[{\"name\":\"Fixture meal\",\"quantity\":1,\"modifiers\":[]}]",
                manager.id(), occurredAt.minusMinutes(10)).update();
        jdbc.sql("""
            INSERT INTO operator_external_order_events (order_id, operator_id, operator_role, previous_status, requested_status, occurred_at)
            VALUES (?, ?, 'manager', 'ready', 'collected', ?)
            """).params(id, manager.id(), occurredAt).update();
    }

    private record Store(String id, OffsetDateTime starts, OffsetDateTime ends) { }
    private record Staff(UUID id, String authorization) { }
    private record Attempt(UUID id, String transaction) { }
}
