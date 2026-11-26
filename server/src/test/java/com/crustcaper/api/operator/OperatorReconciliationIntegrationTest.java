package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Arrays;
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
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Transactional
class OperatorReconciliationIntegrationTest {
    private static final String REPORT = "/api/v1/operator/reconciliation";
    private static final String KIGALI_DATE = "2024-11-08";
    private static final OffsetDateTime FROM = OffsetDateTime.parse("2024-11-07T22:00:00Z");
    private static final OffsetDateTime UNTIL = FROM.plusDays(1);
    private static final String PHONE = "+250700000000";
    private static final String EMAIL = "reconciliation-fixture@example.test";
    private static final String PICKUP_CODE = "572801";
    private static final String DOCUMENT = "%PDF-1.7\nfixture-reconciliation-document\n%%EOF\n";
    private static final String PRIMARY_TRANSACTION = "9007199254740991999";
    private static final String PRIMARY_REFUND = "9007199254740991881";
    private static final String DUPLICATE_TRANSACTION = "8057312";
    private static final String LATE_TRANSACTION = "8057313";
    private static final String RECEIPT = "EBM-fixture-2024-01";
    private static final String HEADER = "event_type,recorded_at,order_id,merchant_reference,provider_transaction_id,"
            + "provider_refund_id,receipt_reference,amount_rwf,currency,reason,review_state";

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;

    @Test
    void kigaliDayReconcilesIndependentEventsAndExportsExactReferencesWithoutContacts() throws Exception {
        String own = store();
        Staff manager = staff(own, "manager");
        Fixture acceptedAndRefunded = order(own, 9700, "cancelled", "refunded", FROM, PRIMARY_TRANSACTION);
        Fixture stillPaid = order(own, 2147483647L, "ready", "paid", FROM.plusHours(2), "8057314");
        Fixture late = order(own, 11400, "cancelled", "refunded", null, LATE_TRANSACTION);
        exception(acceptedAndRefunded, PRIMARY_TRANSACTION, "restaurant_cancelled", FROM.plusHours(1));
        exception(acceptedAndRefunded, DUPLICATE_TRANSACTION, "duplicate_transaction", FROM.plusHours(3));
        exception(late, LATE_TRANSACTION, "unavailable_reservation", FROM.plusHours(5));
        refund(acceptedAndRefunded, manager, PRIMARY_TRANSACTION, PRIMARY_REFUND, FROM.plusHours(4));
        refund(late, manager, LATE_TRANSACTION, "8479013", UNTIL);
        receipt(acceptedAndRefunded, manager, RECEIPT, FROM.plusHours(6));
        Fixture undated = order(own, 3333, "collected", "paid", null, "8057319");
        Fixture previousDay = order(own, 12100, "accepted", "paid", FROM.minusNanos(1000), "8057317");
        Fixture nextDay = order(own, 8300, "accepted", "paid", UNTIL, "8057318");

        String foreignStore = store();
        Staff foreignManager = staff(foreignStore, "manager");
        Fixture foreign = order(foreignStore, 5600, "cancelled", "refunded", FROM, "8057330");
        exception(foreign, "8057330", "restaurant_cancelled", FROM.plusHours(1));
        exception(foreign, "8057331", "duplicate_transaction", FROM.plusHours(2));
        refund(foreign, foreignManager, "8057330", "8479030", FROM.plusHours(3));
        receipt(foreign, foreignManager, "EBM-foreign-fixture", FROM.plusHours(4));

        byte[] snapshot = report(REPORT, manager.authorization(), KIGALI_DATE).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.date").value(KIGALI_DATE))
            .andExpect(jsonPath("$.timeZone").value("Africa/Kigali"))
            .andExpect(jsonPath("$.currency").value("RWF"))
            .andExpect(jsonPath("$.from").value(FROM.toInstant().toString()))
            .andExpect(jsonPath("$.until").value(UNTIL.toInstant().toString()))
            .andReturn().getResponse().getContentAsByteArray();
        JsonNode report = json.readTree(snapshot);
        assertThat(Instant.parse(report.path("asOf").asString())).isAfter(UNTIL.toInstant());
        assertBucket(report, "acceptedPayments", 2, "2147493347");
        assertBucket(report, "exceptionPayments", 2, "21100");
        assertBucket(report, "verifiedRefunds", 1, "9700");
        assertBucket(report, "attachedReceipts", 1, "9700");
        assertBucket(report, "unattachedReceipts", 1, "2147483647");
        assertBucket(report, "openExceptions", 1, "9700");
        assertBucket(report, "undatedAcceptedPayments", 1, "3333");

        String csv = report(REPORT + "/export", manager.authorization(), KIGALI_DATE).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(header().string(HttpHeaders.CONTENT_TYPE, startsWith("text/csv")))
            .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION, startsWith("attachment;")))
            .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION, containsString("crustcaper-reconciliation-2024-11-08.csv")))
            .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(csv).startsWith(HEADER + "\r\n");
        assertThat(csv.replace("\r\n", "")).doesNotContain("\r", "\n");
        assertThat(csv).doesNotContain(PHONE, EMAIL, PICKUP_CODE, DOCUMENT, undated.id().toString(),
            previousDay.id().toString(), nextDay.id().toString(), foreign.id().toString(), "EBM-foreign-fixture");
        List<List<String>> events = csv.lines().skip(1).map(OperatorReconciliationIntegrationTest::splitFields).toList();
        assertThat(events).allSatisfy(row -> assertThat(row).hasSize(11));
        assertThat(events.stream().map(row -> row.get(0)).toList()).containsExactly(
            "accepted_payment", "restaurant_cancellation", "accepted_payment", "exception_payment",
            "verified_refund", "exception_payment", "attached_receipt"
        );
        assertThat(events.get(0)).containsExactly("accepted_payment", FROM.toInstant().toString(),
            acceptedAndRefunded.id().toString(), acceptedAndRefunded.attempt().toString(), PRIMARY_TRANSACTION,
            "", "", "9700", "RWF", "", "");
        assertThat(events.get(1)).contains(PRIMARY_TRANSACTION, PRIMARY_REFUND, "restaurant_cancelled", "verified");
        assertThat(events.get(2)).contains(stillPaid.id().toString(), "2147483647");
        assertThat(events.get(3)).contains(acceptedAndRefunded.attempt().toString(), DUPLICATE_TRANSACTION,
            "duplicate_transaction", "open");
        assertThat(events.get(4)).contains(PRIMARY_TRANSACTION, PRIMARY_REFUND, "9700");
        assertThat(events.get(5)).contains(late.attempt().toString(), LATE_TRANSACTION, "8479013", "unavailable_reservation", "verified");
        assertThat(events.get(6)).contains(acceptedAndRefunded.id().toString(), RECEIPT, "9700");
    }

    @Test
    void onlyManagersCanReadOrExportAndBothRoutesRejectInvalidDates() throws Exception {
        String own = store();
        Staff manager = staff(own, "manager");
        Staff kitchen = staff(own, "kitchen");
        Staff pickup = staff(own, "pickup");
        for (String endpoint : List.of(REPORT, REPORT + "/export")) {
            report(endpoint, null, KIGALI_DATE).andExpect(status().isUnauthorized());
            report(endpoint, kitchen.authorization(), KIGALI_DATE).andExpect(status().isForbidden());
            report(endpoint, pickup.authorization(), KIGALI_DATE).andExpect(status().isForbidden());
            for (String invalid : List.of("", "2024-2-01", "2025-02-29", "2024-11-08T00:00:00Z", "../2024-11-08")) {
                report(endpoint, manager.authorization(), invalid).andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.code").value("invalid_input"));
            }
            report(endpoint, manager.authorization(), null).andExpect(status().isBadRequest());
        }
    }

    private static void assertBucket(JsonNode report, String name, int count, String amount) {
        JsonNode bucket = report.path(name);
        assertThat(bucket.path("count").asInt(-1)).as(name + " count").isEqualTo(count);
        assertThat(bucket.path("amountRwf").isString()).as(name + " amount is decimal text").isTrue();
        assertThat(bucket.path("amountRwf").asString()).as(name + " amount").isEqualTo(amount);
    }

    private static List<String> splitFields(String line) {
        return Arrays.stream(line.split(",", -1)).map(field -> field.startsWith("\"") && field.endsWith("\"")
            ? field.substring(1, field.length() - 1).replace("\"\"", "\"") : field).toList();
    }

    private ResultActions report(String endpoint, String authorization, String date) throws Exception {
        var request = get(endpoint);
        if (authorization != null) request.header(HttpHeaders.AUTHORIZATION, authorization);
        if (date != null) request.param("date", date);
        return api.perform(request);
    }

    private String store() {
        String id = "reconciliation-" + UUID.randomUUID();
        jdbc.sql("INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version) VALUES (?, '{}', '{}', '{}', true, 0, 'test')")
            .param(id).update();
        jdbc.sql("INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity) VALUES (?, 'slot', ?, ?, 20)")
            .params(id, FROM.plusHours(10), FROM.plusHours(11)).update();
        return id;
    }

    private Staff staff(String store, String role) throws Exception {
        UUID id = UUID.randomUUID();
        String username = "tester-" + id;
        String token = "x" + UUID.randomUUID().toString().replace("-", "") + "testAbCdEf";
        String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.US_ASCII)));
        jdbc.sql("INSERT INTO operator_accounts (id, store_id, username, role, password_hash) VALUES (?, ?, ?, ?, 'fixture')")
            .params(id, store, username, role).update();
        jdbc.sql("INSERT INTO operator_sessions (token_hash, operator_id, expires_at) VALUES (?, ?, now() + interval '10 minutes')")
            .params(hash, id).update();
        return new Staff(id, username, "Bearer " + token);
    }

    private Fixture order(String store, long total, String status, String paymentStatus, OffsetDateTime acceptedAt, String transaction) {
        UUID guest = UUID.randomUUID();
        UUID quote = UUID.randomUUID();
        UUID order = UUID.randomUUID();
        UUID attempt = UUID.randomUUID();
        OffsetDateTime start = FROM.plusHours(10);
        OffsetDateTime end = FROM.plusHours(11);
        jdbc.sql("INSERT INTO guest_sessions (id, expires_at) VALUES (?, now() + interval '1 hour')").param(guest).update();
        jdbc.sql("""
            INSERT INTO quotes (id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at, lines, total, tax, expires_at)
            VALUES (?, ?, ?, 'slot', ?, ?, '[]', ?, 0, ?)
            """).params(quote, guest, store, start, end, total, FROM.minusHours(1)).update();
        jdbc.sql("""
            INSERT INTO orders (id, quote_id, guest_session_id, request_key, store_id, slot_id, phone, email, lines, total, tax,
                status, payment_status, pickup_code, created_at, reservation_expires_at, pickup_starts_at, pickup_ends_at, accepted_at)
            VALUES (?, ?, ?, ?, ?, 'slot', ?, ?, '[]', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
            """).params(order, quote, guest, order.toString(), store, PHONE, EMAIL, total, status, paymentStatus, PICKUP_CODE,
                    FROM.minusDays(2), FROM.plusHours(1), start, end, acceptedAt).update();
        jdbc.sql("""
            INSERT INTO payment_attempts (id, order_id, request_key, status, provider_transaction_id, initiated_at)
            VALUES (?, ?, ?, 'paid', ?, ?)
            """).params(attempt, order, attempt.toString(), transaction, FROM.minusDays(2)).update();
        return new Fixture(order, attempt, store, total);
    }

    private void exception(Fixture order, String transaction, String reason, OffsetDateTime at) {
        jdbc.sql("""
            INSERT INTO payment_exceptions (attempt_id, provider_transaction_id, reason, created_at) VALUES (?, ?, ?, ?)
            """).params(order.attempt(), transaction, reason, at).update();
    }

    private void refund(Fixture order, Staff manager, String transaction, String id, OffsetDateTime at) {
        jdbc.sql("""
            INSERT INTO verified_refunds (provider_refund_id, attempt_id, provider_transaction_id, amount, currency, refund_status,
                store_id, operator_id, operator_username, cleared_order_payment, recorded_at)
            VALUES (?, ?, ?, ?, 'RWF', 'completed-momo', ?, ?, ?, true, ?)
            """).params(id, order.attempt(), transaction, order.total(), order.store(), manager.id(), manager.username(), at).update();
    }

    private void receipt(Fixture order, Staff manager, String reference, OffsetDateTime at) {
        jdbc.sql("""
            INSERT INTO fiscal_receipts (order_id, store_id, reference, total_rwf, document, attached_by, attached_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """).params(order.id(), order.store(), reference, order.total(), DOCUMENT.getBytes(StandardCharsets.UTF_8),
                manager.id(), at).update();
        jdbc.sql("UPDATE orders SET receipt_status = 'issued' WHERE id = ?").param(order.id()).update();
    }

    private record Staff(UUID id, String username, String authorization) { }

    private record Fixture(UUID id, UUID attempt, String store, long total) { }
}
