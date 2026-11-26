package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorModels.OrderLine;
import com.crustcaper.api.operator.OperatorModels.OrderView;
import com.crustcaper.api.operator.OperatorModels.PaymentExceptionView;
import com.crustcaper.api.operator.OperatorModels.PaymentReview;
import com.crustcaper.api.operator.OperatorModels.PaymentReviewPage;
import com.crustcaper.api.operator.OperatorModels.PickupLookup;
import com.crustcaper.api.operator.OperatorModels.PickupStatus;
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
import java.util.Base64;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class OperatorOrders {
    private static final Pattern PICKUP_CODE = Pattern.compile("[0-9]{6}");
    private static final String ORDER_FIELDS = "id, status, payment_status, lines, total, pickup_starts_at, pickup_ends_at, accepted_at";
    private static final String RESTAURANT_CANCELLED = "restaurant_cancelled";
    private static final int PAYMENT_REVIEW_LIMIT = 50;
    private static final String PAYMENT_REVIEW_FIELDS = """
            SELECT o.id AS order_id, pe.attempt_id, pe.provider_transaction_id, pe.reason, pe.created_at,
                vr.provider_refund_id, vr.refund_status, vr.amount, vr.currency, vr.recorded_at
            FROM payment_exceptions pe
            JOIN payment_attempts pa ON pa.id = pe.attempt_id
            JOIN orders o ON o.id = pa.order_id
            LEFT JOIN verified_refunds vr ON vr.attempt_id = pe.attempt_id AND vr.provider_transaction_id = pe.provider_transaction_id
            WHERE o.store_id = ?
            """;
    private static final String PAYMENT_REVIEW_AFTER = """
            AND (pe.created_at, pe.attempt_id, pe.provider_transaction_id) %s (
                SELECT anchor.created_at, anchor.attempt_id, anchor.provider_transaction_id
                FROM payment_exceptions anchor
                JOIN payment_attempts p ON p.id = anchor.attempt_id
                JOIN orders o ON o.id = p.order_id
                WHERE anchor.attempt_id = ? AND anchor.provider_transaction_id = ? AND o.store_id = ?
            )
            """;
    private static final String PAYMENT_REVIEW_ORDER = """
            ORDER BY pe.created_at %s, pe.attempt_id %s, pe.provider_transaction_id %s
            LIMIT ?
            """;
    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final OperatorExternalOrders externalOrders;
    private final TransactionTemplate transactions;
    private final ObjectReader lineReader;

    OperatorOrders(JdbcClient jdbc, OperatorSessions sessions, OperatorExternalOrders externalOrders,
                   TransactionTemplate transactions, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.externalOrders = externalOrders;
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
        List<OperatorExternalOrders.Order> external = externalOrders.active(actor);
        return new Queue(active, jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single().toInstant(), external);
    }

    PickupStatus pickupStatus(String authorization, String rawId) {
        Principal actor = pickupOperator(authorization);
        return jdbc.sql("""
                SELECT o.id, o.status, o.status = 'collected' AND EXISTS (
                    SELECT 1 FROM operator_order_events e
                    WHERE e.order_id = o.id AND e.store_id = o.store_id AND e.operator_id = ?
                        AND e.requested_status = 'collected' AND e.outcome = 'changed'
                ) AS confirmed_by_current_operator
                FROM orders o WHERE o.id = ? AND o.store_id = ?
                """).params(actor.id(), orderId(rawId), actor.storeId())
                .query((row, number) -> new PickupStatus(row.getObject("id", UUID.class), row.getString("status"),
                        row.getBoolean("confirmed_by_current_operator")))
                .optional().orElseThrow(OperatorFailure::notFound);
    }

    PickupLookup pickupLookup(String authorization, String orderCode) {
        Principal actor = pickupOperator(authorization);
        OperatorOrderCode match = OperatorOrderCode.parse(orderCode);
        List<PickupLookup> matches = jdbc.sql("""
                SELECT o.id, o.status, o.pickup_starts_at, o.pickup_ends_at FROM orders o
                WHERE o.store_id = ? AND o.payment_status = 'paid'
                    AND o.status IN ('accepted', 'preparing', 'ready', 'collected') AND
                """ + match.predicate() + " LIMIT 2").params(actor.storeId(), match.parameter())
                .query((row, number) -> new PickupLookup(row.getObject("id", UUID.class), row.getString("status"),
                        row.getObject("pickup_starts_at", OffsetDateTime.class).toInstant(),
                        row.getObject("pickup_ends_at", OffsetDateTime.class).toInstant()))
                .list();
        if (matches.isEmpty()) throw OperatorFailure.notFound();
        if (matches.size() > 1) throw OperatorFailure.conflict("order_code_ambiguous");
        return matches.getFirst();
    }

    private Principal pickupOperator(String authorization) {
        Principal actor = sessions.requirePrincipal(authorization, false);
        if (!actor.role().equals("pickup") && !actor.role().equals("manager")) throw OperatorFailure.forbidden();
        return actor;
    }

    PaymentReview paymentReview(String authorization, String after) {
        Principal actor = paymentReviewManager(authorization);
        if (after != null) throw OperatorFailure.invalid();
        List<PaymentExceptionView> entries = jdbc.sql(PAYMENT_REVIEW_FIELDS + PAYMENT_REVIEW_ORDER.formatted("DESC", "DESC", "DESC"))
                .params(actor.storeId(), PAYMENT_REVIEW_LIMIT).query(OperatorOrders::paymentExceptionRow).list();
        return new PaymentReview(entries);
    }

    PaymentReviewPage paymentReviewPage(String authorization, String state, String after) {
        Principal actor = paymentReviewManager(authorization);
        boolean open = switch (state) {
            case "open" -> true;
            case "verified" -> false;
            default -> throw OperatorFailure.invalid();
        };
        PaymentReviewCursor cursor = after == null ? null : PaymentReviewCursor.decode(state, after);
        String refundFilter = open ? "AND vr.provider_refund_id IS NULL\n" : "AND vr.provider_refund_id IS NOT NULL\n";
        String direction = open ? "ASC" : "DESC";
        // Resolve the previous row in this store even if a refund moved it from open to verified.
        String startAfter = cursor == null ? "" : PAYMENT_REVIEW_AFTER.formatted(open ? ">" : "<");
        var query = jdbc.sql(PAYMENT_REVIEW_FIELDS + refundFilter + startAfter
                + PAYMENT_REVIEW_ORDER.formatted(direction, direction, direction)).param(actor.storeId());
        if (cursor != null) query.params(cursor.attemptId(), cursor.transactionId(), actor.storeId());
        List<PaymentExceptionView> entries = query.param(PAYMENT_REVIEW_LIMIT + 1)
                .query(OperatorOrders::paymentExceptionRow).list();
        if (entries.size() <= PAYMENT_REVIEW_LIMIT) return new PaymentReviewPage(entries, null);
        var last = entries.get(PAYMENT_REVIEW_LIMIT - 1);
        String nextCursor = new PaymentReviewCursor(last.merchantReference(), last.providerTransactionId()).encode(state);
        return new PaymentReviewPage(entries.subList(0, PAYMENT_REVIEW_LIMIT), nextCursor);
    }

    private Principal paymentReviewManager(String authorization) {
        Principal actor = sessions.requirePrincipal(authorization, false);
        if (!actor.role().equals("manager")) {
            throw OperatorFailure.forbidden();
        }
        return actor;
    }

    private static PaymentExceptionView paymentExceptionRow(ResultSet row, int number) throws SQLException {
        return new PaymentExceptionView(row.getObject("order_id", UUID.class), row.getObject("attempt_id", UUID.class),
                row.getString("provider_transaction_id"), row.getString("reason"),
                row.getObject("created_at", OffsetDateTime.class).toInstant(),
                row.getString("provider_refund_id") == null ? null : OperatorRefunds.refundRow(row));
    }

    private record PaymentReviewCursor(UUID attemptId, String transactionId) {
        String encode(String state) {
            String data = state + ":" + attemptId + ":" + transactionId;
            return Base64.getUrlEncoder().withoutPadding().encodeToString(data.getBytes(StandardCharsets.UTF_8));
        }

        static PaymentReviewCursor decode(String state, String encoded) {
            if (encoded.length() > 512) throw OperatorFailure.invalid();
            try {
                String data = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
                String[] parts = data.split(":", 3);
                if (parts.length == 3 && state.equals(parts[0]) && !parts[2].isBlank() && parts[2].indexOf('\0') < 0) {
                    var cursor = new PaymentReviewCursor(UUID.fromString(parts[1]), parts[2]);
                    if (cursor.encode(state).equals(encoded)) return cursor;
                }
            } catch (IllegalArgumentException ignored) {
                // Reject malformed encodings and UUIDs through the standard operator problem response.
            }
            throw OperatorFailure.invalid();
        }
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

    OrderView cancel(String authorization, String rawId) {
        return Objects.requireNonNull(transactions.execute(tx -> {
            Principal actor = sessions.requirePrincipal(authorization, true);
            if (!actor.role().equals("manager")) throw OperatorFailure.forbidden();
            UUID id = orderId(rawId);
            OrderView existing = jdbc.sql("SELECT " + ORDER_FIELDS + " FROM orders WHERE id = ? AND store_id = ? FOR UPDATE")
                    .params(id, actor.storeId()).query(this::orderRow).optional().orElseThrow(OperatorFailure::notFound);
            if (existing.status().equals("cancelled")
                    && (existing.paymentStatus().equals("refund_pending") || existing.paymentStatus().equals("refunded"))) {
                PaidReference primary = currentPaidReference(id);
                if (primary != null && RESTAURANT_CANCELLED.equals(primary.exceptionReason())) return existing;
                throw OperatorFailure.conflict("invalid_transition");
            }
            if (!existing.paymentStatus().equals("paid") || !cancellableStatus(existing.status())) {
                throw OperatorFailure.conflict("invalid_transition");
            }

            PaidReference primary = currentPaidReference(id);
            if (primary == null || primary.exceptionReason() != null) {
                throw OperatorFailure.conflict("payment_reference_unavailable");
            }
            int recorded = jdbc.sql("""
                    INSERT INTO payment_exceptions (attempt_id, provider_transaction_id, reason, created_at)
                    VALUES (?, ?, ?, clock_timestamp()) ON CONFLICT (attempt_id, provider_transaction_id) DO NOTHING
                    """).params(primary.attemptId(), primary.transactionId(), RESTAURANT_CANCELLED).update();
            if (recorded != 1) throw OperatorFailure.conflict("payment_reference_unavailable");

            jdbc.sql("""
                    UPDATE orders SET status = 'cancelled', payment_status = 'refund_pending', pickup_code = NULL WHERE id = ?
                    """).param(id).update();
            cancelPickupAlerts(id);
            recordEvent(actor, id, existing.status(), "cancelled", "changed");
            return new OrderView(id, "cancelled", "refund_pending", existing.lines(), existing.total(), existing.currency(),
                    existing.pickupStartsAt(), existing.pickupEndsAt(), existing.acceptedAt());
        }));
    }

    private static boolean cancellableStatus(String status) {
        return status.equals("accepted") || status.equals("preparing") || status.equals("ready");
    }

    private PaidReference currentPaidReference(UUID orderId) {
        // Settlement also locks the order before the attempt. Older paid attempts must already be classified as superseded.
        return jdbc.sql("""
                SELECT primary_attempt.id, primary_attempt.provider_transaction_id, primary_exception.reason
                FROM payment_attempts primary_attempt
                LEFT JOIN payment_exceptions primary_exception ON primary_exception.attempt_id = primary_attempt.id
                    AND primary_exception.provider_transaction_id = primary_attempt.provider_transaction_id
                WHERE primary_attempt.order_id = ? AND primary_attempt.status = 'paid'
                    AND NULLIF(btrim(primary_attempt.provider_transaction_id), '') IS NOT NULL
                    AND NOT EXISTS (
                        SELECT FROM payment_attempts other
                        LEFT JOIN payment_exceptions explained ON explained.attempt_id = other.id
                            AND explained.provider_transaction_id = other.provider_transaction_id
                        WHERE other.order_id = primary_attempt.order_id AND other.id <> primary_attempt.id
                            AND (other.sequence >= primary_attempt.sequence OR
                                (other.status = 'paid' AND explained.reason IS DISTINCT FROM 'superseded_attempt'))
                    )
                FOR UPDATE OF primary_attempt
                """).param(orderId)
                .query((row, number) -> new PaidReference(row.getObject("id", UUID.class),
                        row.getString("provider_transaction_id"), row.getString("reason")))
                .optional().orElse(null);
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
            recordEvent(actor, id, transition.from(), transition.to(), "pickup_code_mismatch");
            return new Outcome(null, true);
        }

        jdbc.sql("UPDATE orders SET status = ?, pickup_code = CASE WHEN ? THEN NULL ELSE pickup_code END WHERE id = ?")
                .params(transition.to(), transition.collects(), id).update();
        recordEvent(actor, id, transition.from(), transition.to(), "changed");
        if (transition == Transition.READY) enqueuePickupAlerts(id);
        OrderView before = existing.order();
        return new Outcome(new OrderView(id, transition.to(), before.paymentStatus(), before.lines(), before.total(), before.currency(),
                before.pickupStartsAt(), before.pickupEndsAt(), before.acceptedAt()), false);
    }

    private void enqueuePickupAlerts(UUID orderId) {
        jdbc.sql("""
                UPDATE pickup_alerts
                SET state = 'pending', queued_at = clock_timestamp(), next_attempt_at = clock_timestamp(),
                    updated_at = clock_timestamp()
                WHERE order_id = ? AND state = 'waiting' AND enabled AND encrypted_token IS NOT NULL
                """).param(orderId).update();
    }

    private void cancelPickupAlerts(UUID orderId) {
        // A sending claim that has reached Expo holds the order lock. An accepted ticket can only be reconciled.
        jdbc.sql("""
                UPDATE pickup_alerts SET state = 'cancelled', enabled = false, encrypted_token = NULL,
                    expo_ticket_id = NULL, next_attempt_at = NULL, lease_id = NULL, lease_until = NULL,
                    updated_at = clock_timestamp()
                WHERE order_id = ? AND state IN ('waiting', 'pending', 'sending')
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

    private void recordEvent(Principal actor, UUID id, String previousStatus, String requestedStatus, String outcome) {
        jdbc.sql("""
                INSERT INTO operator_order_events (order_id, store_id, operator_id, operator_role,
                    previous_status, requested_status, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)
                """).params(id, actor.storeId(), actor.id(), actor.role(), previousStatus, requestedStatus, outcome).update();
    }

    private OrderView orderRow(ResultSet row, int number) throws SQLException {
        List<OrderLine> lines;
        try {
            lines = lineReader.readValue(row.getString("lines"));
        } catch (JacksonException ignored) {
            throw new OperatorFailure(HttpStatus.SERVICE_UNAVAILABLE, "service_unavailable");
        }
        OffsetDateTime acceptedAt = row.getObject("accepted_at", OffsetDateTime.class);
        return new OrderView(row.getObject("id", UUID.class), row.getString("status"), row.getString("payment_status"),
                lines, row.getLong("total"), "RWF", row.getObject("pickup_starts_at", OffsetDateTime.class).toInstant(),
                row.getObject("pickup_ends_at", OffsetDateTime.class).toInstant(),
                acceptedAt == null ? null : acceptedAt.toInstant());
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

    private record PaidReference(UUID attemptId, String transactionId, String exceptionReason) { }

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
