package com.crustcaper.api.operator;

import com.crustcaper.api.operator.OperatorModels.Login;
import com.crustcaper.api.operator.OperatorModels.Session;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.regex.Pattern;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

@Service
final class OperatorSessions {
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Pattern USERNAME = Pattern.compile("[a-z0-9][a-z0-9._-]{2,63}");
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final int MAX_FAILED_LOGINS = 5;
    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final boolean allowDemoAccounts;
    private final Semaphore passwordChecks = new Semaphore(4);
    private final String unknownAccountHash = OperatorPasswordHash.hash("operator-login-padding-input".toCharArray());

    OperatorSessions(JdbcClient jdbc, TransactionTemplate transactions, Environment environment) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.allowDemoAccounts = environment.acceptsProfiles(Profiles.of("local & !stage & !prod & !production"))
                && "local".equals(environment.getProperty("crustcaper.payment.provider"));
    }

    Session open(Login login) {
        String username = normalize(login.username());
        if (login.password() == null || login.password().isEmpty() || login.password().length() > 256) {
            throw OperatorFailure.invalid();
        }
        if (!passwordChecks.tryAcquire()) {
            throw OperatorFailure.rateLimited();
        }
        char[] password = login.password().toCharArray();
        try {
            LoginResult result = transactions.execute(tx -> verifyLogin(username, password));
            if (result.failure() != null) {
                throw result.failure();
            }
            return result.session();
        } finally {
            Arrays.fill(password, '\0');
            passwordChecks.release();
        }
    }

    private LoginResult verifyLogin(String username, char[] password) {
        Account account = jdbc.sql("""
                SELECT id, store_id, role, password_hash, enabled, failed_logins, login_blocked_until
                FROM operator_accounts WHERE username = ? AND (? OR username NOT LIKE 'demo-%') FOR UPDATE
                """).params(username, allowDemoAccounts).query((rs, row) -> new Account(rs.getObject("id", UUID.class),
                        rs.getString("store_id"), rs.getString("role"), rs.getString("password_hash"), rs.getBoolean("enabled"),
                        rs.getInt("failed_logins"), rs.getObject("login_blocked_until", OffsetDateTime.class)))
                .optional().orElse(null);

        if (account == null || !account.enabled()) {
            // Spend the same password hash work on unknown and disabled identities.
            OperatorPasswordHash.matches(password, unknownAccountHash);
            return new LoginResult(null, OperatorFailure.unauthenticated());
        }
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        if (account.blockedUntil() != null && account.blockedUntil().isAfter(now)) {
            return new LoginResult(null, OperatorFailure.rateLimited());
        }
        if (!OperatorPasswordHash.matches(password, account.passwordHash())) {
            int failures = account.blockedUntil() == null ? account.failedLogins() + 1 : 1;
            OffsetDateTime blockedUntil = failures >= MAX_FAILED_LOGINS ? now.plusMinutes(2) : null;
            jdbc.sql("UPDATE operator_accounts SET failed_logins = ?, login_blocked_until = ? WHERE id = ?")
                    .params(failures, blockedUntil, account.id()).update();
            return new LoginResult(null, OperatorFailure.unauthenticated());
        }

        byte[] entropy = new byte[32];
        RANDOM.nextBytes(entropy);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(entropy);
        OffsetDateTime expires = now.plusHours(1);
        jdbc.sql("UPDATE operator_accounts SET failed_logins = 0, login_blocked_until = NULL WHERE id = ?")
                .param(account.id()).update();
        jdbc.sql("DELETE FROM operator_sessions WHERE operator_id = ? AND expires_at <= now()")
                .param(account.id()).update();
        jdbc.sql("INSERT INTO operator_sessions(token_hash, operator_id, expires_at) VALUES (?, ?, ?)")
                .params(tokenHash(token), account.id(), expires).update();
        return new LoginResult(new Session(token, expires.toInstant(), account.storeId(), account.role()), null);
    }

    Principal requirePrincipal(String authorization, boolean lock) {
        return jdbc.sql("""
                SELECT a.id, a.store_id, a.role
                FROM operator_sessions s JOIN operator_accounts a ON a.id = s.operator_id
                WHERE s.token_hash = ? AND s.expires_at > now() AND a.enabled
                  AND (? OR a.username NOT LIKE 'demo-%')
                """ + (lock ? " FOR SHARE OF a, s" : ""))
                .params(tokenHash(bearerToken(authorization)), allowDemoAccounts)
                .query((rs, row) -> new Principal(rs.getObject("id", UUID.class), rs.getString("store_id"), rs.getString("role")))
                .optional().orElseThrow(OperatorFailure::unauthenticated);
    }

    void revoke(String authorization) {
        jdbc.sql("DELETE FROM operator_sessions WHERE token_hash = ?")
                .param(tokenHash(bearerToken(authorization))).update();
    }

    private static String normalize(String input) {
        if (input == null || input.length() > 64) {
            throw OperatorFailure.invalid();
        }
        String username = input.strip().toLowerCase(Locale.ROOT);
        if (!USERNAME.matcher(username).matches()) {
            throw OperatorFailure.invalid();
        }
        return username;
    }

    private static String bearerToken(String authorization) {
        if (authorization == null || authorization.length() != 50 || !authorization.regionMatches(true, 0, "Bearer ", 0, 7)) {
            throw OperatorFailure.unauthenticated();
        }
        String token = authorization.substring(7);
        if (!TOKEN.matcher(token).matches()) {
            throw OperatorFailure.unauthenticated();
        }
        return token;
    }

    private static String tokenHash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("Operator session hashing is unavailable", error);
        }
    }

    record Principal(UUID id, String storeId, String role) { }

    private record Account(UUID id, String storeId, String role, String passwordHash, boolean enabled,
                           int failedLogins, OffsetDateTime blockedUntil) { }

    private record LoginResult(Session session, OperatorFailure failure) { }
}
