package com.crustcaper.api.operator;

import java.time.Instant;
import java.time.OffsetDateTime;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class OperatorOperationsController {
    private static final int PAYMENT_HANDOFF_SECONDS = 60;
    private static final int FISCAL_RECEIPT_MINUTES = 30;
    // The live kitchen queue in OperatorOrders reads the same order rows.
    private static final String SIGNALS = """
        SELECT statement_timestamp() AS observed_at,
               (SELECT count(*) FROM orders o
                WHERE o.store_id = :store AND o.status <> 'collected'
                  AND o.payment_status NOT IN ('refund_pending', 'refunded')
                  AND NOT (o.payment_status = 'paid' AND o.status IN ('accepted', 'preparing', 'ready'))
                  AND EXISTS (
                      SELECT FROM payment_attempts p
                      WHERE p.order_id = o.id AND p.status = 'paid'
                        AND p.verified_at < statement_timestamp() - make_interval(secs => :payment_seconds)
                        AND p.provider_transaction_id IS NOT NULL
                        AND NOT EXISTS (
                            SELECT FROM payment_exceptions e
                            WHERE e.attempt_id = p.id AND e.provider_transaction_id = p.provider_transaction_id
                        )
                  )) AS payment_without_kitchen,
               (SELECT count(*) FROM orders o
                WHERE o.store_id = :store AND o.status = 'collected'
                  AND o.payment_status = 'paid' AND o.receipt_status = 'pending'
                  AND EXISTS (
                      SELECT FROM operator_order_events e
                      WHERE e.order_id = o.id AND e.store_id = o.store_id
                        AND e.requested_status = 'collected' AND e.outcome = 'changed'
                        AND e.occurred_at < statement_timestamp() - make_interval(mins => :receipt_minutes)
                  )
                  AND NOT EXISTS (SELECT FROM fiscal_receipts f WHERE f.order_id = o.id)
               ) AS fiscal_receipts_overdue
        """;

    record Signals(Instant observedAt, long paymentWithoutKitchen, long fiscalReceiptsOverdue,
                   int fiscalReceiptOverdueAfterMinutes) {}

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;

    OperatorOperationsController(JdbcClient jdbc, OperatorSessions sessions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
    }

    @GetMapping("/api/v1/operator/operations/signals")
    ResponseEntity<Signals> signals(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        var actor = sessions.requirePrincipal(authorization, false);
        if (!actor.role().equals("manager")) throw OperatorFailure.forbidden();
        Signals snapshot = jdbc.sql(SIGNALS).param("store", actor.storeId())
                .param("payment_seconds", PAYMENT_HANDOFF_SECONDS).param("receipt_minutes", FISCAL_RECEIPT_MINUTES)
                .query((row, index) -> new Signals(row.getObject("observed_at", OffsetDateTime.class).toInstant(),
                        row.getLong("payment_without_kitchen"), row.getLong("fiscal_receipts_overdue"),
                        FISCAL_RECEIPT_MINUTES))
                .single();
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(snapshot);
    }
}
