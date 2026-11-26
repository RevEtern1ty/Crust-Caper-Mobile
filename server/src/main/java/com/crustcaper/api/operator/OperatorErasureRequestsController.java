package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorSessions.Principal;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/operator/erasure-requests")
final class OperatorErasureRequestsController {
    private static final String FIELDS = "id, order_id, submitted_at, status, reviewed_at";

    record Request(UUID requestId, UUID orderId, Instant submittedAt, String status,
                   @JsonInclude(JsonInclude.Include.ALWAYS) Instant reviewedAt) {}

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;
    private final TransactionTemplate transactions;

    OperatorErasureRequestsController(JdbcClient jdbc, OperatorSessions sessions, TransactionTemplate transactions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.transactions = transactions;
    }

    @GetMapping
    ResponseEntity<List<Request>> list(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @RequestParam(required = false) String status) {
        List<Request> rows = Objects.requireNonNull(transactions.execute(tx -> {
            Principal actor = manager(bearer);
            String filter = status == null ? "pending" : status;
            if (!filter.equals("pending") && !filter.equals("in_review")) throw OperatorFailure.invalid();
            return jdbc.sql("SELECT " + FIELDS + """
                 FROM order_erasure_requests
                 WHERE store_id = ? AND status = ?
                 ORDER BY submitted_at, id
                """).params(actor.storeId(), filter).query(OperatorErasureRequestsController::requestRow).list();
        }));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(rows);
    }

    @PostMapping("/{requestId}/review")
    ResponseEntity<Request> review(@RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String bearer,
        @PathVariable String requestId) {
        Request row = Objects.requireNonNull(transactions.execute(tx -> {
            Principal actor = manager(bearer);
            UUID id = requestId(requestId);
            return jdbc.sql("""
                UPDATE order_erasure_requests
                SET status = 'in_review', reviewed_at = clock_timestamp(), reviewed_by = ?
                WHERE id = ? AND store_id = ? AND status = 'pending'
                RETURNING
                """ + FIELDS).params(actor.id(), id, actor.storeId()).query(OperatorErasureRequestsController::requestRow)
                .optional().orElseGet(() -> jdbc.sql("SELECT " + FIELDS + " FROM order_erasure_requests WHERE id = ? AND store_id = ?")
                    .params(id, actor.storeId()).query(OperatorErasureRequestsController::requestRow).optional()
                    .orElseThrow(OperatorFailure::notFound));
        }));
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(row);
    }

    private Principal manager(String bearer) {
        Principal actor = sessions.requirePrincipal(bearer, true);
        if (!actor.role().equals("manager")) throw OperatorFailure.forbidden();
        return actor;
    }

    private static Request requestRow(ResultSet rs, int row) throws SQLException {
        OffsetDateTime reviewed = rs.getObject("reviewed_at", OffsetDateTime.class);
        return new Request(rs.getObject("id", UUID.class), rs.getObject("order_id", UUID.class),
            rs.getObject("submitted_at", OffsetDateTime.class).toInstant(), rs.getString("status"),
            reviewed == null ? null : reviewed.toInstant());
    }

    private static UUID requestId(String value) {
        if (value.length() != 36) throw OperatorFailure.notFound();
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException ignored) {
            throw OperatorFailure.notFound();
        }
    }
}
