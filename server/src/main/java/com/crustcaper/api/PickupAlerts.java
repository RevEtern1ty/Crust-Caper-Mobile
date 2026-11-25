package com.crustcaper.api;

import com.crustcaper.api.push.PickupPushCipher;
import java.util.Objects;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class PickupAlerts {
    private static final int MAX_INSTALLATIONS_PER_GUEST = 4;
    private static final int MAX_INSTALLATIONS_PER_ORDER = 12;
    private static final String DEVICE_SCOPE = " WHERE order_id = ? AND guest_session_id = ? AND installation_id = ?";
    private final JdbcClient jdbc;
    private final OrderService orders;
    private final TransactionTemplate transactions;
    private final ObjectProvider<PickupPushCipher> ciphers;

    record Status(boolean enabled, boolean available) {}
    record Input(String token, String locale) {
        @Override
        public String toString() { return "PickupAlertInput[redacted]"; }
    }
    private record Registrations(long order, long guest, boolean known) {}

    PickupAlerts(JdbcClient jdbc, OrderService orders, TransactionTemplate transactions,
                 ObjectProvider<PickupPushCipher> ciphers) {
        this.jdbc = jdbc;
        this.orders = orders;
        this.transactions = transactions;
        this.ciphers = ciphers;
    }

    Status get(UUID guest, UUID order, UUID installation) {
        orders.pickupAlertOrder(guest, order, false);
        boolean enabled = jdbc.sql("SELECT enabled FROM pickup_alerts" + DEVICE_SCOPE)
            .params(order, guest, installation).query(Boolean.class).optional().orElse(false);
        return new Status(enabled, ciphers.getIfAvailable() != null);
    }

    Status enroll(UUID guest, UUID order, UUID installation, Input input) {
        if (input == null || !PickupPushCipher.validToken(input.token())
            || (!"en".equals(input.locale()) && !"rw".equals(input.locale()))) throw ApiFailure.invalid();
        return Objects.requireNonNull(transactions.execute(tx -> {
            // Kitchen READY and delivery coordinate with enrollment and revocation on this order row.
            OrderService.PickupAlertOrder target = orders.pickupAlertOrder(guest, order, true);
            PickupPushCipher cipher = ciphers.getIfAvailable();
            if (cipher == null) throw ApiFailure.unavailable();
            if (!target.allowsEnrollment()) throw ApiFailure.conflict("pickup_alert_unavailable");
            enforceLimit(guest, order, installation);
            byte[] token = cipher.encrypt(order, guest, installation, input.token());
            int changed = jdbc.sql("""
                INSERT INTO pickup_alerts (id, order_id, guest_session_id, installation_id, locale, encrypted_token, enabled, state)
                VALUES (?, ?, ?, ?, ?, ?, true, 'waiting')
                ON CONFLICT (order_id, guest_session_id, installation_id) DO UPDATE
                SET locale = excluded.locale, encrypted_token = excluded.encrypted_token, enabled = true,
                    state = 'waiting', updated_at = clock_timestamp()
                WHERE pickup_alerts.queued_at IS NULL AND pickup_alerts.state IN ('waiting', 'cancelled')
                """).params(UUID.randomUUID(), order, guest, installation, input.locale(), token).update();
            if (changed != 1) throw ApiFailure.conflict("pickup_alert_unavailable");
            return new Status(true, true);
        }));
    }

    void revoke(UUID guest, UUID order, UUID installation) {
        transactions.executeWithoutResult(tx -> {
            orders.pickupAlertOrder(guest, order, true);
            jdbc.sql("""
                UPDATE pickup_alerts SET
                    enabled = false, encrypted_token = NULL, expo_ticket_id = NULL,
                    lease_id = NULL, lease_until = NULL, next_attempt_at = NULL,
                    state = CASE WHEN state IN ('sent', 'failed', 'delivery_unknown') THEN state ELSE 'cancelled' END,
                    updated_at = clock_timestamp()
                """ + DEVICE_SCOPE + " AND enabled")
                .params(order, guest, installation).update();
        });
    }

    private void enforceLimit(UUID guest, UUID order, UUID installation) {
        Registrations registered = jdbc.sql("""
            SELECT count(*) AS total,
                count(*) FILTER (WHERE guest_session_id = ?) AS guest_total,
                count(*) FILTER (WHERE guest_session_id = ? AND installation_id = ?) > 0 AS known
            FROM pickup_alerts WHERE order_id = ?
            """).params(guest, guest, installation, order)
            .query((rs, row) -> new Registrations(rs.getLong("total"), rs.getLong("guest_total"), rs.getBoolean("known")))
            .single();
        if (!registered.known()
            && (registered.order() >= MAX_INSTALLATIONS_PER_ORDER || registered.guest() >= MAX_INSTALLATIONS_PER_GUEST)) {
            throw ApiFailure.conflict("pickup_alert_limit");
        }
    }
}
