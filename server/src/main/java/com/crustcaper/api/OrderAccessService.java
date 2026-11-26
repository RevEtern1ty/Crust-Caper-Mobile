package com.crustcaper.api;

import com.crustcaper.api.recovery.PhoneVerificationException;
import com.crustcaper.api.recovery.PhoneVerificationGateway;
import com.crustcaper.api.recovery.PhoneVerificationGateway.VerificationCheck;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class OrderAccessService {
    private static final Pattern ORDER_CODE = Pattern.compile("#?[0-9A-Fa-f]{8}");
    private static final Pattern PHONE = Pattern.compile("\\+[1-9][0-9]{7,14}");
    private static final Pattern VERIFICATION_CODE = Pattern.compile("[0-9]{6}");
    private static final Pattern PROVIDER_REFERENCE = Pattern.compile("VE[0-9a-fA-F]{32}");
    private static final int MAX_CHALLENGES = 3;
    private static final int MAX_ATTEMPTS = 5;
    private static final int MAX_QUEUED = 120;
    private static final int DISPATCH_BATCH = 4;

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final ObjectProvider<PhoneVerificationGateway> gateways;

    record ChallengeReceipt(UUID challengeId) {}
    record VerifiedOrder(UUID orderId) {}
    private record Pending(UUID id, String orderCode, byte[] phoneDigest, UUID checkoutOrder) {}
    private record Candidate(UUID orderId, String phone) {
        @Override
        public String toString() { return "RecoveryCandidate[redacted]"; }
    }
    private record Delivery(UUID challengeId, String phone) {
        @Override
        public String toString() { return "RecoveryDelivery[redacted]"; }
    }
    private record Verification(UUID orderId, String providerReference, int attempts, String state, boolean checkoutRecovery) {
        @Override
        public String toString() { return "RecoveryVerification[redacted]"; }
    }

    OrderAccessService(JdbcClient jdbc, TransactionTemplate transactions, ObjectProvider<PhoneVerificationGateway> gateways) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.gateways = gateways;
    }

    ChallengeReceipt start(UUID guest, String orderCode, String phone) {
        requireGateway();
        validatePhone(phone);
        if (orderCode == null || !ORDER_CODE.matcher(orderCode).matches()) throw ApiFailure.invalid();
        String reference = orderCode.substring(orderCode.length() - 8).toLowerCase(Locale.ROOT);
        return enqueue(guest, reference, null, phone);
    }

    ChallengeReceipt startCheckoutRecovery(UUID guest, UUID orderId, String phone) {
        requireGateway();
        validatePhone(phone);
        return enqueue(guest, null, orderId, phone);
    }

    static void validatePhone(String phone) {
        if (phone == null || !PHONE.matcher(phone).matches()) throw ApiFailure.invalid();
    }

    private ChallengeReceipt enqueue(UUID guest, String reference, UUID checkoutOrder, String phone) {
        UUID challenge = UUID.randomUUID();
        UUID acknowledged = transactions.execute(tx -> {
            jdbc.sql("""
                WITH locked_guest AS MATERIALIZED (
                    SELECT id, expires_at FROM guest_sessions WHERE id = ? FOR UPDATE
                )
                SELECT id FROM locked_guest WHERE expires_at > clock_timestamp()
                """)
                .param(guest).query(UUID.class).optional().orElseThrow(ApiFailure::unauthenticated);
            if (checkoutOrder != null) {
                UUID sent = findCheckoutChallenge(guest, checkoutOrder, phone);
                if (sent != null) return sent;
            }
            long recent = jdbc.sql("""
                SELECT count(*) FROM order_access_challenges
                WHERE guest_session_id = ? AND created_at > clock_timestamp() - interval '10 minutes'
                """).param(guest).query(Long.class).single();
            if (recent < MAX_CHALLENGES && queueHasRoom()) {
                // The worker validates the contact and sends the challenge asynchronously.
                jdbc.sql("""
                    INSERT INTO order_access_challenges
                        (id, guest_session_id, order_code, phone_digest, order_id, checkout_recovery, state, expires_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'queued', clock_timestamp() + interval '10 minutes')
                    """).params(challenge, guest, reference, digest(challenge, phone), checkoutOrder, checkoutOrder != null).update();
            }
            return challenge;
        });
        return new ChallengeReceipt(acknowledged);
    }

    private UUID findCheckoutChallenge(UUID guest, UUID order, String phone) {
        return jdbc.sql("""
            SELECT id, phone_digest FROM order_access_challenges
            WHERE guest_session_id = ? AND checkout_recovery AND order_id = ? AND expires_at > clock_timestamp()
            ORDER BY created_at DESC LIMIT ?
            """).params(guest, order, MAX_CHALLENGES)
            .query((rs, row) -> {
                UUID id = rs.getObject("id", UUID.class);
                return MessageDigest.isEqual(rs.getBytes("phone_digest"), digest(id, phone)) ? id : null;
            }).list().stream().filter(Objects::nonNull).findFirst().orElse(null);
    }

    private boolean queueHasRoom() {
        jdbc.sql("SELECT pg_advisory_xact_lock(hashtextextended('crustcaper:order-access:queue', 0))")
            .query((rs, row) -> 1).single();
        long queued = jdbc.sql("""
            SELECT count(*) FROM order_access_challenges c
            WHERE c.state = 'queued' AND c.expires_at > clock_timestamp()
              AND EXISTS (SELECT FROM guest_sessions g WHERE g.id = c.guest_session_id AND g.expires_at > clock_timestamp())
            """).query(Long.class).single();
        return queued < MAX_QUEUED;
    }

    VerifiedOrder verify(UUID guest, UUID challenge, String code) {
        PhoneVerificationGateway gateway = requireGateway();
        if (code == null || !VERIFICATION_CODE.matcher(code).matches()) throw ApiFailure.invalid();
        Verification claimed = Objects.requireNonNull(transactions.execute(tx -> claimVerification(guest, challenge)));
        if (claimed.state().equals("verified")) return new VerifiedOrder(claimed.orderId());

        VerificationCheck check;
        try {
            check = gateway.check(claimed.providerReference(), code);
        } catch (PhoneVerificationException ignored) {
            // The provider may have consumed the OTP. Never grant access from an uncertain result.
            finishUnsuccessfulVerification(challenge, claimed, false);
            throw ApiFailure.notFound();
        }
        if (check != VerificationCheck.APPROVED) {
            finishUnsuccessfulVerification(challenge, claimed, check == VerificationCheck.EXPIRED);
            throw ApiFailure.notFound();
        }
        return Objects.requireNonNull(transactions.execute(tx -> grant(guest, challenge, claimed)));
    }

    private Verification claimVerification(UUID guest, UUID challenge) {
        Verification stored = jdbc.sql("""
            SELECT order_id, provider_reference, attempts, state, checkout_recovery FROM order_access_challenges
            WHERE id = ? AND guest_session_id = ?
              AND (state = 'verified' OR expires_at > clock_timestamp())
            FOR UPDATE
            """).params(challenge, guest)
            .query((rs, row) -> new Verification(rs.getObject("order_id", UUID.class), rs.getString("provider_reference"),
                rs.getInt("attempts"), rs.getString("state"), rs.getBoolean("checkout_recovery")))
            .optional().orElseThrow(ApiFailure::notFound);
        if (stored.state().equals("verified")) return stored;
        if (!stored.state().equals("sent") || stored.attempts() >= MAX_ATTEMPTS || stored.providerReference() == null) {
            throw ApiFailure.notFound();
        }
        jdbc.sql("UPDATE order_access_challenges SET attempts = attempts + 1, state = 'checking' WHERE id = ?")
            .param(challenge).update();
        return new Verification(stored.orderId(), stored.providerReference(), stored.attempts() + 1, "checking",
            stored.checkoutRecovery());
    }

    private void finishUnsuccessfulVerification(UUID challenge, Verification claimed, boolean expired) {
        jdbc.sql("""
            UPDATE order_access_challenges SET state = ?
            WHERE id = ? AND state = 'checking' AND attempts = ?
            """).params(expired || claimed.attempts() >= MAX_ATTEMPTS ? "closed" : "sent", challenge, claimed.attempts())
            .update();
    }

    private VerifiedOrder grant(UUID guest, UUID challenge, Verification claimed) {
        int completed = jdbc.sql("""
            UPDATE order_access_challenges c SET state = 'verified'
            WHERE c.id = ? AND c.guest_session_id = ? AND c.order_id = ? AND c.provider_reference = ?
                AND c.attempts = ? AND c.state = 'checking' AND c.expires_at > clock_timestamp()
                AND EXISTS (SELECT FROM guest_sessions g WHERE g.id = c.guest_session_id AND g.expires_at > clock_timestamp())
            """).params(challenge, guest, claimed.orderId(), claimed.providerReference(), claimed.attempts()).update();
        if (completed != 1) throw ApiFailure.notFound();

        if (claimed.checkoutRecovery()) {
            int changed = jdbc.sql("""
                UPDATE orders SET web_checkout_guest_session_id = ?
                WHERE id = ? AND checkout_channel = 'web'
                """).params(guest, claimed.orderId()).update();
            if (changed != 1) throw ApiFailure.notFound();
        }
        jdbc.sql("""
            INSERT INTO order_read_grants (guest_session_id, order_id) VALUES (?, ?)
            ON CONFLICT (guest_session_id, order_id) DO NOTHING
            """).params(guest, claimed.orderId()).update();
        return new VerifiedOrder(claimed.orderId());
    }

    void dispatch() {
        PhoneVerificationGateway gateway = gateways.getIfAvailable();
        if (gateway == null) return;
        jdbc.sql("""
            DELETE FROM order_access_challenges WHERE id IN (
                SELECT id FROM order_access_challenges WHERE expires_at < clock_timestamp() - interval '1 day' LIMIT 100
            )
            """).update();
        for (int index = 0; index < DISPATCH_BATCH; index++) {
            Delivery delivery = transactions.execute(tx -> claimDelivery());
            if (delivery == null) break;
            if (delivery.phone() == null) continue;
            try {
                String reference = gateway.send(delivery.phone());
                if (reference == null || !PROVIDER_REFERENCE.matcher(reference).matches()) {
                    close(delivery.challengeId());
                    continue;
                }
                jdbc.sql("""
                    UPDATE order_access_challenges SET provider_reference = ?, state = 'sent'
                    WHERE id = ? AND state = 'sending' AND expires_at > clock_timestamp()
                    """).params(reference, delivery.challengeId()).update();
            } catch (PhoneVerificationException | DataIntegrityViolationException ignored) {
                // Do not send again after an unknown delivery or bind a reference to more than one challenge.
                close(delivery.challengeId());
            }
        }
    }

    private Delivery claimDelivery() {
        Pending next = jdbc.sql("""
            SELECT c.id, c.order_code, c.phone_digest, CASE WHEN c.checkout_recovery THEN c.order_id END AS checkout_order
            FROM order_access_challenges c
            WHERE c.state = 'queued' AND c.expires_at > clock_timestamp()
              AND EXISTS (SELECT FROM guest_sessions g WHERE g.id = c.guest_session_id AND g.expires_at > clock_timestamp())
            ORDER BY c.created_at, c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED
            """).query((rs, row) -> new Pending(rs.getObject("id", UUID.class), rs.getString("order_code"),
                rs.getBytes("phone_digest"), rs.getObject("checkout_order", UUID.class))).optional().orElse(null);
        if (next == null) return null;
        List<Candidate> matches = (next.checkoutOrder() == null
            ? jdbc.sql("SELECT id, phone FROM orders WHERE right(id::text, 8) = ? LIMIT 2").param(next.orderCode())
            : jdbc.sql("SELECT id, phone FROM orders WHERE id = ? AND checkout_channel = 'web'").param(next.checkoutOrder()))
                .query((rs, row) -> new Candidate(rs.getObject("id", UUID.class), rs.getString("phone"))).list();
        if (matches.size() != 1
            || !MessageDigest.isEqual(next.phoneDigest(), digest(next.id(), matches.getFirst().phone()))) {
            close(next.id());
            return new Delivery(next.id(), null);
        }
        Candidate recipient = matches.getFirst();
        // Twilio can reuse a code during its validity, even across different challenge requests.
        jdbc.sql("SELECT pg_advisory_xact_lock(hashtextextended('crustcaper:order-access:' || ?, 0))")
            .param(recipient.phone()).query((rs, row) -> 1).single();
        boolean duringCooldown = jdbc.sql("""
            SELECT EXISTS (
                SELECT FROM order_access_challenges c JOIN orders o ON o.id = c.order_id
                WHERE o.phone = ? AND c.reserved_at > clock_timestamp() - interval '11 minutes'
            )
            """).param(recipient.phone()).query(Boolean.class).single();
        if (duringCooldown) {
            close(next.id());
            return new Delivery(next.id(), null);
        }
        jdbc.sql("""
            UPDATE order_access_challenges SET state = 'sending', order_id = ?, reserved_at = clock_timestamp()
            WHERE id = ?
            """).params(recipient.orderId(), next.id()).update();
        return new Delivery(next.id(), recipient.phone());
    }

    private void close(UUID challenge) {
        jdbc.sql("UPDATE order_access_challenges SET state = 'closed' WHERE id = ?").param(challenge).update();
    }

    private PhoneVerificationGateway requireGateway() {
        PhoneVerificationGateway gateway = gateways.getIfAvailable();
        if (gateway == null) throw ApiFailure.unavailable();
        return gateway;
    }

    private static byte[] digest(UUID challenge, String phone) {
        try {
            return MessageDigest.getInstance("SHA-256")
                .digest((challenge + ":" + phone).getBytes(StandardCharsets.US_ASCII));
        } catch (NoSuchAlgorithmException ignored) {
            throw new IllegalStateException("SHA-256 is unavailable");
        }
    }
}
