package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.hamcrest.Matchers.nullValue;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.crustcaper.api.OrderService;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import com.crustcaper.api.payment.PaymentGatewayException;
import com.crustcaper.api.payment.RefundDirectory;
import com.crustcaper.api.payment.RefundDirectory.ConfirmedRefund;
import com.crustcaper.api.payment.RefundDirectory.RefundRequest;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("local")
@Transactional
class OperatorRefundIntegrationTest {
    private static final String OPERATOR = "/api/v1/operator";
    private static final String REVIEW = OPERATOR + "/payment-exceptions";
    private static final String PASSWORD = "synthetic-refund-manager-fixture";
    private static final String PASSWORD_HASH = OperatorPasswordHash.hash(PASSWORD.toCharArray());
    private static final String SLOT = "refund-test-slot";
    private static final long TOTAL = 9700;
    private static final String LATE_TRANSACTION = "6543321";
    private static final String PAID_TRANSACTION = "6543322";
    private static final String DUPLICATE_TRANSACTION = "6543323";
    private static final String SUPERSEDED_TRANSACTION = "6543324";
    private static final String LATE_REFUND = "7654431";
    private static final String DUPLICATE_REFUND = "7654432";
    private static final String SUPERSEDED_REFUND = "7654433";
    private static final String CANCELLATION_REFUND = "7654434";

    @Autowired MockMvc api;
    @Autowired JdbcClient jdbc;
    @Autowired ObjectMapper json;
    @Autowired OrderService payments;
    @MockitoBean RefundDirectory directory;

    private String store;

    @BeforeEach
    void createFixtureStore() {
        store = newStore();
    }

    @Test
    void openRefundReviewReachesOldAndTiedExceptionsEvenAfterTheCursorIsRefunded() throws Exception {
        var order = newOrder(true);
        settle(order.attemptId(), LATE_TRANSACTION);
        jdbc.sql("UPDATE payment_exceptions SET created_at = now() - interval '1 day' WHERE attempt_id = ?")
            .param(order.attemptId()).update();
        jdbc.sql("""
            INSERT INTO payment_exceptions (attempt_id, provider_transaction_id, reason, created_at)
            SELECT ?, (8000000 + number)::text, 'duplicate_transaction', date_trunc('second', now())
            FROM generate_series(1, 52) AS series(number)
            """).param(order.attemptId()).update();
        String manager = login(staff(store, "manager"));
        String foreignManager = login(staff(newStore(), "manager"));
        String kitchen = login(staff(store, "kitchen"));

        review(null, "open", null).andExpect(status().isUnauthorized());
        review(kitchen, "open", null).andExpect(status().isForbidden());
        var legacy = body(review(manager, null, null).andExpect(status().isOk()));
        assertThat(legacy.propertyNames()).containsExactly("exceptions");
        assertThat(legacy.path("exceptions").size()).isEqualTo(50);
        assertThat(legacy.path("exceptions").get(0).path("providerTransactionId").asString()).isEqualTo("8000052");
        for (JsonNode entry : legacy.path("exceptions")) {
            assertThat(entry.path("providerTransactionId").asString()).isNotEqualTo(LATE_TRANSACTION);
        }
        var first = body(review(manager, "open", null).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.exceptions.length()").value(50)));
        assertThat(first.path("exceptions").get(0).path("providerTransactionId").asString()).isEqualTo(LATE_TRANSACTION);
        assertThat(first.path("exceptions").get(49).path("providerTransactionId").asString()).isEqualTo("8000049");
        String after = first.path("nextCursor").asString("");
        assertThat(after).matches("[A-Za-z0-9_-]+");
        review(foreignManager, "open", after).andExpect(status().isOk())
            .andExpect(jsonPath("$.exceptions").isEmpty()).andExpect(jsonPath("$.nextCursor").value(nullValue()));
        review(manager, "verified", after).andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("invalid_input"));
        review(manager, "open", "malformed!").andExpect(status().isBadRequest());
        review(manager, "invalid", null).andExpect(status().isBadRequest());
        review(manager, null, after).andExpect(status().isBadRequest());
        verifyNoInteractions(directory);

        confirm(DUPLICATE_REFUND, "8000049");
        record(manager, order.attemptId(), "8000049", DUPLICATE_REFUND).andExpect(status().isOk());
        assertThat(orderState(order.id())).isEqualTo("cancelled:refund_pending");
        confirm(LATE_REFUND, LATE_TRANSACTION);
        record(manager, order.attemptId(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isOk());
        assertThat(orderState(order.id())).isEqualTo("cancelled:refunded");
        review(manager, "verified", null).andExpect(status().isOk())
            .andExpect(jsonPath("$.exceptions.length()").value(2))
            .andExpect(jsonPath("$.exceptions[0].providerTransactionId").value("8000049"))
            .andExpect(jsonPath("$.exceptions[0].refund.providerRefundId").value(DUPLICATE_REFUND))
            .andExpect(jsonPath("$.exceptions[1].providerTransactionId").value(LATE_TRANSACTION))
            .andExpect(jsonPath("$.nextCursor").value(nullValue()));
        review(manager, "open", after).andExpect(status().isOk())
            .andExpect(jsonPath("$.exceptions.length()").value(3))
            .andExpect(jsonPath("$.exceptions[0].providerTransactionId").value("8000050"))
            .andExpect(jsonPath("$.exceptions[1].providerTransactionId").value("8000051"))
            .andExpect(jsonPath("$.exceptions[2].providerTransactionId").value("8000052"))
            .andExpect(jsonPath("$.exceptions[0].refund").doesNotExist())
            .andExpect(jsonPath("$.nextCursor").value(nullValue()));
    }

    @Test
    void localModeNeverOffersManualProviderVerification() throws Exception {
        var order = newOrder(true);
        jdbc.sql("UPDATE orders SET reservation_expires_at = now() - interval '49 hours' WHERE id = ?")
            .param(order.id()).update();
        String manager = login(staff(store, "manager"));
        String attempts = OPERATOR + "/payment-attempts";
        api.perform(get(attempts + "/pending").header(HttpHeaders.AUTHORIZATION, manager))
            .andExpect(status().isOk()).andExpect(jsonPath("$.attempts").isEmpty()).andExpect(jsonPath("$.hasMore").value(false));
        api.perform(post(attempts + "/{reference}/recheck", order.attemptId()).header(HttpHeaders.AUTHORIZATION, manager))
            .andExpect(status().isNotFound());
        assertThat(orderState(order.id())).isEqualTo("awaiting_payment:processing");
    }

    @Test
    void onlyTheOriginalLateChargeClosesRefundPendingAndTheSameRefundReplaysWithoutNewLookup() throws Exception {
        OrderFixture order = newOrder(true);
        settle(order.attemptId(), LATE_TRANSACTION);
        settle(order.attemptId(), DUPLICATE_TRANSACTION);
        Staff manager = staff(store, "manager");
        String bearer = login(manager);
        RefundRequest duplicate = confirm(DUPLICATE_REFUND, DUPLICATE_TRANSACTION);
        RefundRequest late = confirm(LATE_REFUND, LATE_TRANSACTION);

        record(bearer, order.attemptId(), DUPLICATE_TRANSACTION, DUPLICATE_REFUND).andExpect(status().isOk());
        assertThat(orderState(order.id())).isEqualTo("cancelled:refund_pending");

        byte[] first = record(bearer, order.attemptId(), LATE_TRANSACTION, LATE_REFUND)
                .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(jsonPath("$.providerRefundId").value(LATE_REFUND))
                .andExpect(jsonPath("$.refundStatus").value("completed-momo"))
                .andExpect(jsonPath("$.amount").value(TOTAL)).andExpect(jsonPath("$.currency").value("RWF"))
                .andExpect(jsonPath("$.recordedAt").isString()).andReturn().getResponse().getContentAsByteArray();
        assertThat(orderState(order.id())).isEqualTo("cancelled:refunded");

        byte[] retry = record(bearer, order.attemptId(), LATE_TRANSACTION, LATE_REFUND)
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray();
        assertThat(retry).isEqualTo(first);
        record(bearer, order.attemptId(), LATE_TRANSACTION, SUPERSEDED_REFUND).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("refund_already_recorded"));
        verify(directory).confirm(duplicate);
        verify(directory).confirm(late);
        verifyNoMoreInteractions(directory);

        assertThat(jdbc.sql("""
                SELECT provider_refund_id || ':' || operator_username || ':' || cleared_order_payment::text
                FROM verified_refunds WHERE operator_id = ? ORDER BY provider_refund_id
                """).param(manager.id()).query(String.class).list())
                .containsExactly(LATE_REFUND + ":" + manager.username() + ":true",
                        DUPLICATE_REFUND + ":" + manager.username() + ":false");
        var review = json.readTree(api.perform(get(REVIEW).header(HttpHeaders.AUTHORIZATION, bearer))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsByteArray());
        assertThat(review.path("exceptions").size()).isEqualTo(2);
        assertThat(review.path("exceptions").get(0).path("refund").propertyNames()).containsExactlyInAnyOrder(
                "providerRefundId", "refundStatus", "amount", "currency", "recordedAt");
    }

    @Test
    void refundOfDuplicateOrSupersededChargeLeavesThePaidKitchenOrderIntact() throws Exception {
        OrderFixture order = newOrder(false);
        UUID current = addAttempt(order.id());
        settle(order.attemptId(), SUPERSEDED_TRANSACTION);
        settle(current, PAID_TRANSACTION);
        settle(current, DUPLICATE_TRANSACTION);
        String manager = login(staff(store, "manager"));
        String kitchen = login(staff(store, "kitchen"));
        confirm(SUPERSEDED_REFUND, SUPERSEDED_TRANSACTION);
        confirm(DUPLICATE_REFUND, DUPLICATE_TRANSACTION);

        record(manager, order.attemptId(), SUPERSEDED_TRANSACTION, SUPERSEDED_REFUND).andExpect(status().isOk());
        record(manager, current, DUPLICATE_TRANSACTION, DUPLICATE_REFUND).andExpect(status().isOk());

        assertThat(orderState(order.id())).isEqualTo("accepted:paid");
        assertThat(jdbc.sql("SELECT pickup_code FROM orders WHERE id = ?").param(order.id()).query(String.class).single())
                .matches("[0-9]{6}");
        api.perform(get(OPERATOR + "/orders").header(HttpHeaders.AUTHORIZATION, kitchen)).andExpect(status().isOk())
                .andExpect(jsonPath("$.orders[0].id").value(order.id().toString()));
        assertThat(jdbc.sql("SELECT count(*) FROM verified_refunds WHERE store_id = ? AND NOT cleared_order_payment")
                .param(store).query(Long.class).single()).isEqualTo(2);
    }

    @Test
    void managerCancellationClosesOnlyAfterTheOriginalPaidChargeIsRefunded() throws Exception {
        OrderFixture order = newOrder(false);
        settle(order.attemptId(), PAID_TRANSACTION);
        String manager = login(staff(store, "manager"));

        api.perform(post(OPERATOR + "/orders/{id}/cancel", order.id()).header(HttpHeaders.AUTHORIZATION, manager))
                .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(jsonPath("$.status").value("cancelled"))
                .andExpect(jsonPath("$.paymentStatus").value("refund_pending"));
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ? AND provider_transaction_id = ?")
                .params(order.attemptId(), PAID_TRANSACTION).query(String.class).single()).isEqualTo("restaurant_cancelled");
        verifyNoInteractions(directory);

        settle(order.attemptId(), DUPLICATE_TRANSACTION);
        RefundRequest duplicate = confirm(DUPLICATE_REFUND, DUPLICATE_TRANSACTION);
        RefundRequest original = confirm(CANCELLATION_REFUND, PAID_TRANSACTION);
        record(manager, order.attemptId(), DUPLICATE_TRANSACTION, DUPLICATE_REFUND).andExpect(status().isOk());
        assertThat(orderState(order.id())).isEqualTo("cancelled:refund_pending");

        record(manager, order.attemptId(), PAID_TRANSACTION, CANCELLATION_REFUND).andExpect(status().isOk())
                .andExpect(jsonPath("$.providerRefundId").value(CANCELLATION_REFUND));
        assertThat(orderState(order.id())).isEqualTo("cancelled:refunded");
        api.perform(post(OPERATOR + "/orders/{id}/cancel", order.id()).header(HttpHeaders.AUTHORIZATION, manager))
                .andExpect(status().isOk()).andExpect(jsonPath("$.status").value("cancelled"))
                .andExpect(jsonPath("$.paymentStatus").value("refunded"));
        assertThat(jdbc.sql("""
                SELECT provider_refund_id FROM verified_refunds WHERE attempt_id = ? AND cleared_order_payment
                """).param(order.attemptId()).query(String.class).single()).isEqualTo(CANCELLATION_REFUND);
        verify(directory).confirm(duplicate);
        verify(directory).confirm(original);
        verifyNoMoreInteractions(directory);
    }

    @Test
    void rejectsMissingExpiredOrCrossStoreAuthorityBeforeProviderLookup() throws Exception {
        OrderFixture order = newOrder(true);
        settle(order.attemptId(), LATE_TRANSACTION);
        record(null, order.attemptId(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isUnauthorized());
        for (String role : List.of("kitchen", "pickup")) {
            record(login(staff(store, role)), order.attemptId(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isForbidden());
        }
        record(login(staff(newStore(), "manager")), order.attemptId(), LATE_TRANSACTION, LATE_REFUND)
                .andExpect(status().isNotFound());
        Staff expiredManager = staff(store, "manager");
        String expired = login(expiredManager);
        jdbc.sql("UPDATE operator_sessions SET expires_at = now() WHERE operator_id = ?")
                .param(expiredManager.id()).update();
        record(expired, order.attemptId(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isUnauthorized());
        String manager = login(staff(store, "manager"));
        record(manager, UUID.randomUUID(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isNotFound());
        record(manager, order.attemptId(), LATE_TRANSACTION, "not-numeric").andExpect(status().isBadRequest());
        verifyNoInteractions(directory);
        assertThat(orderState(order.id())).isEqualTo("cancelled:refund_pending");
    }

    @Test
    void providerUncertaintyOrAnInexactRefundDoesNotWriteAuditOrOrderState() throws Exception {
        OrderFixture order = newOrder(true);
        settle(order.attemptId(), LATE_TRANSACTION);
        String manager = login(staff(store, "manager"));
        RefundRequest expected = new RefundRequest(LATE_REFUND, LATE_TRANSACTION, TOTAL, "RWF");
        when(directory.confirm(expected)).thenReturn(Optional.empty(),
                Optional.of(new ConfirmedRefund(LATE_REFUND, LATE_TRANSACTION, TOTAL - 1, "RWF", "completed-momo")))
                .thenThrow(new PaymentGatewayException(PaymentGatewayException.Kind.UNAVAILABLE));
        for (int index = 0; index < 2; index++) {
            record(manager, order.attemptId(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isConflict())
                    .andExpect(jsonPath("$.code").value("refund_unconfirmed"));
        }
        record(manager, order.attemptId(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("refund_verification_unavailable"));
        assertThat(orderState(order.id())).isEqualTo("cancelled:refund_pending");
        assertThat(jdbc.sql("SELECT count(*) FROM verified_refunds WHERE store_id = ?")
                .param(store).query(Long.class).single()).isZero();
    }

    @Test
    void refundAuditCannotBeEdited() throws Exception {
        OrderFixture order = newOrder(true);
        settle(order.attemptId(), LATE_TRANSACTION);
        confirm(LATE_REFUND, LATE_TRANSACTION);
        record(login(staff(store, "manager")), order.attemptId(), LATE_TRANSACTION, LATE_REFUND).andExpect(status().isOk());
        assertThatThrownBy(() -> jdbc.sql("UPDATE verified_refunds SET operator_username = 'replacement-manager' WHERE provider_refund_id = ?")
                .param(LATE_REFUND).update()).hasStackTraceContaining("Verified refunds are append-only");
    }

    private RefundRequest confirm(String refund, String transaction) {
        RefundRequest expected = new RefundRequest(refund, transaction, TOTAL, "RWF");
        when(directory.confirm(expected)).thenReturn(Optional.of(new ConfirmedRefund(refund, transaction, TOTAL, "RWF", "completed-momo")));
        return expected;
    }

    private OrderFixture newOrder(boolean expired) {
        UUID id = UUID.randomUUID();
        UUID quote = UUID.randomUUID();
        UUID guest = UUID.randomUUID();
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC).withNano(0);
        OffsetDateTime pickupStarts = now.plusMinutes(20);
        OffsetDateTime pickupEnds = pickupStarts.plusMinutes(10);
        jdbc.sql("INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity) VALUES (?, ?, ?, ?, 4)")
                .params(store, SLOT, pickupStarts, pickupEnds).update();
        jdbc.sql("INSERT INTO guest_sessions (id, token_hash, expires_at) VALUES (?, ?, ?)")
                .params(guest, guest.toString(), now.plusHours(1)).update();
        jdbc.sql("""
                INSERT INTO quotes (id, guest_session_id, store_id, slot_id, pickup_starts_at, pickup_ends_at, lines, total, tax, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 0, ?)
                """).params(quote, guest, store, SLOT, pickupStarts, pickupEnds, TOTAL, now.plusMinutes(5)).update();
        jdbc.sql("""
                INSERT INTO orders (id, quote_id, guest_session_id, request_key, store_id, slot_id, phone, lines, total, tax,
                    status, payment_status, created_at, reservation_expires_at, pickup_starts_at, pickup_ends_at)
                VALUES (?, ?, ?, ?, ?, ?, '+250700000000', '[]', ?, 0, 'awaiting_payment', 'processing', ?, ?, ?, ?)
                """).params(id, quote, guest, id.toString(), store, SLOT, TOTAL, now,
                        expired ? now.minusSeconds(1) : now.plusMinutes(5), pickupStarts, pickupEnds).update();
        return new OrderFixture(id, addAttempt(id));
    }

    private UUID addAttempt(UUID order) {
        UUID attempt = UUID.randomUUID();
        jdbc.sql("INSERT INTO payment_attempts (id, order_id, request_key, status) VALUES (?, ?, ?, 'processing')")
                .params(attempt, order, attempt.toString()).update();
        return attempt;
    }

    private void settle(UUID attempt, String transaction) {
        payments.settlePayment(new VerifiedPayment(attempt.toString(), transaction, TOTAL, "RWF", PaymentResult.PAID));
    }

    private String orderState(UUID order) {
        return jdbc.sql("SELECT status || ':' || payment_status FROM orders WHERE id = ?")
                .param(order).query(String.class).single();
    }

    private String newStore() {
        String id = "refund-it-" + UUID.randomUUID();
        jdbc.sql("INSERT INTO stores(id, name, area, hours, open, tax_basis_points, version) VALUES (?, '{}', '{}', '{}', true, 0, 'test')")
                .param(id).update();
        return id;
    }

    private Staff staff(String storeId, String role) {
        Staff staff = new Staff(UUID.randomUUID(), "tester-" + UUID.randomUUID());
        jdbc.sql("INSERT INTO operator_accounts (id, username, store_id, role, password_hash) VALUES (?, ?, ?, ?, ?)")
                .params(staff.id(), staff.username(), storeId, role, PASSWORD_HASH).update();
        return staff;
    }

    private String login(Staff staff) throws Exception {
        byte[] body = api.perform(post(OPERATOR + "/sessions").contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("username", staff.username(), "password", PASSWORD))))
                .andExpect(status().isCreated()).andReturn().getResponse().getContentAsByteArray();
        return "Bearer " + json.readTree(body).path("accessToken").asString("");
    }

    private ResultActions record(String authorization, UUID attempt, String transaction, String refund) throws Exception {
        var request = post(REVIEW + "/{attempt}/{transaction}/refund", attempt, transaction).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(Map.of("providerRefundId", refund)));
        if (authorization != null) {
            request.header(HttpHeaders.AUTHORIZATION, authorization);
        }
        return api.perform(request);
    }

    private ResultActions review(String authorization, String state, String after) throws Exception {
        var request = get(REVIEW);
        if (authorization != null) request.header(HttpHeaders.AUTHORIZATION, authorization);
        if (state != null) request.param("state", state);
        if (after != null) request.param("after", after);
        return api.perform(request);
    }

    private JsonNode body(ResultActions response) throws Exception {
        return json.readTree(response.andReturn().getResponse().getContentAsByteArray());
    }

    private record Staff(UUID id, String username) { }
    private record OrderFixture(UUID id, UUID attemptId) { }
}
