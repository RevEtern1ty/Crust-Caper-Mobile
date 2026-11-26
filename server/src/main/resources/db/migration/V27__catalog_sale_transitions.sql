CREATE FUNCTION catalog_next_sale_change(sale_hours jsonb, checked_at timestamptz) RETURNS timestamptz
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $$
    WITH intervals AS (
        SELECT ((day - 1)::integer * 1440 + (EXTRACT(EPOCH FROM "start") / 60)::integer) AS opens_at,
               ((day - 1)::integer * 1440 + (EXTRACT(EPOCH FROM "end") / 60)::integer) AS closes_at
        FROM jsonb_to_recordset(sale_hours) AS windows(day numeric, "start" time, "end" time)
    ),
    week_starting_coverage AS (
        -- Rows ending Sunday at 24:00 are active immediately before the first minute of the week.
        SELECT count(*) AS open_before_midnight FROM intervals WHERE closes_at = 10080
    ),
    events AS (
        -- Combine simultaneous opens and closes before looking for a change in coverage.
        SELECT boundary.minute, sum(boundary.delta) AS delta
        FROM intervals
        CROSS JOIN LATERAL (VALUES (opens_at, 1), (closes_at % 10080, -1)) AS boundary(minute, delta)
        GROUP BY boundary.minute
    ),
    coverage AS (
        SELECT minute, delta, open_before_midnight + sum(delta) OVER (ORDER BY minute) AS open_after
        FROM events CROSS JOIN week_starting_coverage
    ),
    boundaries AS (
        SELECT date_trunc('week', checked_at AT TIME ZONE 'Africa/Kigali')
            + make_interval(mins => minute) AS local_boundary
        FROM coverage
        WHERE (open_after > 0) <> (open_after - delta > 0)
    )
    SELECT min((
        local_boundary + CASE
            WHEN (local_boundary AT TIME ZONE 'Africa/Kigali') <= checked_at THEN interval '7 days'
            ELSE interval '0 days'
        END
    ) AT TIME ZONE 'Africa/Kigali') FROM boundaries
$$;
