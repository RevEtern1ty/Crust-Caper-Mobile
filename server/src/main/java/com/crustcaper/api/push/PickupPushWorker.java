package com.crustcaper.api.push;

import com.crustcaper.api.push.ExpoPushTransport.ReadyAlert;
import com.crustcaper.api.push.ExpoPushTransport.ReceiptStatus;
import com.crustcaper.api.push.ExpoPushTransport.SendResult;
import com.crustcaper.api.push.ExpoPushTransport.SendStatus;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.transaction.support.TransactionTemplate;

final class PickupPushWorker {
    private static final int BATCH = 4;
    private static final int MAX_SENDS = 3;
    static final int MAX_RECEIPTS = 6;
    private static final int FIRST_RECEIPT_SECONDS = 15 * 60;
    private static final int[] SEND_BACKOFF_SECONDS = {30, 120};
    private static final int[] RECEIPT_BACKOFF_SECONDS = {300, 900, 1800, 3600, 7200};

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final PickupPushCipher cipher;
    private final ExpoPushTransport transport;
    private final MeterRegistry meters;

    PickupPushWorker(JdbcClient jdbc, TransactionTemplate transactions, PickupPushCipher cipher,
                     ExpoPushTransport transport, MeterRegistry meters) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.cipher = cipher;
        this.transport = transport;
        this.meters = meters;
    }

    @Scheduled(initialDelayString = "PT2S", fixedDelayString = "PT2S", scheduler = "pickupPushScheduler")
    void poll() {
        for (int index = 0; index < BATCH; index++) {
            Optional<Job> next = claim(Phase.SEND);
            if (next.isEmpty()) break;
            send(next.orElseThrow());
        }
        for (int index = 0; index < BATCH; index++) {
            Optional<Job> next = claim(Phase.RECEIPT);
            if (next.isEmpty()) break;
            receive(next.orElseThrow());
        }
    }

    private Optional<Job> claim(Phase phase) {
        UUID lease = UUID.randomUUID();
        // The standalone statement commits before any provider request. Replicas skip rows already being claimed.
        return jdbc.sql("""
                WITH due AS (
                    SELECT id FROM pickup_alerts
                    WHERE state = ? AND enabled AND next_attempt_at <= clock_timestamp() AND %1$s < ?
                        AND (state <> 'receipt_pending' OR queued_at + interval '24 hours' > clock_timestamp())
                    ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
                )
                UPDATE pickup_alerts a SET state = ?, lease_id = ?, lease_until = clock_timestamp() + interval '30 seconds',
                    %1$s = %1$s + 1, next_attempt_at = NULL, updated_at = clock_timestamp()
                FROM due WHERE a.id = due.id
                RETURNING a.id, a.order_id, a.expo_ticket_id, a.%1$s AS attempts
                """.formatted(phase.counter()))
                .params(phase.queuedState(), phase.attemptLimit(), phase.activeState(), lease)
                .query((rs, row) -> new Job(rs.getObject("id", UUID.class), rs.getObject("order_id", UUID.class), lease,
                        rs.getString("expo_ticket_id"), rs.getInt("attempts"))).optional();
    }

    private void send(Job job) {
        transactions.executeWithoutResult(tx -> {
            // The operator and guest endpoints lock the order before the enrollment. A send owns both until its bounded call returns.
            boolean ready = jdbc.sql("SELECT status = 'ready' AND payment_status = 'paid' FROM orders WHERE id = ? FOR SHARE")
                    .param(job.orderId()).query(Boolean.class).optional().orElse(false);
            Optional<Delivery> active = delivery(job);
            if (active.isEmpty()) return;
            Delivery delivery = active.orElseThrow();
            if (!ready || delivery.secondsLeft() < 1) {
                finish(job, Phase.SEND, "cancelled", null, null, true);
                return;
            }
            String token;
            try {
                token = cipher.decrypt(job.orderId(), delivery.guestId(), delivery.installationId(), delivery.encryptedToken());
            } catch (IllegalStateException ignored) {
                finish(job, Phase.SEND, "failed", null, null, true);
                return;
            }
            SendResult outcome;
            try {
                outcome = transport.send(new ReadyAlert(token, job.orderId(), delivery.locale(), delivery.expiresAt()));
            } catch (RuntimeException ignored) {
                // A provider exception can leave the request's acceptance unknown. Never send this job again.
                outcome = SendResult.of(SendStatus.AMBIGUOUS);
            }
            switch (outcome.status()) {
                case ACCEPTED -> finish(job, Phase.SEND, "receipt_pending", outcome.ticketId(), FIRST_RECEIPT_SECONDS, false);
                case THROTTLED -> {
                    if (job.attempts() < MAX_SENDS) {
                        finish(job, Phase.SEND, "pending", null, SEND_BACKOFF_SECONDS[job.attempts() - 1], false);
                    } else {
                        finish(job, Phase.SEND, "failed", null, null, true);
                    }
                }
                case INVALID_TOKEN, REJECTED -> finish(job, Phase.SEND, "failed", null, null, true);
                case AMBIGUOUS -> finish(job, Phase.SEND, "delivery_unknown", null, null, true);
            }
        });
    }

    private Optional<Delivery> delivery(Job job) {
        return jdbc.sql("""
                SELECT a.guest_session_id, a.installation_id, a.locale, a.encrypted_token,
                    LEAST(o.pickup_ends_at, g.expires_at, a.queued_at + interval '30 minutes') AS expires_at,
                    EXTRACT(EPOCH FROM LEAST(o.pickup_ends_at, g.expires_at, a.queued_at + interval '30 minutes')
                        - clock_timestamp()) AS seconds_left
                FROM pickup_alerts a
                JOIN orders o ON o.id = a.order_id
                JOIN guest_sessions g ON g.id = a.guest_session_id
                WHERE a.id = ? AND a.lease_id = ? AND a.state = 'sending' AND a.enabled AND a.queued_at IS NOT NULL
                    AND a.lease_until > clock_timestamp() + interval '8 seconds'
                FOR UPDATE OF a
                """).params(job.id(), job.lease())
                .query((rs, row) -> new Delivery(rs.getObject("guest_session_id", UUID.class),
                        rs.getObject("installation_id", UUID.class), rs.getString("locale"), rs.getBytes("encrypted_token"),
                        rs.getObject("expires_at", OffsetDateTime.class).toInstant(), rs.getDouble("seconds_left")))
                .optional();
    }

    private void receive(Job job) {
        ReceiptStatus result;
        try {
            result = transport.receipt(job.ticketId());
        } catch (RuntimeException ignored) {
            result = ReceiptStatus.UNAVAILABLE;
        }
        switch (result) {
            case HANDED_OFF -> finish(job, Phase.RECEIPT, "sent", null, null, true);
            case INVALID_TOKEN, REJECTED -> finish(job, Phase.RECEIPT, "failed", null, null, true);
            case PENDING, UNAVAILABLE -> {
                if (job.attempts() < MAX_RECEIPTS) {
                    finish(job, Phase.RECEIPT, "receipt_pending", null, RECEIPT_BACKOFF_SECONDS[job.attempts() - 1], false);
                } else {
                    finish(job, Phase.RECEIPT, "delivery_unknown", null, null, true);
                }
            }
        }
    }

    private void finish(Job job, Phase phase, String state, String ticket, Integer retrySeconds, boolean terminal) {
        int changed = jdbc.sql("""
                UPDATE pickup_alerts SET state = ?, enabled = NOT ?,
                    encrypted_token = CASE WHEN ? THEN NULL ELSE encrypted_token END,
                    expo_ticket_id = COALESCE(?::text, expo_ticket_id),
                    next_attempt_at = clock_timestamp() + ?::integer * interval '1 second',
                    lease_id = NULL, lease_until = NULL, updated_at = clock_timestamp()
                WHERE id = ? AND lease_id = ? AND state = ? AND enabled
                """).params(state, terminal, terminal, ticket, retrySeconds, job.id(), job.lease(), phase.activeState()).update();
        if (changed == 1) meters.counter("crustcaper.push.delivery", "result", state).increment();
    }

    private enum Phase {
        SEND("pending", "sending", "send_attempts", MAX_SENDS),
        RECEIPT("receipt_pending", "verifying_receipt", "receipt_attempts", MAX_RECEIPTS);

        private final String queuedState;
        private final String activeState;
        private final String counter;
        private final int attemptLimit;

        Phase(String queuedState, String activeState, String counter, int attemptLimit) {
            this.queuedState = queuedState;
            this.activeState = activeState;
            this.counter = counter;
            this.attemptLimit = attemptLimit;
        }

        String queuedState() { return queuedState; }
        String activeState() { return activeState; }
        String counter() { return counter; }
        int attemptLimit() { return attemptLimit; }
    }

    private record Job(UUID id, UUID orderId, UUID lease, String ticketId, int attempts) { }

    private record Delivery(UUID guestId, UUID installationId, String locale, byte[] encryptedToken,
                            Instant expiresAt, double secondsLeft) {
        @Override public String toString() { return "Delivery[redacted]"; }
    }
}
