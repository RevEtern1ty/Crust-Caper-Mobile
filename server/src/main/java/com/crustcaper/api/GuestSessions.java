package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.GuestSession;
import static com.crustcaper.api.Catalog.dbTime;
import static com.crustcaper.api.Catalog.readTime;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class GuestSessions {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final String ROTATION_DOMAIN = "crustcaper.guest-refresh.rotation.v1:";
    private final JdbcClient jdbc;
    private final Duration accessTtl;
    private final Duration refreshTtl;

    private record Identity(UUID id, Instant refreshExpiresAt) {}
    private record RefreshProof(String presentedHash, String successor, String successorHash) {}
    private record LockedIdentity(Identity guest, boolean matchesPresented) {}

    GuestSessions(JdbcClient jdbc, @Value("${crustcaper.guest.access-ttl:PT20M}") Duration accessTtl,
                  @Value("${crustcaper.guest.refresh-ttl:P90D}") Duration refreshTtl) {
        if (accessTtl.isZero() || accessTtl.isNegative() || refreshTtl.compareTo(accessTtl) < 0) {
            throw new IllegalArgumentException("Invalid guest access or refresh lifetime");
        }
        this.jdbc = jdbc;
        this.accessTtl = accessTtl;
        this.refreshTtl = refreshTtl;
    }

    @Transactional
    GuestSession create() {
        String refresh = token();
        Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        Identity guest = new Identity(UUID.randomUUID(), now.plus(refreshTtl));
        jdbc.sql("""
            INSERT INTO guest_sessions (id, refresh_token_hash, expires_at) VALUES (?, ?, ?)
            """)
            .params(guest.id(), hash(refresh), dbTime(guest.refreshExpiresAt()))
            .update();
        return issueAccess(guest, refresh, now);
    }

    @Transactional
    GuestSession refresh(String refresh, String rotationKey) {
        RefreshProof proof = refreshProof(refresh, rotationKey, ApiFailure.unauthenticated());
        LockedIdentity locked = lockGuest(proof).orElseThrow(ApiFailure::unauthenticated);
        Identity guest = locked.guest();
        if (proof.successor() != null && locked.matchesPresented()) {
            jdbc.sql("UPDATE guest_sessions SET refresh_token_hash = ? WHERE id = ?")
                .params(proof.successorHash(), guest.id()).update();
        }
        jdbc.sql("DELETE FROM guest_access_tokens WHERE guest_session_id = ? AND expires_at <= clock_timestamp()")
            .param(guest.id()).update();
        String next = proof.successor() == null ? refresh : proof.successor();
        return issueAccess(guest, next, Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    @Transactional
    void revoke(String refresh, String rotationKey) {
        RefreshProof proof = refreshProof(refresh, rotationKey, ApiFailure.invalid());
        lockGuest(proof).ifPresent(locked -> {
            UUID id = locked.guest().id();
            jdbc.sql("""
                UPDATE guest_sessions SET expires_at = LEAST(expires_at, clock_timestamp()),
                    token_hash = NULL, refresh_token_hash = NULL WHERE id = ?
                """).param(id).update();
            jdbc.sql("DELETE FROM guest_access_tokens WHERE guest_session_id = ?").param(id).update();
        });
    }

    private Optional<LockedIdentity> lockGuest(RefreshProof proof) {
        // A retry can prove possession of the current successor without preserving the old hash.
        return jdbc.sql("""
            SELECT id, expires_at, refresh_token_hash = ? AS matches_presented FROM guest_sessions
            WHERE refresh_token_hash IN (?, ?) AND expires_at > clock_timestamp() FOR UPDATE
            """)
            .params(proof.presentedHash(), proof.presentedHash(), proof.successorHash())
            .query((rs, row) -> new LockedIdentity(new Identity(rs.getObject("id", UUID.class), readTime(rs, "expires_at")),
                rs.getBoolean("matches_presented"))).optional();
    }

    private static RefreshProof refreshProof(String refresh, String rotationKey, ApiFailure invalidToken) {
        if (!validToken(refresh)) throw invalidToken;
        String presentedHash = hash(refresh);
        if (rotationKey == null) return new RefreshProof(presentedHash, null, presentedHash);
        UUID key = ApiFailure.uuid(rotationKey, ApiFailure.invalid());
        if (!key.toString().equalsIgnoreCase(rotationKey)) throw ApiFailure.invalid();
        String successor = rotate(refresh, key);
        return new RefreshProof(presentedHash, successor, hash(successor));
    }

    UUID authenticate(String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) throw ApiFailure.unauthenticated();
        String token = authorization.substring("Bearer ".length());
        if (!validToken(token)) throw ApiFailure.unauthenticated();
        String secretHash = hash(token);
        return jdbc.sql("""
            SELECT g.id FROM guest_access_tokens a JOIN guest_sessions g ON g.id = a.guest_session_id
              WHERE a.token_hash = ? AND a.expires_at > now() AND g.expires_at > now()
            UNION
            SELECT id FROM guest_sessions WHERE token_hash = ? AND expires_at > now()
            """)
            .params(secretHash, secretHash)
            .query(UUID.class)
            .optional()
            .orElseThrow(ApiFailure::unauthenticated);
    }

    private GuestSession issueAccess(Identity guest, String refresh, Instant now) {
        Instant accessDeadline = now.plus(accessTtl);
        Instant expiry = accessDeadline.isBefore(guest.refreshExpiresAt()) ? accessDeadline : guest.refreshExpiresAt();
        String access = token();
        jdbc.sql("""
            INSERT INTO guest_access_tokens (token_hash, guest_session_id, expires_at) VALUES (?, ?, ?)
            """).params(hash(access), guest.id(), dbTime(expiry)).update();
        return new GuestSession(access, expiry, refresh, guest.refreshExpiresAt(), guest.id());
    }

    static boolean validToken(String token) {
        return token != null && TOKEN.matcher(token).matches();
    }

    static String token() {
        byte[] entropy = new byte[32];
        RANDOM.nextBytes(entropy);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(entropy);
    }

    private static String rotate(String refresh, UUID rotationKey) {
        try {
            Mac hmac = Mac.getInstance("HmacSHA256");
            hmac.init(new SecretKeySpec(refresh.getBytes(StandardCharsets.US_ASCII), "HmacSHA256"));
            byte[] successor = hmac.doFinal((ROTATION_DOMAIN + rotationKey).getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(successor);
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("HMAC-SHA256 is unavailable", ex);
        }
    }

    static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
