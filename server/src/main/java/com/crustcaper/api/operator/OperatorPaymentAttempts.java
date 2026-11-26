package com.crustcaper.api.operator;

import static com.crustcaper.api.OrderService.AUTOMATIC_RECONCILIATION_WINDOW_HOURS;
import static com.crustcaper.api.OrderService.OVERDUE_PAYMENT_CHECK_COOLDOWN_SECONDS;
import static com.crustcaper.api.OrderService.PAYMENT_MISMATCH;

import com.crustcaper.api.ApiFailure;
import com.crustcaper.api.OrderService;
import com.crustcaper.api.operator.OperatorModels.PaymentRecheck;
import com.crustcaper.api.operator.OperatorModels.PendingPaymentAttempt;
import com.crustcaper.api.operator.OperatorModels.PendingPaymentAttempts;
import com.crustcaper.api.operator.OperatorSessions.Principal;
import com.crustcaper.api.payment.PaymentGateway;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import com.crustcaper.api.payment.PaymentGatewayException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class OperatorPaymentAttempts {
    private static final int LIMIT = 50;
    private static final String PENDING = """
            o.store_id = ? AND o.payment_status = 'processing' AND p.status = 'processing'
            AND o.reservation_expires_at <= now() - make_interval(hours => ?)
            AND NOT EXISTS (SELECT FROM payment_attempts later
                WHERE later.order_id = o.id AND later.sequence > p.sequence)
            """;
    private static final String AFTER_CURSOR = """
            AND (o.reservation_expires_at, p.initiated_at, p.id) > (
                SELECT cursor_order.reservation_expires_at, cursor_attempt.initiated_at, cursor_attempt.id
                FROM payment_attempts cursor_attempt JOIN orders cursor_order ON cursor_order.id = cursor_attempt.order_id
                WHERE cursor_attempt.id = ? AND cursor_order.store_id = ?
            )
            """;

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;
    private final PaymentGateway gateway;
    private final OrderService orders;
    private final boolean flutterwave;

    OperatorPaymentAttempts(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions,
                            PaymentGateway gateway, OrderService orders,
                            @Value("${crustcaper.payment.provider}") String provider) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
        this.gateway = gateway;
        this.orders = orders;
        this.flutterwave = "flutterwave".equals(provider);
    }

    PendingPaymentAttempts pending(String authorization, String after) {
        Principal actor = manager(authorization, false);
        UUID cursor = after == null ? null : attemptId(after);
        if (!flutterwave) {
            return new PendingPaymentAttempts(List.of(), false);
        }
        var query = jdbc.sql("""
                SELECT o.id AS order_id, p.id AS merchant_reference, o.reservation_expires_at, p.last_checked_at
                FROM payment_attempts p JOIN orders o ON o.id = p.order_id
                WHERE
                """ + PENDING + (cursor == null ? "" : AFTER_CURSOR) + """
                ORDER BY o.reservation_expires_at, p.initiated_at, p.id
                LIMIT ?
                """).params(actor.storeId(), AUTOMATIC_RECONCILIATION_WINDOW_HOURS);
        if (cursor != null) {
            query.params(cursor, actor.storeId());
        }
        List<PendingPaymentAttempt> attempts = query.param(LIMIT + 1)
                .query((row, number) -> {
                    OffsetDateTime checked = row.getObject("last_checked_at", OffsetDateTime.class);
                    return new PendingPaymentAttempt(row.getObject("order_id", UUID.class),
                            row.getObject("merchant_reference", UUID.class),
                            row.getObject("reservation_expires_at", OffsetDateTime.class).toInstant(),
                            checked == null ? null : checked.toInstant());
                }).list();
        boolean hasMore = attempts.size() > LIMIT;
        return new PendingPaymentAttempts(hasMore ? attempts.subList(0, LIMIT) : attempts, hasMore);
    }

    PaymentRecheck recheck(String authorization, String reference) {
        UUID attemptId = Objects.requireNonNull(transactions.execute(tx -> claim(authorization, reference)));
        VerifiedPayment payment = verify(attemptId.toString());
        if (payment == null || payment.result() != PaymentResult.PAID) {
            requirePending(manager(authorization, false), attemptId);
            return new PaymentRecheck("pending");
        }
        try {
            transactions.executeWithoutResult(tx -> {
                // Settlement must see a verified charge even if a webhook already paid this attempt.
                lockOwnedAttempt(manager(authorization, true), attemptId);
                orders.settlePayment(payment);
            });
        } catch (ApiFailure failure) {
            throw new OperatorFailure(HttpStatus.valueOf(failure.status()), failure.code());
        } catch (DuplicateKeyException ignored) {
            throw OperatorFailure.conflict(PAYMENT_MISMATCH);
        }
        return new PaymentRecheck("settled");
    }

    private UUID claim(String authorization, String reference) {
        Principal actor = manager(authorization, true);
        if (!flutterwave) {
            throw OperatorFailure.notFound();
        }
        UUID attemptId = attemptId(reference);
        int updated = jdbc.sql("""
                UPDATE payment_attempts p SET last_checked_at = now()
                FROM orders o
                WHERE p.order_id = o.id AND
                """ + PENDING + """
                  AND p.id = ?
                  AND (p.last_checked_at IS NULL OR p.last_checked_at <= now() - make_interval(secs => ?))
                """).params(actor.storeId(), AUTOMATIC_RECONCILIATION_WINDOW_HOURS, attemptId,
                        OVERDUE_PAYMENT_CHECK_COOLDOWN_SECONDS).update();
        if (updated == 0) {
            requirePending(actor, attemptId);
            throw OperatorFailure.conflict("payment_check_cooldown");
        }
        return attemptId;
    }

    private VerifiedPayment verify(String reference) {
        try {
            VerifiedPayment payment = gateway.verifyByReference(reference).orElse(null);
            if (payment != null && (!reference.equals(payment.reference()) || payment.result() == null)) {
                throw OperatorFailure.conflict(PAYMENT_MISMATCH);
            }
            return payment;
        } catch (PaymentGatewayException failure) {
            throw switch (failure.kind()) {
                case UNAVAILABLE, NOT_DISPATCHED -> new OperatorFailure(HttpStatus.SERVICE_UNAVAILABLE, "service_unavailable");
                case INVALID_RESPONSE, INVALID_REQUEST -> OperatorFailure.conflict(PAYMENT_MISMATCH);
            };
        }
    }

    private void requirePending(Principal actor, UUID attemptId) {
        jdbc.sql("""
                SELECT 1 FROM payment_attempts p JOIN orders o ON o.id = p.order_id
                WHERE
                """ + PENDING + " AND p.id = ?")
                .params(actor.storeId(), AUTOMATIC_RECONCILIATION_WINDOW_HOURS, attemptId)
                .query(Integer.class).optional().orElseThrow(OperatorFailure::notFound);
    }

    private void lockOwnedAttempt(Principal actor, UUID attemptId) {
        jdbc.sql("""
                SELECT 1 FROM payment_attempts p JOIN orders o ON o.id = p.order_id
                WHERE p.id = ? AND o.store_id = ?
                FOR UPDATE OF o
                """).params(attemptId, actor.storeId()).query(Integer.class).optional()
                .orElseThrow(OperatorFailure::notFound);
    }

    private Principal manager(String authorization, boolean lock) {
        Principal actor = sessions.requirePrincipal(authorization, lock);
        if (!actor.role().equals("manager")) {
            throw OperatorFailure.forbidden();
        }
        return actor;
    }

    private static UUID attemptId(String reference) {
        if (reference != null && reference.length() == 36) {
            try {
                UUID id = UUID.fromString(reference);
                if (id.toString().equalsIgnoreCase(reference)) {
                    return id;
                }
            } catch (IllegalArgumentException ignored) {
                // Invalid and unavailable references share the same response.
            }
        }
        throw OperatorFailure.notFound();
    }
}
