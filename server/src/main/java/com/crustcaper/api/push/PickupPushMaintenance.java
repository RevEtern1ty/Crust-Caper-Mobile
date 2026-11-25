package com.crustcaper.api.push;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration(proxyBeanMethods = false)
@Profile("(stage | prod | production) & !local")
class PickupPushMaintenanceConfiguration {
    @Bean
    PickupPushMaintenance pickupPushMaintenance(JdbcClient jdbc) {
        return new PickupPushMaintenance(jdbc);
    }

    @Bean
    ThreadPoolTaskScheduler pickupPushMaintenanceScheduler() {
        var scheduler = new ThreadPoolTaskScheduler();
        scheduler.setThreadNamePrefix("crustcaper-push-maintenance-");
        return scheduler;
    }
}

final class PickupPushMaintenance {
    private final JdbcClient jdbc;

    PickupPushMaintenance(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Scheduled(initialDelayString = "PT10S", fixedDelayString = "PT10S", scheduler = "pickupPushMaintenanceScheduler")
    void sweep() {
        // A lost send claim may already have reached Expo. Receipt claims query an existing ticket and are safe to reclaim.
        jdbc.sql("""
                WITH due AS (
                    SELECT id, state = 'verifying_receipt' AND enabled AND receipt_attempts < ?
                        AND queued_at + interval '24 hours' > clock_timestamp() AS retry
                    FROM pickup_alerts WHERE state IN ('sending', 'verifying_receipt') AND lease_until <= clock_timestamp()
                    ORDER BY lease_until, id LIMIT 32 FOR UPDATE SKIP LOCKED
                )
                UPDATE pickup_alerts a SET state = CASE WHEN due.retry THEN 'receipt_pending' ELSE 'delivery_unknown' END,
                    enabled = COALESCE(due.retry, false), encrypted_token = CASE WHEN due.retry THEN encrypted_token END,
                    next_attempt_at = CASE WHEN due.retry THEN clock_timestamp() END,
                    lease_id = NULL, lease_until = NULL, updated_at = clock_timestamp()
                FROM due WHERE a.id = due.id
                """).param(PickupPushWorker.MAX_RECEIPTS).update();
        jdbc.sql("""
                WITH due AS (
                    SELECT a.id, a.state = 'receipt_pending' AS receipt
                    FROM pickup_alerts a JOIN orders o ON o.id = a.order_id JOIN guest_sessions g ON g.id = a.guest_session_id
                    WHERE (a.state IN ('waiting', 'pending') AND (NOT a.enabled OR o.payment_status <> 'paid'
                        OR o.status IN ('collected', 'cancelled') OR o.pickup_ends_at <= clock_timestamp()
                        OR g.expires_at <= clock_timestamp()
                        OR (a.state = 'pending' AND (a.queued_at IS NULL
                            OR a.queued_at + interval '30 minutes' <= clock_timestamp()))))
                        OR (a.state = 'receipt_pending' AND (a.queued_at IS NULL
                            OR a.queued_at + interval '24 hours' <= clock_timestamp()))
                    ORDER BY a.updated_at, a.id LIMIT 32 FOR UPDATE OF a SKIP LOCKED
                )
                UPDATE pickup_alerts a SET state = CASE WHEN due.receipt THEN 'delivery_unknown' ELSE 'cancelled' END,
                    encrypted_token = NULL, enabled = false, next_attempt_at = NULL, updated_at = clock_timestamp()
                FROM due WHERE a.id = due.id
                """).update();
        jdbc.sql("""
                DELETE FROM pickup_alerts WHERE id IN (
                    SELECT id FROM pickup_alerts WHERE state IN ('sent', 'cancelled', 'failed', 'delivery_unknown')
                        AND updated_at < clock_timestamp() - interval '24 hours'
                    ORDER BY updated_at, id LIMIT 32 FOR UPDATE SKIP LOCKED
                )
                """).update();
    }
}
