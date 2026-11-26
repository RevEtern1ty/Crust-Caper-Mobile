package com.crustcaper.api;

import static com.crustcaper.api.Catalog.dbTime;
import static com.crustcaper.api.Catalog.readTime;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class WebGuestSessions {
    static final String CONTEXT_HEADER = "X-CrustCaper-Session";
    private static final String WRITE_HEADER = "X-CrustCaper-Web";
    private static final String COOKIE = "__Host-crustcaper-web";
    private static final Duration LIFETIME = Duration.ofDays(90);

    record Session(UUID sessionId, Instant expiresAt) {}
    record Issued(Session session, ResponseCookie cookie) {
        @Override
        public String toString() { return "WebGuestSession[redacted]"; }
    }

    private final JdbcClient jdbc;
    private final String origin;

    WebGuestSessions(JdbcClient jdbc, @Value("${crustcaper.web.origin:}") String origin) {
        this.jdbc = jdbc;
        this.origin = WebOrigin.parse(origin);
    }

    Session current(HttpServletRequest request) {
        requireEnabled();
        Session active = lookup(tokenHash(request), false);
        if (active == null) throw ApiFailure.unauthenticated();
        return active;
    }

    @Transactional
    Issued open(HttpServletRequest request) {
        requireWrite(request);
        Session active = lookup(tokenHash(request), false);
        if (request.getHeader(CONTEXT_HEADER) != null) requireContext(request, active);
        if (active != null) return new Issued(active, null);

        String token = GuestSessions.token();
        Session session = new Session(UUID.randomUUID(), Instant.now().truncatedTo(ChronoUnit.MILLIS).plus(LIFETIME));
        jdbc.sql("INSERT INTO guest_sessions (id, web_token_hash, expires_at) VALUES (?, ?, ?)")
            .params(session.sessionId(), GuestSessions.hash(token), dbTime(session.expiresAt())).update();
        return new Issued(session, cookie(token, LIFETIME));
    }

    @Transactional
    ResponseCookie revoke(HttpServletRequest request) {
        requireWrite(request);
        UUID context = context(request);
        Session active = lookup(tokenHash(request), true);
        // A repeated logout must not clear a cookie issued after that request was sent.
        if (active == null) return null;
        if (!active.sessionId().equals(context)) throw ApiFailure.unauthenticated();
        jdbc.sql("""
            UPDATE guest_sessions SET expires_at = LEAST(expires_at, clock_timestamp()), web_token_hash = NULL
            WHERE id = ?
            """).param(context).update();
        return cookie("", Duration.ZERO);
    }

    UUID authenticate(HttpServletRequest request) {
        return requireContext(request, current(request));
    }

    UUID authenticateWrite(HttpServletRequest request) {
        requireWrite(request);
        return authenticate(request);
    }

    private void requireEnabled() {
        if (origin == null) throw ApiFailure.notFound();
    }

    private void requireWrite(HttpServletRequest request) {
        requireEnabled();
        if (!origin.equals(singleHeader(request, HttpHeaders.ORIGIN)) || !"1".equals(singleHeader(request, WRITE_HEADER))) {
            throw ApiFailure.forbidden();
        }
    }

    private Session lookup(String hash, boolean lock) {
        if (hash == null) return null;
        return jdbc.sql("""
            SELECT id, expires_at FROM guest_sessions WHERE web_token_hash = ? AND expires_at > clock_timestamp()
            """ + (lock ? " FOR UPDATE" : "")).param(hash)
            .query((row, index) -> new Session(row.getObject("id", UUID.class), readTime(row, "expires_at")))
            .optional().orElse(null);
    }

    private static UUID requireContext(HttpServletRequest request, Session active) {
        UUID context = context(request);
        if (active == null || !active.sessionId().equals(context)) throw ApiFailure.unauthenticated();
        return context;
    }

    private static UUID context(HttpServletRequest request) {
        String value = singleHeader(request, CONTEXT_HEADER);
        UUID id = ApiFailure.uuid(value, ApiFailure.unauthenticated());
        if (!id.toString().equalsIgnoreCase(value)) throw ApiFailure.unauthenticated();
        return id;
    }

    private static String singleHeader(HttpServletRequest request, String name) {
        var values = request.getHeaders(name);
        if (!values.hasMoreElements()) return null;
        String value = values.nextElement();
        return values.hasMoreElements() ? null : value;
    }

    private static String tokenHash(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return null;
        String token = null;
        for (Cookie cookie : cookies) {
            if (!cookie.getName().equals(COOKIE)) continue;
            if (token != null) throw ApiFailure.unauthenticated();
            token = cookie.getValue();
        }
        return GuestSessions.validToken(token) ? GuestSessions.hash(token) : null;
    }

    private static ResponseCookie cookie(String token, Duration lifetime) {
        return ResponseCookie.from(COOKIE, token).secure(true).httpOnly(true).sameSite("Lax")
            .path("/").maxAge(lifetime).build();
    }
}
