package com.crustcaper.api.operator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
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

    private record Staff(UUID id, String username) { }
    private record OrderFixture(UUID id, UUID attemptId) { }
}
