package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorModels.OrderLine;
import com.crustcaper.api.operator.OperatorModels.OrderView;
import com.crustcaper.api.operator.OperatorModels.PaymentExceptionView;
import com.crustcaper.api.operator.OperatorModels.PaymentReview;
import com.crustcaper.api.operator.OperatorModels.Queue;
import com.crustcaper.api.operator.OperatorModels.StatusInput;
import com.crustcaper.api.operator.OperatorSessions.Principal;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.ObjectReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class OperatorOrders {
    private static final Pattern PICKUP_CODE = Pattern.compile("[0-9]{6}");
    private static final String ORDER_FIELDS = "id, status, payment_status, lines, pickup_starts_at, pickup_ends_at";
    private static final int PAYMENT_REVIEW_LIMIT = 50;
    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;
    private final ObjectReader lineReader;

    OperatorOrders(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
        this.lineReader = mapper.readerForListOf(OrderLine.class);
    }

    Queue active(String authorization) {
        Principal actor = sessions.requirePrincipal(authorization, false);
        List<OrderView> active = jdbc.sql("SELECT " + ORDER_FIELDS + """
                 FROM orders
                 WHERE store_id = ? AND payment_status = 'paid' AND status IN ('accepted', 'preparing', 'ready')
                 ORDER BY pickup_starts_at, id
                """).param(actor.storeId()).query(this::orderRow).list();
        return new Queue(active);
    }

    PaymentReview paymentReview(String authorization) {
        Principal actor = sessions.requirePrincipal(authorization, false);
        if (!actor.role().equals("manager")) {
            throw OperatorFailure.forbidden();
        }
        List<PaymentExceptionView> entries = jdbc.sql("""
                SELECT o.id AS order_id, pe.attempt_id, pe.provider_transaction_id, pe.reason, pe.created_at,
                    vr.provider_refund_id, vr.refund_status, vr.amount, vr.currency, vr.recorded_at
                FROM payment_exceptions pe
                JOIN payment_attempts pa ON pa.id = pe.attempt_id
                JOIN orders o ON o.id = pa.order_id
                LEFT JOIN verified_refunds vr ON vr.attempt_id = pe.attempt_id AND vr.provider_transaction_id = pe.provider_transaction_id
                WHERE o.store_id = ?
                ORDER BY pe.created_at DESC, pe.attempt_id DESC, pe.provider_transaction_id DESC
                LIMIT ?
                """).params(actor.storeId(), PAYMENT_REVIEW_LIMIT)
                .query((row, number) -> new PaymentExceptionView(row.getObject("order_id", UUID.class),
                        row.getObject("attempt_id", UUID.class), row.getString("provider_transaction_id"),
                        row.getString("reason"), row.getObject("created_at", OffsetDateTime.class).toInstant(),
                        row.getString("provider_refund_id") == null ? null : OperatorRefunds.refundRow(row)))
                .list();
        return new PaymentReview(entries);
    }

    OrderView change(String authorization, String rawId, StatusInput input) {
        UUID id = orderId(rawId);
        Transition requested = Transition.forStatus(input.status());
        if (requested.collects() ? input.pickupCode() == null || !PICKUP_CODE.matcher(input.pickupCode()).matches()
                : input.pickupCode() != null) {
            throw OperatorFailure.invalid();
        }

        Outcome result = transactions.execute(tx -> changeLocked(authorization, id, requested, input.pickupCode()));
        if (result.rejected()) {
            // Report the rejection after the transaction records this failed attempt without its code.
            throw OperatorFailure.conflict("pickup_code_mismatch");
        }
        return result.order();
    }

    private Outcome changeLocked(String authorization, UUID id, Transition transition, String pickupCode) {
        Principal actor = sessions.requirePrincipal(authorization, true);
        if (!actor.role().equals(transition.role()) && !actor.role().equals("manager")) {
            throw OperatorFailure.forbidden();
        }
        ProfiledOrder existing = jdbc.sql("SELECT " + ORDER_FIELDS + """
                , pickup_code FROM orders WHERE id = ? AND store_id = ? AND payment_status = 'paid' FOR UPDATE
                """).params(id, actor.storeId())
                .query((rs, row) -> new ProfiledOrder(orderRow(rs, row), rs.getString("pickup_code")))
                .optional().orElseThrow(OperatorFailure::notFound);

        if (!transition.from().equals(existing.order().status())) {
            throw OperatorFailure.conflict("invalid_transition");
        }
        if (transition.collects() && !acceptPickup(existing.pickupCode(), pickupCode, actor, id)) {
            recordEvent(actor, id, transition, "pickup_code_mismatch");
            return new Outcome(null, true);
        }

        jdbc.sql("UPDATE orders SET status = ?, pickup_code = CASE WHEN ? THEN NULL ELSE pickup_code END WHERE id = ?")
                .params(transition.to(), transition.collects(), id).update();
        recordEvent(actor, id, transition, "changed");
        if (transition == Transition.READY) enqueuePickupAlerts(id);
        OrderView before = existing.order();
        return new Outcome(new OrderView(id, transition.to(), before.paymentStatus(), before.lines(),
                before.pickupStartsAt(), before.pickupEndsAt()), false);
    }

    private void enqueuePickupAlerts(UUID orderId) {
        jdbc.sql("""
                UPDATE pickup_alerts
                SET state = 'pending', queued_at = clock_timestamp(), next_attempt_at = clock_timestamp(),
                    updated_at = clock_timestamp()
                WHERE order_id = ? AND state = 'waiting' AND enabled AND encrypted_token IS NOT NULL
                """).param(orderId).update();
    }

    private boolean acceptPickup(String storedCode, String presentedCode, Principal actor, UUID id) {
        long failures = jdbc.sql("""
                SELECT count(*) FROM operator_order_events
                WHERE order_id = ? AND operator_id = ? AND outcome = 'pickup_code_mismatch'
                  AND occurred_at > now() - interval '2 minutes'
                """).params(id, actor.id()).query(Long.class).single();
        if (failures >= 5) {
            throw OperatorFailure.rateLimited();
        }
        return storedCode != null && MessageDigest.isEqual(storedCode.getBytes(StandardCharsets.US_ASCII),
                presentedCode.getBytes(StandardCharsets.US_ASCII));
    }

    private void recordEvent(Principal actor, UUID id, Transition transition, String outcome) {
        jdbc.sql("""
                INSERT INTO operator_order_events (order_id, store_id, operator_id, operator_role,
                    previous_status, requested_status, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)
                """).params(id, actor.storeId(), actor.id(), actor.role(), transition.from(), transition.to(), outcome).update();
    }

    private OrderView orderRow(ResultSet row, int number) throws SQLException {
        List<OrderLine> lines;
        try {
            lines = lineReader.readValue(row.getString("lines"));
        } catch (JacksonException ignored) {
            throw new OperatorFailure(HttpStatus.SERVICE_UNAVAILABLE, "service_unavailable");
        }
        return new OrderView(row.getObject("id", UUID.class), row.getString("status"), row.getString("payment_status"),
                lines, row.getObject("pickup_starts_at", OffsetDateTime.class).toInstant(),
                row.getObject("pickup_ends_at", OffsetDateTime.class).toInstant());
    }

    private static UUID orderId(String value) {
        if (value == null || value.length() != 36) {
            throw OperatorFailure.notFound();
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException ignored) {
            throw OperatorFailure.notFound();
        }
    }

    private record ProfiledOrder(OrderView order, String pickupCode) { }

    private record Outcome(OrderView order, boolean rejected) { }

    private enum Transition {
        PREPARING("accepted", "preparing", "kitchen"),
        READY("preparing", "ready", "kitchen"),
        COLLECTED("ready", "collected", "pickup");

        private final String from;
        private final String to;
        private final String role;

        Transition(String from, String to, String role) {
            this.from = from;
            this.to = to;
            this.role = role;
        }

        String from() { return from; }

        String to() { return to; }

        String role() { return role; }

        boolean collects() { return this == COLLECTED; }

        static Transition forStatus(String status) {
            return switch (status == null ? "" : status) {
                case "preparing" -> PREPARING;
                case "ready" -> READY;
                case "collected" -> COLLECTED;
                default -> throw OperatorFailure.invalid();
            };
        }
    }
}
