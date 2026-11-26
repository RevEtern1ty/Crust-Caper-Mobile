package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.CURRENCY;
import static com.crustcaper.api.Catalog.readTime;

import com.crustcaper.api.ApiModels.CartLine;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;

@Service
final class OrderPrivacyService {
    private static final TypeReference<List<CartLine>> CART_LINES = new TypeReference<>() {};
    private static final String FRESH_ORDER = """
        FROM orders o JOIN order_read_grants g ON g.order_id = o.id
        WHERE o.id = :order AND g.guest_session_id = :guest
          AND g.privacy_verified_at > clock_timestamp() - interval '10 minutes'
          AND g.privacy_verified_at <= clock_timestamp()
        """;

    record DataExport(UUID orderId, String storeId, String phone, @JsonInclude(JsonInclude.Include.ALWAYS) String email,
                      List<CartLine> lines, long total, long tax, String currency, String status, String paymentStatus,
                      String receiptStatus, Instant createdAt, Instant pickupStartsAt, Instant pickupEndsAt) {
        @Override
        public String toString() { return "OrderDataExport[redacted]"; }
    }

    record ErasureRequest(UUID requestId, Instant submittedAt, String status,
                           @JsonInclude(JsonInclude.Include.ALWAYS) Instant reviewedAt) {}

    record ErasureStatus(@JsonInclude(JsonInclude.Include.ALWAYS) ErasureRequest request) {}

    private final JdbcClient jdbc;
    private final CommerceJson json;
    private final TransactionTemplate transactions;

    OrderPrivacyService(JdbcClient jdbc, CommerceJson json, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.json = json;
        this.transactions = transactions;
    }

    DataExport export(UUID guest, String id) {
        UUID order = ApiFailure.uuid(id, ApiFailure.notFound());
        return Objects.requireNonNull(transactions.execute(tx -> {
            lockActiveGuest(guest);
            return jdbc.sql("""
                SELECT o.id, o.store_id, o.phone, o.email, o.lines, o.total, o.tax,
                    CASE WHEN o.status = 'awaiting_payment' AND o.reservation_expires_at <= clock_timestamp()
                        THEN 'cancelled' ELSE o.status END AS status,
                    o.payment_status, o.receipt_status, o.created_at, o.pickup_starts_at, o.pickup_ends_at
                """ + FRESH_ORDER).param("order", order).param("guest", guest)
                .query((rs, row) -> new DataExport(rs.getObject("id", UUID.class), rs.getString("store_id"),
                    rs.getString("phone"), rs.getString("email"), json.read(rs.getString("lines"), CART_LINES),
                    rs.getLong("total"), rs.getLong("tax"), CURRENCY, rs.getString("status"), rs.getString("payment_status"),
                    rs.getString("receipt_status"), readTime(rs, "created_at"), readTime(rs, "pickup_starts_at"),
                    readTime(rs, "pickup_ends_at"))).optional().orElseThrow(ApiFailure::notFound);
        }));
    }

    ErasureStatus erasure(UUID guest, String id, boolean submit) {
        UUID order = ApiFailure.uuid(id, ApiFailure.notFound());
        return Objects.requireNonNull(transactions.execute(tx -> {
            lockActiveGuest(guest);
            String store = jdbc.sql("SELECT o.store_id " + FRESH_ORDER).param("order", order).param("guest", guest)
                .query(String.class).optional().orElseThrow(ApiFailure::notFound);
            if (submit) {
                jdbc.sql("""
                    INSERT INTO order_erasure_requests (id, order_id, store_id) VALUES (?, ?, ?)
                    ON CONFLICT (order_id) DO NOTHING
                    """).params(UUID.randomUUID(), order, store).update();
            }
            return new ErasureStatus(jdbc.sql("""
                SELECT id, submitted_at, status, reviewed_at FROM order_erasure_requests WHERE order_id = ? AND store_id = ?
                """).params(order, store).query((rs, row) -> {
                    OffsetDateTime reviewed = rs.getObject("reviewed_at", OffsetDateTime.class);
                    return new ErasureRequest(rs.getObject("id", UUID.class), readTime(rs, "submitted_at"),
                        rs.getString("status"), reviewed == null ? null : reviewed.toInstant());
                }).optional().orElse(null));
        }));
    }

    private void lockActiveGuest(UUID guest) {
        // Native and web revocation both update the guest row. The shared lock orders those writes with this operation.
        jdbc.sql("SELECT id FROM guest_sessions WHERE id = ? AND expires_at > clock_timestamp() FOR SHARE")
            .param(guest).query(UUID.class).optional().orElseThrow(ApiFailure::notFound);
    }
}
