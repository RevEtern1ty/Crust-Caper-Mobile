package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorSessions.Principal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class OperatorReceipts {
    private static final Pattern REFERENCE = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._/-]{0,79}");
    private static final Pattern WHOLE_RWF = Pattern.compile("[1-9][0-9]{0,18}");
    private static final String ORDER_FIELDS = """
        SELECT o.id, o.status, o.receipt_status, o.receipt_url, o.total, f.reference,
            correction.reference AS correction_reference, refundable.refund_id
        FROM orders o LEFT JOIN fiscal_receipts f ON f.order_id = o.id
        LEFT JOIN fiscal_receipt_corrections correction ON correction.order_id = o.id
        LEFT JOIN LATERAL (
            SELECT CASE WHEN count(*) = 1 THEN min(r.provider_refund_id) END AS refund_id
            FROM verified_refunds r JOIN payment_attempts a ON a.id = r.attempt_id
            WHERE o.status = 'cancelled' AND o.payment_status = 'refunded' AND f.order_id IS NOT NULL
                AND a.order_id = o.id AND a.status = 'paid'
                AND a.provider_transaction_id = r.provider_transaction_id
                AND r.store_id = o.store_id AND r.amount = o.total AND r.cleared_order_payment
        ) refundable ON true
        """;

    private static final String RECEIPT_QUEUE = """
        (o.payment_status = 'paid' OR (o.payment_status = 'refunded' AND f.order_id IS NOT NULL))
        """;
    private static final String ORIGINAL_RECEIPT_ACCESS = """
        (? OR (o.status = 'collected' AND o.payment_status = 'paid' AND EXISTS (
            SELECT 1 FROM operator_order_events e
            WHERE e.order_id = o.id AND e.store_id = o.store_id AND e.operator_id = ?
                AND e.previous_status = 'ready' AND e.requested_status = 'collected' AND e.outcome = 'changed'
        )))
        """;

    record ReceiptOrder(UUID orderId, String status, String receiptStatus, long total, String currency,
                        String receiptReference, String correctionReference, boolean correctionEligible) {}
    record Metadata(String reference, long total) {}
    private record UploadableOrder(ReceiptOrder view, String receiptUrl, String refundId) {}
    private record Attached(String reference, long total, boolean matchesDocument) {}

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;

    OperatorReceipts(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
    }

    List<ReceiptOrder> list(String authorization, String orderCode) {
        if (orderCode == null) return pendingAndRecent(manager(authorization, false).storeId());

        Principal actor = originalReceiptOperator(authorization, false);
        OperatorOrderCode match = OperatorOrderCode.parse(orderCode);
        // Detect a short-code collision in the same snapshot without returning any hidden order.
        return jdbc.sql("""
            WITH candidates AS (
                SELECT o.id FROM orders o LEFT JOIN fiscal_receipts f ON f.order_id = o.id
                WHERE o.store_id = ? AND %s AND %s
            )
            SELECT visible.*, (SELECT count(*) > 1 FROM candidates) AS ambiguous
            FROM (%s JOIN candidates c ON c.id = o.id WHERE %s LIMIT 1) visible
            """.formatted(RECEIPT_QUEUE, match.predicate(), ORDER_FIELDS, ORIGINAL_RECEIPT_ACCESS))
            .params(actor.storeId(), match.parameter(), actor.role().equals("manager"), actor.id())
            .query((row, index) -> {
                if (row.getBoolean("ambiguous")) throw OperatorFailure.conflict("receipt_order_code_ambiguous");
                return view(row, index);
            }).list();
    }

    private List<ReceiptOrder> pendingAndRecent(String storeId) {
        return jdbc.sql(ORDER_FIELDS + """
            LEFT JOIN operator_order_events handoff ON handoff.order_id = o.id AND handoff.store_id = o.store_id
                AND handoff.previous_status = 'ready' AND handoff.requested_status = 'collected' AND handoff.outcome = 'changed'
                AND o.status = 'collected' AND o.receipt_status = 'pending'
            WHERE o.store_id = ? AND
            """ + RECEIPT_QUEUE + """
            ORDER BY CASE WHEN handoff.occurred_at IS NOT NULL THEN 0 WHEN o.receipt_status = 'pending' THEN 1
                WHEN refundable.refund_id IS NOT NULL AND o.receipt_status = 'issued' THEN 2 ELSE 3 END,
                handoff.occurred_at ASC NULLS LAST, o.created_at DESC, o.id
            LIMIT 100
            """).param(storeId).query(OperatorReceipts::view).list();
    }

    void preflight(String authorization, String id, String reference, String total) {
        Principal actor = originalReceiptOperator(authorization, false);
        UUID orderId = orderId(id);
        Metadata metadata = metadata(reference, total);
        UploadableOrder order = uploadable(actor, orderId, false);
        verifyTotal(order, metadata);
    }

    ReceiptOrder attach(String authorization, String id, String reference, String total, byte[] document) {
        UUID orderId = orderId(id);
        Metadata metadata = metadata(reference, total);
        boolean usable = ReceiptPdf.usable(document);
        return Objects.requireNonNull(transactions.execute(tx -> {
            Principal actor = originalReceiptOperator(authorization, true);
            UploadableOrder order = uploadable(actor, orderId, true);
            verifyTotal(order, metadata);
            return attachLocked(actor, order, metadata, document, usable);
        }));
    }

    void preflightCorrection(String authorization, String id, String reference, String total) {
        Principal actor = manager(authorization, false);
        UploadableOrder order = uploadable(actor, orderId(id), false);
        verifyCorrection(order, metadata(reference, total));
    }

    ReceiptOrder attachCorrection(String authorization, String id, String reference, String total, byte[] document) {
        UUID orderId = orderId(id);
        Metadata metadata = metadata(reference, total);
        boolean usable = ReceiptPdf.usable(document);
        return Objects.requireNonNull(transactions.execute(tx -> {
            Principal actor = manager(authorization, true);
            UploadableOrder order = uploadable(actor, orderId, true);
            verifyCorrection(order, metadata);
            Attached existing = jdbc.sql("""
                SELECT reference, refund_total_rwf, document = ? AS matches_document
                FROM fiscal_receipt_corrections WHERE order_id = ?
                """).params(document, orderId)
                .query((row, index) -> new Attached(row.getString("reference"), row.getLong("refund_total_rwf"),
                    row.getBoolean("matches_document"))).optional().orElse(null);
            if (existing != null) {
                if (existing.reference().equals(metadata.reference()) && existing.total() == metadata.total()
                    && existing.matchesDocument()) return order.view();
                throw OperatorFailure.conflict("receipt_correction_already_attached");
            }
            if (!order.view().correctionEligible()) throw OperatorFailure.conflict("receipt_correction_not_available");
            if (!usable) throw ReceiptPdf.invalidPdf();
            int inserted = jdbc.sql("""
                INSERT INTO fiscal_receipt_corrections (order_id, store_id, reference, refund_total_rwf,
                    provider_refund_id, document, attached_by)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
                """).params(orderId, actor.storeId(), metadata.reference(), metadata.total(), order.refundId(),
                    document, actor.id()).update();
            if (inserted != 1) throw OperatorFailure.conflict("receipt_reference_in_use");

            jdbc.sql("UPDATE orders SET receipt_status = 'corrected' WHERE id = ?").param(orderId).update();
            return new ReceiptOrder(orderId, order.view().status(), "corrected", metadata.total(), "RWF",
                order.view().receiptReference(), metadata.reference(), false);
        }));
    }

    private ReceiptOrder attachLocked(Principal actor, UploadableOrder order, Metadata metadata, byte[] document,
                                      boolean usable) {
        UUID orderId = order.view().orderId();
        Attached existing = jdbc.sql("""
            SELECT reference, total_rwf, document = ? AS matches_document FROM fiscal_receipts WHERE order_id = ?
            """).params(document, orderId)
            .query((rs, row) -> new Attached(rs.getString("reference"), rs.getLong("total_rwf"), rs.getBoolean("matches_document")))
            .optional().orElse(null);
        if (existing != null && existing.reference().equals(metadata.reference())
            && existing.total() == metadata.total() && existing.matchesDocument()) return order.view();
        if (existing != null || !order.view().receiptStatus().equals("pending") || order.receiptUrl() != null) {
            throw OperatorFailure.conflict("receipt_already_issued");
        }
        // Keep identical retries for previously issued bytes and validate every new attachment.
        if (!usable) throw ReceiptPdf.invalidPdf();
        int inserted = jdbc.sql("""
            INSERT INTO fiscal_receipts (order_id, store_id, reference, total_rwf, document, attached_by)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
            """).params(orderId, actor.storeId(), metadata.reference(), metadata.total(), document, actor.id()).update();
        if (inserted != 1) throw OperatorFailure.conflict("receipt_reference_in_use");

        jdbc.sql("UPDATE orders SET receipt_status = 'issued', receipt_url = ? WHERE id = ?")
            .params("/api/v1/orders/" + orderId + "/receipt", orderId).update();
        return new ReceiptOrder(orderId, order.view().status(), "issued", metadata.total(), "RWF", metadata.reference(), null, false);
    }

    private UploadableOrder uploadable(Principal actor, UUID id, boolean lock) {
        boolean manager = actor.role().equals("manager");
        if (lock) {
            // Take the order lock before reading joined attachment rows, so a retry sees the winner's commit.
            jdbc.sql("SELECT o.id FROM orders o WHERE o.store_id = ? AND o.id = ? AND "
                    + ORIGINAL_RECEIPT_ACCESS + " FOR UPDATE").params(actor.storeId(), id, manager, actor.id())
                .query(UUID.class).optional().orElseThrow(OperatorFailure::notFound);
        }
        return jdbc.sql(ORDER_FIELDS + """
            WHERE o.store_id = ? AND o.id = ? AND (o.payment_status = 'paid' OR f.order_id IS NOT NULL) AND
            """ + ORIGINAL_RECEIPT_ACCESS)
            .params(actor.storeId(), id, manager, actor.id()).query((rs, row) -> new UploadableOrder(view(rs, row), rs.getString("receipt_url"),
                rs.getString("refund_id")))
            .optional().orElseThrow(OperatorFailure::notFound);
    }

    private static void verifyTotal(UploadableOrder order, Metadata metadata) {
        if (order.view().total() != metadata.total()) throw OperatorFailure.conflict("receipt_total_mismatch");
    }

    private static void verifyCorrection(UploadableOrder order, Metadata metadata) {
        if (order.refundId() == null || !(order.view().correctionEligible() || order.view().correctionReference() != null)) {
            throw OperatorFailure.conflict("receipt_correction_not_available");
        }
        verifyTotal(order, metadata);
        if (metadata.reference().equalsIgnoreCase(order.view().receiptReference())) {
            throw OperatorFailure.conflict("receipt_correction_reference_matches_original");
        }
    }

    private Principal manager(String authorization, boolean lock) {
        Principal actor = sessions.requirePrincipal(authorization, lock);
        if (!actor.role().equals("manager")) throw OperatorFailure.forbidden();
        return actor;
    }

    private Principal originalReceiptOperator(String authorization, boolean lock) {
        Principal actor = sessions.requirePrincipal(authorization, lock);
        if (!actor.role().equals("manager") && !actor.role().equals("pickup")) throw OperatorFailure.forbidden();
        return actor;
    }

    private static Metadata metadata(String reference, String total) {
        if (reference == null || reference.length() > 80 || total == null || !WHOLE_RWF.matcher(total).matches()) {
            throw OperatorFailure.invalid();
        }
        String canonical = reference.strip();
        if (!REFERENCE.matcher(canonical).matches()) throw OperatorFailure.invalid();
        try {
            return new Metadata(canonical, Long.parseLong(total));
        } catch (NumberFormatException ignored) {
            throw OperatorFailure.invalid();
        }
    }

    private static UUID orderId(String value) {
        if (value == null || value.length() != 36) throw OperatorFailure.notFound();
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException ignored) {
            throw OperatorFailure.notFound();
        }
    }

    private static ReceiptOrder view(ResultSet row, int index) throws SQLException {
        String status = row.getString("receipt_status");
        return new ReceiptOrder(row.getObject("id", UUID.class), row.getString("status"),
            status, row.getLong("total"), "RWF", row.getString("reference"), row.getString("correction_reference"),
            "issued".equals(status) && row.getString("refund_id") != null);
    }
}
