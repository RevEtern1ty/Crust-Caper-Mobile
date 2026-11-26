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
        SELECT o.id, o.status, o.receipt_status, o.receipt_url, o.total, f.reference
        FROM orders o LEFT JOIN fiscal_receipts f ON f.order_id = o.id
        """;

    record ReceiptOrder(UUID orderId, String status, String receiptStatus, long total, String currency, String receiptReference) {}
    record Metadata(String reference, long total) {}
    private record UploadableOrder(ReceiptOrder view, String receiptUrl) {}
    private record Attached(String reference, long total, boolean matchesDocument) {}

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;

    OperatorReceipts(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
    }

    List<ReceiptOrder> pendingAndRecent(String authorization) {
        Principal actor = manager(authorization, false);
        return jdbc.sql(ORDER_FIELDS + """
            LEFT JOIN operator_order_events handoff ON handoff.order_id = o.id AND handoff.store_id = o.store_id
                AND handoff.previous_status = 'ready' AND handoff.requested_status = 'collected' AND handoff.outcome = 'changed'
                AND o.status = 'collected' AND o.receipt_status = 'pending'
            WHERE o.store_id = ? AND o.payment_status = 'paid'
            ORDER BY CASE WHEN handoff.occurred_at IS NOT NULL THEN 0 WHEN o.receipt_status = 'pending' THEN 1 ELSE 2 END,
                handoff.occurred_at ASC NULLS LAST, o.created_at DESC, o.id
            LIMIT 100
            """).param(actor.storeId()).query(OperatorReceipts::view).list();
    }

    void preflight(String authorization, String id, String reference, String total) {
        Principal actor = manager(authorization, false);
        UUID orderId = orderId(id);
        Metadata metadata = metadata(reference, total);
        UploadableOrder order = uploadable(actor.storeId(), orderId, false);
        verifyTotal(order, metadata);
    }

    ReceiptOrder attach(String authorization, String id, String reference, String total, byte[] document) {
        UUID orderId = orderId(id);
        Metadata metadata = metadata(reference, total);
        return Objects.requireNonNull(transactions.execute(tx -> {
            Principal actor = manager(authorization, true);
            UploadableOrder order = uploadable(actor.storeId(), orderId, true);
            verifyTotal(order, metadata);
            return attachLocked(actor, order, metadata, document);
        }));
    }

    private ReceiptOrder attachLocked(Principal actor, UploadableOrder order, Metadata metadata, byte[] document) {
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
        int inserted = jdbc.sql("""
            INSERT INTO fiscal_receipts (order_id, store_id, reference, total_rwf, document, attached_by)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
            """).params(orderId, actor.storeId(), metadata.reference(), metadata.total(), document, actor.id()).update();
        if (inserted != 1) throw OperatorFailure.conflict("receipt_reference_in_use");

        jdbc.sql("UPDATE orders SET receipt_status = 'issued', receipt_url = ? WHERE id = ?")
            .params("/api/v1/orders/" + orderId + "/receipt", orderId).update();
        return new ReceiptOrder(orderId, order.view().status(), "issued", metadata.total(), "RWF", metadata.reference());
    }

    private UploadableOrder uploadable(String store, UUID id, boolean lock) {
        return jdbc.sql(ORDER_FIELDS + """
            WHERE o.store_id = ? AND o.id = ? AND (o.payment_status = 'paid' OR f.order_id IS NOT NULL)
            """ + (lock ? " FOR UPDATE OF o" : ""))
            .params(store, id).query((rs, row) -> new UploadableOrder(view(rs, row), rs.getString("receipt_url")))
            .optional().orElseThrow(OperatorFailure::notFound);
    }

    private static void verifyTotal(UploadableOrder order, Metadata metadata) {
        if (order.view().total() != metadata.total()) throw OperatorFailure.conflict("receipt_total_mismatch");
    }

    private Principal manager(String authorization, boolean lock) {
        Principal actor = sessions.requirePrincipal(authorization, lock);
        if (!actor.role().equals("manager")) throw OperatorFailure.forbidden();
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
        return new ReceiptOrder(row.getObject("id", UUID.class), row.getString("status"),
            row.getString("receipt_status"), row.getLong("total"), "RWF", row.getString("reference"));
    }
}
