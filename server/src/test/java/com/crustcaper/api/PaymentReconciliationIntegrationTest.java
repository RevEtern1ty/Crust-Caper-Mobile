package com.crustcaper.api;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.crustcaper.api.ApiModels.CartLine;
import com.crustcaper.api.ApiModels.OrderInput;
import com.crustcaper.api.ApiModels.QuoteInput;
import com.crustcaper.api.payment.PaymentGateway;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import com.crustcaper.api.payment.PaymentGatewayException;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest(properties = {
    "spring.datasource.hikari.schema=payment_reconciliation_test",
    "spring.flyway.schemas=payment_reconciliation_test"
})
@ActiveProfiles("local")
class PaymentReconciliationIntegrationTest {
    private static final String SLOT = "reconciliation-slot";

    @Autowired ApplicationContext context;
    @Autowired JdbcClient jdbc;
    @Autowired GuestSessions sessions;
    @Autowired OrderService orders;
    private final PaymentGateway gateway = mock(PaymentGateway.class);
    private final SimpleMeterRegistry meters = new SimpleMeterRegistry();
    private final String store = "reconciliation-" + UUID.randomUUID();
    private UUID guest;

    @BeforeEach
    void prepareStore() {
        guest = sessions.authenticate("Bearer " + sessions.create().accessToken());
        jdbc.sql("""
            INSERT INTO stores (id, name, area, hours, open, tax_basis_points, version)
            SELECT ?, name, area, hours, true, tax_basis_points, 'initial' FROM stores WHERE id = 'kigali'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO menu_products (store_id, sku, position, product)
            SELECT ?, sku, position, product FROM menu_products WHERE store_id = 'kigali' AND sku = 'double-smash'
            """).param(store).update();
        jdbc.sql("""
            INSERT INTO pickup_slots (store_id, id, starts_at, ends_at, capacity)
            VALUES (?, ?, now() + interval '25 minutes', now() + interval '35 minutes', 4)
            """).params(store, SLOT).update();
    }

    @AfterEach
    void cleanup() {
        jdbc.sql("""
            DELETE FROM payment_exceptions WHERE attempt_id IN (
                SELECT p.id FROM payment_attempts p JOIN orders o ON o.id = p.order_id WHERE o.store_id = ?
            )
            """).param(store).update();
        jdbc.sql("DELETE FROM payment_attempts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)")
            .param(store).update();
        for (String table : List.of("orders", "quotes", "pickup_slots", "menu_products")) {
            jdbc.sql("DELETE FROM " + table + " WHERE store_id = ?").param(store).update();
        }
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        if (guest != null) jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update();
        meters.close();
    }

    @Test
    void verifiedPaymentsReachTheKitchenOrTheLatePaymentQueueWithoutACustomerRequest() {
        var onTime = order("on-time");
        var late = order("late");
        jdbc.sql("UPDATE orders SET reservation_expires_at = now() - interval '1 minute' WHERE id = ?")
            .param(late.orderId()).update();
        when(gateway.verifyByReference(onTime.reference())).thenReturn(Optional.of(onTime.paid("12351")));
        when(gateway.verifyByReference(late.reference())).thenReturn(Optional.of(late.paid("12352")));

        worker().poll();
        worker().poll();

        assertThat(orders.getOrder(guest, onTime.orderId()).status()).isEqualTo("accepted");
        assertThat(orders.getOrder(guest, late.orderId()).paymentStatus()).isEqualTo("refund_pending");
        assertThat(jdbc.sql("SELECT reason FROM payment_exceptions WHERE attempt_id = ?")
            .param(late.attemptId()).query(String.class).single()).isEqualTo("unavailable_reservation");
        assertThat(meters.get("crustcaper.payments.reconciliation").tag("result", "verified").counter().count())
            .isEqualTo(2);
        verify(gateway).verifyByReference(onTime.reference());
        verify(gateway).verifyByReference(late.reference());
        assertThat(context.getBeansOfType(PaymentReconciliation.class)).isEmpty();
    }

    @Test
    void aTransientFailureWaitsForTheNextWindowAndNeverConfirmsAnUnrelatedCharge() {
        var unresolved = order("unresolved");
        var outsideWindow = order("old");
        jdbc.sql("UPDATE orders SET reservation_expires_at = now() - interval '49 hours' WHERE id = ?")
            .param(outsideWindow.orderId()).update();
        when(gateway.verifyByReference(unresolved.reference()))
            .thenThrow(new PaymentGatewayException(PaymentGatewayException.Kind.UNAVAILABLE))
            .thenReturn(Optional.of(new VerifiedPayment(UUID.randomUUID().toString(), "12353", unresolved.total(),
                "RWF", PaymentResult.PAID)));

        worker().poll();
        worker().poll();
        verify(gateway).verifyByReference(unresolved.reference());
        assertThat(orders.getOrder(guest, unresolved.orderId()).paymentStatus()).isEqualTo("processing");

        jdbc.sql("UPDATE payment_attempts SET last_checked_at = now() - interval '31 seconds' WHERE id = ?")
            .param(unresolved.attemptId()).update();
        worker().poll();
        verify(gateway, times(2)).verifyByReference(unresolved.reference());
        verify(gateway, never()).verifyByReference(outsideWindow.reference());
        assertThat(orders.getOrder(guest, unresolved.orderId()).paymentStatus()).isEqualTo("processing");
        assertThat(orders.getOrder(guest, outsideWindow.orderId()).paymentStatus()).isEqualTo("processing");
        assertThat(meters.get("crustcaper.payments.reconciliation").tag("result", "rejected").counter().count())
            .isEqualTo(1);
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void aConflictingChargeDoesNotBlockTheNextDuePaymentInTheSamePoll(CapturedOutput output) {
        var recorded = order("recorded");
        var conflicting = order("conflicting");
        var healthy = order("healthy");
        String recordedTransaction = "123560001";
        String healthyTransaction = "123560002";
        orders.settlePayment(recorded.paid(recordedTransaction));
        jdbc.sql("UPDATE payment_attempts SET initiated_at = now() - interval '45 seconds' WHERE id = ?")
            .param(conflicting.attemptId()).update();
        when(gateway.verifyByReference(conflicting.reference())).thenReturn(Optional.of(conflicting.paid(recordedTransaction)));
        when(gateway.verifyByReference(healthy.reference())).thenReturn(Optional.of(healthy.paid(healthyTransaction)));

        worker().poll();

        var calls = inOrder(gateway);
        calls.verify(gateway).verifyByReference(conflicting.reference());
        calls.verify(gateway).verifyByReference(healthy.reference());
        calls.verifyNoMoreInteractions();
        assertThat(jdbc.sql("SELECT id FROM payment_attempts WHERE provider_transaction_id = ?")
            .param(recordedTransaction).query(UUID.class).single()).isEqualTo(recorded.attemptId());
        var unresolved = orders.getOrder(guest, conflicting.orderId());
        assertThat(unresolved.status()).isEqualTo("awaiting_payment");
        assertThat(unresolved.paymentStatus()).isEqualTo("processing");
        assertThat(unresolved.paymentAttempt().id()).isEqualTo(conflicting.attemptId());
        assertThat(jdbc.sql("""
            SELECT count(*) FROM payment_attempts WHERE id = ? AND status = 'processing'
                AND provider_transaction_id IS NULL AND last_checked_at IS NOT NULL
            """).param(conflicting.attemptId()).query(Long.class).single()).isEqualTo(1);
        assertThat(jdbc.sql("SELECT id FROM payment_attempts WHERE provider_transaction_id = ? AND status = 'paid'")
            .param(healthyTransaction).query(UUID.class).single()).isEqualTo(healthy.attemptId());
        assertThat(jdbc.sql("SELECT id FROM orders WHERE store_id = ? AND status = 'accepted' AND payment_status = 'paid'")
            .param(store).query(UUID.class).list()).containsExactlyInAnyOrder(recorded.orderId(), healthy.orderId());
        assertThat(meters.get("crustcaper.payments.reconciliation").tag("result", "settlement_error").counter().count())
            .isEqualTo(1);
        assertThat(meters.get("crustcaper.payments.reconciliation").tag("result", "verified").counter().count()).isEqualTo(1);
        assertThat(output.getAll().lines().filter(line -> line.contains("payment_reconciliation_settlement_failed")).toList())
            .hasSize(1);
        assertThat(output.getAll()).doesNotContain(recordedTransaction, healthyTransaction, conflicting.reference(),
            conflicting.orderId().toString(), "payment_attempts_provider_transaction_id_key");
    }

    @Test
    void parallelWorkersDoNotMakeTwoProviderCallsForTheSameAttempt() throws Exception {
        var ready = order("parallel");
        var duringCall = new CountDownLatch(1);
        var releaseCall = new CountDownLatch(1);
        when(gateway.verifyByReference(ready.reference())).thenAnswer(invocation -> {
            duringCall.countDown();
            if (!releaseCall.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Test call timed out");
            return Optional.of(ready.paid("12354"));
        });

        try (var workers = Executors.newFixedThreadPool(2)) {
            var first = workers.submit(() -> worker().poll());
            try {
                assertThat(duringCall.await(5, TimeUnit.SECONDS)).isTrue();
                workers.submit(() -> worker().poll()).get(5, TimeUnit.SECONDS);
                verify(gateway).verifyByReference(ready.reference());
            } finally {
                releaseCall.countDown();
            }
            first.get(5, TimeUnit.SECONDS);
        }
        assertThat(orders.getOrder(guest, ready.orderId()).paymentStatus()).isEqualTo("paid");
    }

    private PaymentReconciliation worker() {
        return new PaymentReconciliation(jdbc, gateway, orders, meters);
    }

    private Pending order(String key) {
        var quote = orders.createQuote(guest, new QuoteInput(store, SLOT,
            List.of(new CartLine("double-smash", List.of(), 1, 9_200))));
        var order = orders.createOrder(guest, key,
            new OrderInput(quote.quoteId().toString(), "+250700000000", "fixture@example.test"));
        var attempt = orders.startPayment(guest, order.id(), key);
        jdbc.sql("UPDATE payment_attempts SET initiated_at = now() - interval '31 seconds' WHERE id = ?")
            .param(attempt.id()).update();
        return new Pending(order.id(), attempt.id(), order.total());
    }

    private record Pending(UUID orderId, UUID attemptId, long total) {
        String reference() { return attemptId.toString(); }

        VerifiedPayment paid(String transaction) {
            return new VerifiedPayment(reference(), transaction, total, "RWF", PaymentResult.PAID);
        }
    }
}
