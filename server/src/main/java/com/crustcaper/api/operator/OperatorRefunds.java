package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorModels.RefundView;
import com.crustcaper.api.operator.OperatorSessions.Principal;
import com.crustcaper.api.payment.PaymentGatewayException;
import com.crustcaper.api.payment.RefundDirectory;
import com.crustcaper.api.payment.RefundDirectory.ConfirmedRefund;
import com.crustcaper.api.payment.RefundDirectory.RefundRequest;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class OperatorRefunds {
    private static final String CURRENCY = "RWF";
    private static final String REFUND_FIELDS = "provider_refund_id, refund_status, amount, currency, recorded_at";

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;
    private final ObjectProvider<RefundDirectory> provider;

    OperatorRefunds(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions,
                    ObjectProvider<RefundDirectory> provider) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
        this.provider = provider;
    }

    RefundView record(String authorization, String reference, String transactionId, String refundId) {
        Principal actor = manager(authorization, false);
        UUID attemptId = attemptId(reference);
        if (!RefundDirectory.validId(transactionId) || !RefundDirectory.validId(refundId)) {
            throw OperatorFailure.invalid();
        }
        EligibleException target = findException(actor, attemptId, transactionId, false);
        Optional<RefundView> recorded = existing(attemptId, transactionId, refundId);
        if (recorded.isPresent()) {
            return recorded.orElseThrow();
        }

        RefundDirectory directory = provider.getIfAvailable();
        if (directory == null) {
            throw unavailable();
        }
        RefundRequest expected = new RefundRequest(refundId, transactionId, target.amount(), CURRENCY);
        ConfirmedRefund verified;
        try {
            verified = directory.confirm(expected).filter(refund -> refund.confirms(expected))
                    .orElseThrow(OperatorRefunds::unconfirmed);
        } catch (PaymentGatewayException failure) {
            throw failure.kind() == PaymentGatewayException.Kind.UNAVAILABLE ? unavailable() : unconfirmed();
        }
        return Objects.requireNonNull(transactions.execute(tx -> persist(authorization, attemptId, verified)));
    }

    private RefundView persist(String authorization, UUID attemptId, ConfirmedRefund evidence) {
        Principal actor = manager(authorization, true);
        EligibleException target = findException(actor, attemptId, evidence.transactionId(), true);
        Optional<RefundView> recorded = existing(attemptId, evidence.transactionId(), evidence.refundId());
        if (recorded.isPresent()) {
            return recorded.orElseThrow();
        }
        if (target.amount() != evidence.amount()) {
            throw unconfirmed();
        }
        RefundView stored = jdbc.sql("""
                INSERT INTO verified_refunds (provider_refund_id, attempt_id, provider_transaction_id, refund_status,
                    amount, currency, store_id, operator_id, operator_username, cleared_order_payment)
                SELECT ?, ?, ?, ?, ?, ?, a.store_id, a.id, a.username, ?
                FROM operator_accounts a WHERE a.id = ?
                ON CONFLICT DO NOTHING
                RETURNING
                """ + " " + REFUND_FIELDS)
                .params(evidence.refundId(), attemptId, evidence.transactionId(), evidence.status(), evidence.amount(),
                        evidence.currency(), target.clearsOrderPayment(), actor.id())
                .query((row, number) -> refundRow(row)).optional()
                .orElseThrow(() -> OperatorFailure.conflict("refund_already_recorded"));
        if (target.clearsOrderPayment()) {
            jdbc.sql("UPDATE orders SET payment_status = 'refunded' WHERE id = ?")
                    .param(target.orderId()).update();
        }
        return stored;
    }

    private EligibleException findException(Principal actor, UUID attemptId, String transactionId, boolean lock) {
        return jdbc.sql("""
                SELECT o.id, o.total,
                    (pe.reason IN ('unavailable_reservation', 'restaurant_cancelled')
                        AND o.status = 'cancelled' AND o.payment_status = 'refund_pending'
                        AND pa.provider_transaction_id IS NOT DISTINCT FROM pe.provider_transaction_id
                        AND NOT EXISTS (SELECT FROM payment_attempts later WHERE later.order_id = o.id AND later.sequence > pa.sequence))
                    AS clears_order_payment
                FROM payment_exceptions pe
                JOIN payment_attempts pa ON pa.id = pe.attempt_id
                JOIN orders o ON o.id = pa.order_id
                WHERE pe.attempt_id = ? AND pe.provider_transaction_id = ? AND o.store_id = ? AND pa.status = 'paid'
                """ + (lock ? "FOR UPDATE OF o" : ""))
                .params(attemptId, transactionId, actor.storeId())
                .query((row, number) -> new EligibleException(row.getObject("id", UUID.class), row.getLong("total"),
                        row.getBoolean("clears_order_payment")))
                .optional().orElseThrow(OperatorFailure::notFound);
    }

    private Optional<RefundView> existing(UUID attemptId, String transactionId, String refundId) {
        Optional<RefundView> recorded = jdbc.sql("SELECT " + REFUND_FIELDS + """
                 FROM verified_refunds WHERE attempt_id = ? AND provider_transaction_id = ?
                """).params(attemptId, transactionId).query((row, number) -> refundRow(row)).optional();
        if (recorded.isPresent() && !recorded.orElseThrow().providerRefundId().equals(refundId)) {
            throw OperatorFailure.conflict("refund_already_recorded");
        }
        return recorded;
    }

    static RefundView refundRow(ResultSet row) throws SQLException {
        return new RefundView(row.getString("provider_refund_id"), row.getString("refund_status"), row.getLong("amount"),
                row.getString("currency"), row.getObject("recorded_at", OffsetDateTime.class).toInstant());
    }

    private Principal manager(String authorization, boolean lock) {
        Principal actor = sessions.requirePrincipal(authorization, lock);
        if (!actor.role().equals("manager")) {
            throw OperatorFailure.forbidden();
        }
        return actor;
    }

    private static UUID attemptId(String reference) {
        if (reference.length() == 36) {
            try {
                UUID id = UUID.fromString(reference);
                if (id.toString().equalsIgnoreCase(reference)) {
                    return id;
                }
            } catch (IllegalArgumentException ignored) {
                // Report malformed references with the same safe error as other invalid input.
            }
        }
        throw OperatorFailure.invalid();
    }

    private static OperatorFailure unavailable() {
        return new OperatorFailure(HttpStatus.SERVICE_UNAVAILABLE, "refund_verification_unavailable");
    }

    private static OperatorFailure unconfirmed() {
        return OperatorFailure.conflict("refund_unconfirmed");
    }

    private record EligibleException(UUID orderId, long amount, boolean clearsOrderPayment) { }
}
