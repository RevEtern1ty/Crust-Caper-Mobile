package com.crustcaper.api;

import static com.crustcaper.api.OrderService.AUTOMATIC_RECONCILIATION_WINDOW_HOURS;

import com.crustcaper.api.PaymentReconciliationMetrics.Result;
import com.crustcaper.api.payment.PaymentGateway;
import com.crustcaper.api.payment.PaymentGateway.PaymentResult;
import com.crustcaper.api.payment.PaymentGateway.VerifiedPayment;
import com.crustcaper.api.payment.PaymentGatewayException;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.transaction.TransactionException;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(name = "crustcaper.payment.provider", havingValue = "flutterwave")
@ConditionalOnProperty(name = "crustcaper.payment.reconciliation.enabled", havingValue = "true", matchIfMissing = true)
class PaymentReconciliationConfiguration {
    @Bean
    PaymentReconciliation paymentReconciliation(JdbcClient jdbc, PaymentGateway gateway, OrderService orders,
                                                MeterRegistry meters, PaymentReconciliationMetrics telemetry) {
        return new PaymentReconciliation(jdbc, gateway, orders, meters, telemetry);
    }

    @Bean
    ThreadPoolTaskScheduler paymentReconciliationScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        scheduler.setThreadNamePrefix("crustcaper-payment-");
        return scheduler;
    }
}

final class PaymentReconciliation {
    private static final int MAX_ATTEMPTS_PER_RUN = 2;
    private static final Logger LOG = LoggerFactory.getLogger(PaymentReconciliation.class);

    private final JdbcClient jdbc;
    private final PaymentGateway gateway;
    private final OrderService orders;
    private final MeterRegistry meters;
    private final PaymentReconciliationMetrics telemetry;

    PaymentReconciliation(JdbcClient jdbc, PaymentGateway gateway, OrderService orders, MeterRegistry meters,
                          PaymentReconciliationMetrics telemetry) {
        this.jdbc = jdbc;
        this.gateway = gateway;
        this.orders = orders;
        this.meters = meters;
        this.telemetry = telemetry;
        telemetry.enable();
    }

    @Scheduled(initialDelayString = "PT15S", fixedDelayString = "PT15S", scheduler = "paymentReconciliationScheduler")
    void poll() {
        try {
            for (int remaining = MAX_ATTEMPTS_PER_RUN; remaining > 0; remaining--) {
                // Give an expiring hold the first check and keep the remaining budget in standard due order.
                Optional<UUID> attempt = remaining == MAX_ATTEMPTS_PER_RUN
                    ? claim(true).or(() -> claim(false)) : claim(false);
                if (attempt.isEmpty()) break;
                verify(attempt.get());
            }
        } catch (RuntimeException failure) {
            telemetry.abortSweep();
            throw failure;
        }
        telemetry.completeSweep();
    }

    private Optional<UUID> claim(boolean liveHoldsOnly) {
        // Commit the claim before contacting the provider. The customer status route uses the same check timestamp.
        String liveHoldFilter = liveHoldsOnly ? "AND o.status = 'awaiting_payment' AND o.reservation_expires_at > now()" : "";
        String expiryOrder = liveHoldsOnly ? "o.reservation_expires_at, " : "";
        return jdbc.sql("""
            WITH due AS (
                SELECT p.id FROM payment_attempts p JOIN orders o ON o.id = p.order_id
                WHERE p.status = 'processing'
                  AND p.initiated_at < now() - interval '30 seconds'
                  AND o.reservation_expires_at > now() - make_interval(hours => ?)
                  AND (p.last_checked_at IS NULL OR p.last_checked_at < now() - CASE
                      WHEN o.reservation_expires_at > now() THEN interval '30 seconds'
                      WHEN o.reservation_expires_at > now() - interval '15 minutes' THEN interval '2 minutes'
                      WHEN o.reservation_expires_at > now() - interval '2 hours' THEN interval '15 minutes'
                      ELSE interval '1 hour' END)
                  %s
                ORDER BY %sp.last_checked_at ASC NULLS FIRST, p.initiated_at, p.id
                LIMIT 1 FOR UPDATE OF p SKIP LOCKED
            )
            UPDATE payment_attempts p SET last_checked_at = now()
            FROM due WHERE p.id = due.id RETURNING p.id
            """.formatted(liveHoldFilter, expiryOrder))
            .param(AUTOMATIC_RECONCILIATION_WINDOW_HOURS).query(UUID.class).optional();
    }

    private void verify(UUID attempt) {
        String reference = attempt.toString();
        try {
            var result = gateway.verifyByReference(reference);
            if (result.isEmpty() || result.get().result() != PaymentResult.PAID) {
                count(Result.PENDING);
                return;
            }
            var payment = result.get();
            if (!reference.equals(payment.reference())) {
                count(Result.REJECTED);
                return;
            }
            settle(payment);
        } catch (PaymentGatewayException error) {
            count(Result.PROVIDER_ERROR);
        } catch (ApiFailure error) {
            count(Result.REJECTED);
        }
    }

    private void settle(VerifiedPayment payment) {
        try {
            orders.settlePayment(payment);
        } catch (DataAccessException | TransactionException failure) {
            // Keep the committed claim and let the next due attempt use the remaining poll budget.
            LOG.warn("payment_reconciliation_settlement_failed");
            count(Result.SETTLEMENT_ERROR);
            return;
        }
        count(Result.CONFIRMED);
    }

    private void count(Result result) {
        meters.counter("crustcaper.payments.reconciliation", "result", result.meterTag).increment();
        telemetry.record(result);
    }
}
