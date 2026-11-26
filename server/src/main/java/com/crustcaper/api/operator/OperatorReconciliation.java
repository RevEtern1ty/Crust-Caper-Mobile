package com.crustcaper.api.operator;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
final class OperatorReconciliation {
    private static final String CURRENCY = "RWF";
    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");
    private static final Pattern DATE = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");
    private static final String DAILY_EVENTS = """
            WITH period AS (
                SELECT CAST(? AS text) AS store_id, CAST(? AS timestamptz) AS starts_at,
                       CAST(? AS timestamptz) AS ends_at
            ), accepted AS (
                SELECT o.id, o.store_id, o.total, o.payment_status, o.accepted_at
                FROM orders o CROSS JOIN period d
                WHERE o.store_id = d.store_id AND o.accepted_at >= d.starts_at AND o.accepted_at < d.ends_at
            ), exceptions AS (
                SELECT o.id AS order_id, pe.attempt_id, pe.provider_transaction_id, pe.reason, pe.created_at,
                       o.total, vr.provider_refund_id
                FROM payment_exceptions pe
                JOIN payment_attempts pa ON pa.id = pe.attempt_id
                JOIN orders o ON o.id = pa.order_id
                LEFT JOIN verified_refunds vr ON vr.attempt_id = pe.attempt_id
                    AND vr.provider_transaction_id = pe.provider_transaction_id AND vr.store_id = o.store_id
                CROSS JOIN period d
                WHERE o.store_id = d.store_id AND pe.created_at >= d.starts_at AND pe.created_at < d.ends_at
            ), refunds AS (
                SELECT o.id AS order_id, vr.attempt_id, vr.provider_transaction_id, vr.provider_refund_id,
                       vr.recorded_at, vr.amount, pe.reason
                FROM verified_refunds vr
                JOIN payment_exceptions pe ON pe.attempt_id = vr.attempt_id
                    AND pe.provider_transaction_id = vr.provider_transaction_id
                JOIN payment_attempts pa ON pa.id = vr.attempt_id
                JOIN orders o ON o.id = pa.order_id AND o.store_id = vr.store_id
                CROSS JOIN period d
                WHERE vr.store_id = d.store_id AND vr.recorded_at >= d.starts_at AND vr.recorded_at < d.ends_at
            ), receipts AS (
                SELECT f.order_id, f.reference, f.total_rwf, f.attached_at
                FROM fiscal_receipts f
                JOIN orders o ON o.id = f.order_id AND o.store_id = f.store_id
                CROSS JOIN period d
                WHERE f.store_id = d.store_id AND f.attached_at >= d.starts_at AND f.attached_at < d.ends_at
            )
            """;
    private static final String SUMMARY = DAILY_EVENTS + """
            , acceptance_summary AS (
                SELECT count(*) AS accepted_count, coalesce(sum(a.total), 0) AS accepted_amount,
                       count(*) FILTER (WHERE missing) AS unattached_count,
                       coalesce(sum(a.total) FILTER (WHERE missing), 0) AS unattached_amount
                FROM accepted a
                CROSS JOIN LATERAL (
                    SELECT a.payment_status = 'paid' AND NOT EXISTS (
                        SELECT FROM fiscal_receipts f WHERE f.order_id = a.id AND f.store_id = a.store_id
                    ) AS missing
                ) receipt_state
            ), exception_summary AS (
                SELECT count(*) FILTER (WHERE reason <> 'restaurant_cancelled') AS exception_count,
                       coalesce(sum(total) FILTER (WHERE reason <> 'restaurant_cancelled'), 0) AS exception_amount,
                       count(*) FILTER (WHERE provider_refund_id IS NULL) AS open_count,
                       coalesce(sum(total) FILTER (WHERE provider_refund_id IS NULL), 0) AS open_amount
                FROM exceptions
            ), refund_summary AS (
                SELECT count(*) AS refund_count, coalesce(sum(amount), 0) AS refund_amount FROM refunds
            ), receipt_summary AS (
                SELECT count(*) AS receipt_count, coalesce(sum(total_rwf), 0) AS receipt_amount FROM receipts
            ), undated_summary AS (
                SELECT count(*) AS undated_count, coalesce(sum(o.total), 0) AS undated_amount
                FROM orders o CROSS JOIN period d
                WHERE o.store_id = d.store_id AND o.accepted_at IS NULL AND (
                    (o.payment_status = 'paid' AND o.status IN ('accepted', 'preparing', 'ready', 'collected'))
                    OR (o.status = 'cancelled' AND o.payment_status IN ('refund_pending', 'refunded') AND EXISTS (
                        SELECT FROM payment_attempts pa
                        JOIN payment_exceptions pe ON pe.attempt_id = pa.id
                            AND pe.provider_transaction_id = pa.provider_transaction_id
                        WHERE pa.order_id = o.id AND pa.status = 'paid' AND pe.reason = 'restaurant_cancelled'
                    ))
                )
            )
            SELECT statement_timestamp() AS as_of, a.*, e.*, r.*, f.*, u.*
            FROM acceptance_summary a CROSS JOIN exception_summary e CROSS JOIN refund_summary r
            CROSS JOIN receipt_summary f CROSS JOIN undated_summary u
            """;
    private static final String EXPORT = DAILY_EVENTS + """
            , primary_candidates AS (
                SELECT pa.order_id, pa.id, pa.provider_transaction_id,
                       count(*) OVER (PARTITION BY pa.order_id) AS candidates
                FROM (
                    SELECT id AS order_id FROM accepted UNION SELECT order_id FROM receipts
                ) included
                JOIN payment_attempts pa ON pa.order_id = included.order_id AND pa.status = 'paid'
                WHERE NOT EXISTS (
                    SELECT FROM payment_exceptions pe
                    WHERE pe.attempt_id = pa.id AND pe.provider_transaction_id = pa.provider_transaction_id
                        AND pe.reason <> 'restaurant_cancelled'
                )
            ), primary_references AS (
                SELECT order_id, id, provider_transaction_id FROM primary_candidates
                WHERE candidates = 1 AND nullif(btrim(provider_transaction_id), '') IS NOT NULL
            ), events AS (
                SELECT 'accepted_payment' AS event_type, a.accepted_at AS recorded_at, a.id AS order_id,
                       p.id AS merchant_reference, p.provider_transaction_id, NULL::text AS provider_refund_id,
                       NULL::text AS receipt_reference, a.total AS amount_rwf,
                       NULL::text AS reason, NULL::text AS review_state
                FROM accepted a LEFT JOIN primary_references p ON p.order_id = a.id
                UNION ALL
                SELECT CASE WHEN e.reason = 'restaurant_cancelled' THEN 'restaurant_cancellation' ELSE 'exception_payment' END,
                       e.created_at, e.order_id, e.attempt_id, e.provider_transaction_id, e.provider_refund_id,
                       NULL, e.total, e.reason, CASE WHEN e.provider_refund_id IS NULL THEN 'open' ELSE 'verified' END
                FROM exceptions e
                UNION ALL
                SELECT 'verified_refund', r.recorded_at, r.order_id, r.attempt_id, r.provider_transaction_id,
                       r.provider_refund_id, NULL, r.amount, r.reason, NULL
                FROM refunds r
                UNION ALL
                SELECT 'attached_receipt', f.attached_at, f.order_id, p.id, p.provider_transaction_id,
                       NULL, f.reference, f.total_rwf, NULL, NULL
                FROM receipts f LEFT JOIN primary_references p ON p.order_id = f.order_id
            )
            SELECT * FROM events
            ORDER BY recorded_at, event_type, order_id, merchant_reference, provider_transaction_id,
                     provider_refund_id, receipt_reference
            """;
    private static final String CSV_HEADER = "event_type,recorded_at,order_id,merchant_reference,provider_transaction_id,"
            + "provider_refund_id,receipt_reference,amount_rwf,currency,reason,review_state\r\n";

    record Totals(long count, String amountRwf) {}

    record Report(LocalDate date, String timeZone, String currency, Instant from, Instant until, Instant asOf,
                  Totals acceptedPayments, Totals exceptionPayments, Totals verifiedRefunds, Totals attachedReceipts,
                  Totals unattachedReceipts, Totals openExceptions, Totals undatedAcceptedPayments) {}

    record CsvReport(LocalDate date, String content) {}

    private record Period(String storeId, LocalDate date, OffsetDateTime from, OffsetDateTime until) {}

    private final JdbcClient jdbc;
    private final OperatorSessions sessions;

    OperatorReconciliation(JdbcClient jdbc, OperatorSessions sessions) {
        this.jdbc = jdbc;
        this.sessions = sessions;
    }

    Report summary(String authorization, String rawDate) {
        Period period = period(authorization, rawDate);
        return daily(SUMMARY, period).query((rs, row) -> new Report(period.date(), KIGALI.getId(), CURRENCY,
                period.from().toInstant(), period.until().toInstant(), timestamp(rs, "as_of"),
                totals(rs, "accepted"), totals(rs, "exception"), totals(rs, "refund"), totals(rs, "receipt"),
                totals(rs, "unattached"), totals(rs, "open"), totals(rs, "undated"))).single();
    }

    CsvReport export(String authorization, String rawDate) {
        Period period = period(authorization, rawDate);
        StringBuilder csv = new StringBuilder(CSV_HEADER);
        daily(EXPORT, period).query(rs -> {
            appendCsvRow(csv, rs);
        });
        return new CsvReport(period.date(), csv.toString());
    }

    private JdbcClient.StatementSpec daily(String sql, Period period) {
        return jdbc.sql(sql).params(period.storeId(), period.from(), period.until());
    }

    private Period period(String authorization, String rawDate) {
        var actor = sessions.requirePrincipal(authorization, false);
        if (!actor.role().equals("manager")) throw OperatorFailure.forbidden();
        if (rawDate == null || !DATE.matcher(rawDate).matches()) throw OperatorFailure.invalid();

        LocalDate date;
        try {
            date = LocalDate.parse(rawDate);
        } catch (DateTimeParseException invalid) {
            throw OperatorFailure.invalid();
        }
        if (date.getYear() == 0) throw OperatorFailure.invalid();
        return new Period(actor.storeId(), date, date.atStartOfDay(KIGALI).toOffsetDateTime(),
                date.plusDays(1).atStartOfDay(KIGALI).toOffsetDateTime());
    }

    private static Instant timestamp(ResultSet rs, String column) throws SQLException {
        return rs.getObject(column, OffsetDateTime.class).toInstant();
    }

    private static Totals totals(ResultSet rs, String bucket) throws SQLException {
        return new Totals(rs.getLong(bucket + "_count"), rs.getBigDecimal(bucket + "_amount").toPlainString());
    }

    private static void appendCsvRow(StringBuilder csv, ResultSet rs) throws SQLException {
        String[] cells = {
            rs.getString("event_type"), timestamp(rs, "recorded_at").toString(), rs.getString("order_id"),
            rs.getString("merchant_reference"), rs.getString("provider_transaction_id"), rs.getString("provider_refund_id"),
            rs.getString("receipt_reference"), rs.getString("amount_rwf"), CURRENCY, rs.getString("reason"),
            rs.getString("review_state")
        };
        for (int i = 0; i < cells.length; i++) {
            if (i > 0) csv.append(',');
            appendCsvCell(csv, cells[i]);
        }
        csv.append("\r\n");
    }

    private static void appendCsvCell(StringBuilder csv, String value) {
        if (value == null || value.isEmpty()) return;
        String leading = value.stripLeading();
        // CSV quoting preserves parsing but spreadsheet software can still evaluate a quoted formula.
        if ((!leading.isEmpty() && "=+-@＝＋－＠".indexOf(leading.charAt(0)) >= 0)
                || "\t\r\n".indexOf(value.charAt(0)) >= 0) {
            value = "'" + value;
        }
        if (value.indexOf(',') >= 0 || value.indexOf('"') >= 0 || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
            csv.append('"').append(value.replace("\"", "\"\"")).append('"');
        } else {
            csv.append(value);
        }
    }
}
