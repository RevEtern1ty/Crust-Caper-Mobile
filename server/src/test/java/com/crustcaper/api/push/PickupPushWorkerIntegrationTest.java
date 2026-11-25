package com.crustcaper.api.push;

import static com.crustcaper.api.push.ExpoPushTransport.SendStatus.AMBIGUOUS;
import static com.crustcaper.api.push.ExpoPushTransport.SendStatus.THROTTLED;
import static org.assertj.core.api.Assertions.assertThat;

import com.crustcaper.api.push.ExpoPushTransport.ReadyAlert;
import com.crustcaper.api.push.ExpoPushTransport.ReceiptStatus;
import com.crustcaper.api.push.ExpoPushTransport.SendResult;
import com.crustcaper.api.push.ExpoPushTransport.SendStatus;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest(properties = "crustcaper.push.provider=disabled")
@ActiveProfiles("local")
class PickupPushWorkerIntegrationTest {
    private static final String DEVICE_TOKEN = "ExponentPushToken[fixture-device]";
    private static final String TICKET = "12345678-1234-4abc-9234-1234567890ab";

    @Autowired JdbcClient jdbc;
    @Autowired TransactionTemplate transactions;

    private final PickupPushCipher cipher = new PickupPushCipher(Base64.getEncoder().encodeToString(new byte[32]));
    private final SimpleMeterRegistry metrics = new SimpleMeterRegistry();
    private final Stub transport = new Stub();
    private PickupPushWorker worker;
    private PickupPushMaintenance maintenance;
    private String store;

    @BeforeEach
    void createStore() {
        store = "pickup-worker-it-" + UUID.randomUUID();
        jdbc.sql("INSERT INTO stores(id,name,area,hours,open,tax_basis_points,version) VALUES (?, '{}', '{}', '{}', true, 0, 'fixture')")
                .param(store).update();
        worker = new PickupPushWorker(jdbc, transactions, cipher, transport, metrics);
        maintenance = new PickupPushMaintenance(jdbc);
    }

    @AfterEach
    void discardFixture() {
        jdbc.sql("DELETE FROM pickup_alerts WHERE order_id IN (SELECT id FROM orders WHERE store_id = ?)").param(store).update();
        jdbc.sql("DELETE FROM orders WHERE store_id = ?").param(store).update();
        for (UUID guest : jdbc.sql("DELETE FROM quotes WHERE store_id = ? RETURNING guest_session_id").param(store).query(UUID.class).list()) {
            jdbc.sql("DELETE FROM guest_sessions WHERE id = ?").param(guest).update();
        }
        jdbc.sql("DELETE FROM pickup_slots WHERE store_id = ?").param(store).update();
        jdbc.sql("DELETE FROM stores WHERE id = ?").param(store).update();
        metrics.close();
    }

    @Test
    void persistsAcceptedTicketBeforePollingAndRecordsOnlyReceiptHandoffAsSent() {
        Fixture fixture = seed("pending");
        worker.poll();

        assertThat(transport.sends.get()).isEqualTo(1);
        assertThat(transport.receipts.get()).isZero();
        assertThat(transport.lastAlert.get().token()).isEqualTo(DEVICE_TOKEN);
        assertThat(transport.lastAlert.get().orderId()).isEqualTo(fixture.order());
        assertThat(transport.lastAlert.get().locale()).isEqualTo("rw");
        assertThat(current(fixture)).isEqualTo(new State("receipt_pending", 1, 0, true, TICKET));

        due(fixture);
        worker.poll();
        worker.poll();
        assertThat(current(fixture)).isEqualTo(new State("sent", 1, 1, false, TICKET));
        assertThat(transport.sends.get()).isEqualTo(1);
        assertThat(transport.receipts.get()).isEqualTo(1);
    }

    @Test
    void reschedulesOnlyConfirmedThrottlesAndStopsAtTheSendLimit() {
        Fixture fixture = seed("pending");
        transport.send = ignored -> SendResult.of(THROTTLED);
        worker.poll();
        worker.poll();
        assertThat(transport.sends.get()).isEqualTo(1);
        assertThat(current(fixture).name()).isEqualTo("pending");
        due(fixture);
        worker.poll();
        due(fixture);
        worker.poll();
        worker.poll();
        assertThat(transport.sends.get()).isEqualTo(3);
        assertThat(current(fixture)).isEqualTo(new State("failed", 3, 0, false, null));
    }

    @Test
    void neverResendsAnAmbiguousRequestOrADeadWorkersSendLease() {
        Fixture ambiguous = seed("pending");
        Fixture abandoned = seed("sending");
        makeLeaseStale(abandoned, "sending", 0, null);
        transport.send = ignored -> SendResult.of(AMBIGUOUS);

        maintenance.sweep();
        worker.poll();
        maintenance.sweep();
        worker.poll();

        assertThat(transport.sends.get()).isEqualTo(1);
        assertThat(current(ambiguous)).isEqualTo(new State("delivery_unknown", 1, 0, false, null));
        assertThat(current(abandoned)).isEqualTo(new State("delivery_unknown", 1, 0, false, null));
    }

    @Test
    void recoversAnAbandonedReceiptLeaseAndErasesAnInvalidDestination() {
        Fixture fixture = seed("verifying_receipt");
        makeLeaseStale(fixture, "verifying_receipt", 1, TICKET);
        transport.receipt = ReceiptStatus.INVALID_TOKEN;

        maintenance.sweep();
        worker.poll();

        assertThat(current(fixture)).isEqualTo(new State("failed", 1, 2, false, TICKET));
        assertThat(transport.receipts.get()).isEqualTo(1);
        assertThat(transport.sends.get()).isZero();
    }

    @Test
    void expiresWithoutProviderCallsAndSweepsTerminalMetadataIndependently() {
        Fixture expiredPickup = seed("pending");
        Fixture expiredQueue = seed("pending");
        Fixture expiredGuest = seed("waiting");
        Fixture expiredReceipt = seed("receipt_pending");
        jdbc.sql("UPDATE orders SET pickup_ends_at = clock_timestamp() - interval '1 second' WHERE id = ?")
                .param(expiredPickup.order()).update();
        jdbc.sql("UPDATE pickup_alerts SET queued_at = clock_timestamp() - interval '31 minutes' WHERE id = ?")
                .param(expiredQueue.alert()).update();
        jdbc.sql("UPDATE guest_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ?")
                .param(expiredGuest.guest()).update();
        jdbc.sql("UPDATE pickup_alerts SET queued_at = clock_timestamp() - interval '25 hours', expo_ticket_id = ? WHERE id = ?")
                .params(TICKET, expiredReceipt.alert()).update();

        maintenance.sweep();
        worker.poll();

        assertThat(transport.sends.get()).isZero();
        assertThat(transport.receipts.get()).isZero();
        for (Fixture expired : new Fixture[] {expiredPickup, expiredQueue, expiredGuest}) {
            assertThat(current(expired)).isEqualTo(new State("cancelled", 0, 0, false, null));
        }
        assertThat(current(expiredReceipt)).isEqualTo(new State("delivery_unknown", 0, 0, false, TICKET));
        jdbc.sql("UPDATE pickup_alerts SET updated_at = clock_timestamp() - interval '25 hours' WHERE id = ?")
                .param(expiredPickup.alert()).update();
        maintenance.sweep();
        assertThat(jdbc.sql("SELECT id FROM pickup_alerts WHERE id = ?").param(expiredPickup.alert()).query(UUID.class).optional()).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void rechecksCommittedCollectionOrRevocationAfterAClaim(boolean collect) throws Exception {
        Fixture fixture = seed("pending");
        try (var pool = Executors.newSingleThreadExecutor()) {
            var delivery = transactions.execute(tx -> {
                jdbc.sql("SELECT id FROM orders WHERE id = ? FOR UPDATE").param(fixture.order()).query(UUID.class).single();
                var task = pool.submit(worker::poll);
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
                while (!"sending".equals(current(fixture).name()) && System.nanoTime() < deadline) {
                    Thread.yield();
                }
                assertThat(current(fixture).name()).isEqualTo("sending");
                if (collect) {
                    jdbc.sql("UPDATE orders SET status = 'collected' WHERE id = ?").param(fixture.order()).update();
                } else {
                    jdbc.sql("""
                            UPDATE pickup_alerts SET state = 'cancelled', enabled = false, encrypted_token = NULL,
                                lease_id = NULL, lease_until = NULL WHERE id = ?
                            """).param(fixture.alert()).update();
                }
                return task;
            });
            delivery.get(5, TimeUnit.SECONDS);
        }
        assertThat(transport.sends.get()).isZero();
        assertThat(current(fixture)).isEqualTo(new State("cancelled", 1, 0, false, null));
    }

    @Test
    void concurrentReplicasClaimOneSendAndCannotRaceTheLease() throws Exception {
        Fixture fixture = seed("pending");
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        transport.send = ignored -> {
            started.countDown();
            try {
                if (release.await(5, TimeUnit.SECONDS)) return new SendResult(SendStatus.ACCEPTED, TICKET);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return SendResult.of(AMBIGUOUS);
        };
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(worker::poll);
            try {
                assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                var replica = new PickupPushWorker(jdbc, transactions, cipher, transport, metrics);
                pool.submit(replica::poll).get(2, TimeUnit.SECONDS);
                assertThat(transport.sends.get()).isEqualTo(1);
            } finally {
                release.countDown();
            }
            first.get(5, TimeUnit.SECONDS);
        }
        assertThat(current(fixture)).isEqualTo(new State("receipt_pending", 1, 0, true, TICKET));
    }

    private Fixture seed(String state) {
        UUID order = UUID.randomUUID();
        UUID guest = UUID.randomUUID();
        UUID quote = UUID.randomUUID();
        UUID installation = UUID.randomUUID();
        UUID alert = UUID.randomUUID();
        OffsetDateTime now = jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single();
        String slot = "slot-" + order;
        jdbc.sql("INSERT INTO guest_sessions (id, token_hash, expires_at) VALUES (?, ?, ?)")
                .params(guest, guest.toString(), now.plusHours(1)).update();
        jdbc.sql("INSERT INTO pickup_slots (store_id,id,starts_at,ends_at,capacity) VALUES (?,?,?,?,4)")
                .params(store, slot, now, now.plusMinutes(20)).update();
        jdbc.sql("""
                INSERT INTO quotes (id,guest_session_id,store_id,slot_id,pickup_starts_at,pickup_ends_at,lines,total,tax,expires_at)
                VALUES (?,?,?,?,?,?, '[]', 9700, 0, ?)
                """).params(quote, guest, store, slot, now, now.plusMinutes(20), now.plusMinutes(5)).update();
        jdbc.sql("""
                INSERT INTO orders (id,quote_id,guest_session_id,request_key,store_id,slot_id,phone,lines,total,tax,
                    status,payment_status,created_at,reservation_expires_at,pickup_starts_at,pickup_ends_at)
                VALUES (?,?,?,?,?,?, '+250700000000','[]',9700,0,'ready','paid',?,?,?,?)
                """).params(order, quote, guest, order.toString(), store, slot, now, now.plusMinutes(5), now, now.plusMinutes(20)).update();
        jdbc.sql("""
                INSERT INTO pickup_alerts (id,order_id,guest_session_id,installation_id,locale,encrypted_token,enabled,state,queued_at,next_attempt_at)
                VALUES (?,?,?,?, 'rw', ?, true, ?, ?,clock_timestamp())
                """).params(alert, order, guest, installation, cipher.encrypt(order, guest, installation, DEVICE_TOKEN),
                        state, state.equals("waiting") ? null : now).update();
        return new Fixture(order, guest, alert);
    }

    private void due(Fixture fixture) {
        jdbc.sql("UPDATE pickup_alerts SET next_attempt_at = clock_timestamp() WHERE id = ?").param(fixture.alert()).update();
    }

    private void makeLeaseStale(Fixture fixture, String state, int receiptAttempts, String ticket) {
        jdbc.sql("""
                UPDATE pickup_alerts SET state = ?, send_attempts = 1, receipt_attempts = ?, expo_ticket_id = ?,
                    lease_id = ?, lease_until = clock_timestamp() - interval '1 second' WHERE id = ?
                """).params(state, receiptAttempts, ticket, UUID.randomUUID(), fixture.alert()).update();
    }

    private State current(Fixture fixture) {
        return jdbc.sql("SELECT state, send_attempts, receipt_attempts, encrypted_token IS NOT NULL, expo_ticket_id FROM pickup_alerts WHERE id = ?")
                .param(fixture.alert()).query((row, number) -> new State(row.getString(1), row.getInt(2), row.getInt(3),
                        row.getBoolean(4), row.getString(5))).single();
    }

    private record Fixture(UUID order, UUID guest, UUID alert) { }
    private record State(String name, int sendAttempts, int receiptAttempts, boolean encrypted, String ticket) { }

    private static final class Stub implements ExpoPushTransport {
        private final AtomicInteger sends = new AtomicInteger();
        private final AtomicInteger receipts = new AtomicInteger();
        private final AtomicReference<ReadyAlert> lastAlert = new AtomicReference<>();
        private volatile Function<ReadyAlert, SendResult> send = ignored -> new SendResult(SendStatus.ACCEPTED, TICKET);
        private volatile ReceiptStatus receipt = ReceiptStatus.HANDED_OFF;

        @Override
        public SendResult send(ReadyAlert alert) {
            sends.incrementAndGet();
            lastAlert.set(alert);
            return send.apply(alert);
        }

        @Override
        public ReceiptStatus receipt(String ticketId) {
            assertThat(ticketId).isEqualTo(TICKET);
            receipts.incrementAndGet();
            return receipt;
        }
    }
}
