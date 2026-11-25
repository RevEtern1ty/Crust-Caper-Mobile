package com.crustcaper.api;

import static com.crustcaper.api.ApiModels.GuestSession;
import static com.crustcaper.api.Catalog.dbTime;
import static com.crustcaper.api.Catalog.readTime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class GuestSessions {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private final JdbcClient jdbc;
    private final Duration accessTtl;
    private final Duration refreshTtl;

    private record Identity(UUID id, Instant refreshExpiresAt) {}

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
    GuestSession refresh(String refresh) {
        if (refresh == null || !TOKEN.matcher(refresh).matches()) throw ApiFailure.unauthenticated();
        Identity guest = jdbc.sql("""
            SELECT id, expires_at FROM guest_sessions WHERE refresh_token_hash = ? AND expires_at > now()
            """)
            .param(hash(refresh))
            .query((rs, row) -> new Identity(rs.getObject("id", UUID.class), readTime(rs, "expires_at")))
            .optional().orElseThrow(ApiFailure::unauthenticated);
        jdbc.sql("DELETE FROM guest_access_tokens WHERE guest_session_id = ? AND expires_at <= now()")
            .param(guest.id()).update();
        return issueAccess(guest, refresh, Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }

    UUID authenticate(String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) throw ApiFailure.unauthenticated();
        String token = authorization.substring("Bearer ".length());
        if (!TOKEN.matcher(token).matches()) throw ApiFailure.unauthenticated();
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
        return new GuestSession(access, expiry, refresh, guest.refreshExpiresAt());
    }

    private static String token() {
        byte[] entropy = new byte[32];
        RANDOM.nextBytes(entropy);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(entropy);
    }

    private static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
