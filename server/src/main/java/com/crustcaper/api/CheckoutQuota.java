package com.crustcaper.api;

import static com.crustcaper.api.Catalog.dbTime;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
class CheckoutQuota {
    enum Operation { QUOTE, ORDER }
    private record Limits(int session, int store) {
        Limits {
            if (session < 1 || store < 1) throw new IllegalArgumentException("Checkout quotas must be positive");
        }
    }

    private final JdbcClient jdbc;
    private final Limits quotes;
    private final Limits orders;

    CheckoutQuota(JdbcClient jdbc,
                  @Value("${crustcaper.checkout.quotas.quotes-per-session}") int sessionQuotes,
                  @Value("${crustcaper.checkout.quotas.quotes-per-store}") int storeQuotes,
                  @Value("${crustcaper.checkout.quotas.orders-per-session}") int sessionOrders,
                  @Value("${crustcaper.checkout.quotas.orders-per-store}") int storeOrders) {
        this.jdbc = jdbc;
        this.quotes = new Limits(sessionQuotes, storeQuotes);
        this.orders = new Limits(sessionOrders, storeOrders);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void admit(Operation operation, UUID session, String store, Instant now) {
        Limits limits = operation == Operation.QUOTE ? quotes : orders;
        String kind = operation == Operation.QUOTE ? "quote" : "order";
        Instant start = now.truncatedTo(ChronoUnit.MINUTES);
        // Apply both budgets in checkout's transaction and always lock the session before its store.
        boolean admitted = jdbc.sql("""
            WITH admitted_session AS (
                INSERT INTO checkout_quota_windows (operation, scope, subject, window_start, admitted)
                VALUES (:operation, 'session', :session, :start, 1)
                ON CONFLICT (operation, scope, subject, window_start)
                DO UPDATE SET admitted = checkout_quota_windows.admitted + 1
                WHERE checkout_quota_windows.admitted < :sessionLimit
                RETURNING 1
            )
            INSERT INTO checkout_quota_windows (operation, scope, subject, window_start, admitted)
            SELECT :operation, 'store', :store, :start, 1 FROM admitted_session
            ON CONFLICT (operation, scope, subject, window_start)
            DO UPDATE SET admitted = checkout_quota_windows.admitted + 1
            WHERE checkout_quota_windows.admitted < :storeLimit
            RETURNING 1
            """).param("operation", kind).param("session", session.toString()).param("store", store)
            .param("start", dbTime(start)).param("sessionLimit", limits.session()).param("storeLimit", limits.store())
            .query(Integer.class).optional().isPresent();
        if (!admitted) {
            // A rejected write rolls back the other counter too. Round the advertised delay up.
            int retryAfterSeconds = Math.toIntExact(start.plus(1, ChronoUnit.MINUTES).getEpochSecond() - now.getEpochSecond());
            throw ApiFailure.rateLimited(retryAfterSeconds);
        }
    }

    @Scheduled(initialDelayString = "PT1M", fixedDelayString = "PT10S")
    void removeExpiredWindows() {
        jdbc.sql("""
            DELETE FROM checkout_quota_windows
            WHERE (operation, scope, subject, window_start) IN (
                SELECT operation, scope, subject, window_start FROM checkout_quota_windows
                WHERE window_start < statement_timestamp() - interval '5 minutes'
                ORDER BY window_start LIMIT 1000 FOR UPDATE SKIP LOCKED
            )
            """).update();
    }
}
