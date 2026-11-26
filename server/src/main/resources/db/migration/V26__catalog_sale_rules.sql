CREATE FUNCTION catalog_sale_channels_valid(channels text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT COALESCE(
        array_ndims(channels) = 1 AND array_lower(channels, 1) = 1
        AND cardinality(channels) BETWEEN 1 AND 2
        AND channels <@ ARRAY['mobile', 'web']::text[]
        AND cardinality(channels) = (SELECT count(DISTINCT channel) FROM unnest(channels) AS choices(channel)),
        false
    )
$$;

CREATE FUNCTION catalog_sale_hours_valid(sale_hours jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    sale_window jsonb;
BEGIN
    IF jsonb_typeof(sale_hours) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    FOR sale_window IN SELECT value FROM jsonb_array_elements(sale_hours) LOOP
        IF jsonb_typeof(sale_window) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
        IF NOT COALESCE(
            sale_window ?& ARRAY['day', 'start', 'end']
            AND sale_window - ARRAY['day', 'start', 'end'] = '{}'::jsonb
            AND sale_window->'day' IN ('1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb, '6'::jsonb, '7'::jsonb)
            AND jsonb_typeof(sale_window->'start') = 'string'
            AND jsonb_typeof(sale_window->'end') = 'string'
            AND sale_window->>'start' ~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
            AND sale_window->>'end' ~ '^((0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]|24:00)$'
            AND (sale_window->>'start') COLLATE "C" < (sale_window->>'end') COLLATE "C",
            false
        ) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END
$$;

CREATE FUNCTION catalog_sale_active(sale_hours jsonb, sold_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE STRICT PARALLEL SAFE AS $$
    SELECT sale_hours = '[]'::jsonb OR EXISTS (
        SELECT FROM jsonb_array_elements(sale_hours) AS windows(sale_window)
        CROSS JOIN (SELECT sold_at AT TIME ZONE 'Africa/Kigali' AS local_sale) AS clock
        WHERE EXTRACT(ISODOW FROM local_sale) = (sale_window->>'day')::numeric
            AND local_sale::time >= (sale_window->>'start')::time
            AND local_sale::time < (sale_window->>'end')::time
    )
$$;

ALTER TABLE menu_products
    ADD COLUMN sale_channels text[] NOT NULL DEFAULT ARRAY['mobile', 'web']::text[],
    ADD COLUMN sale_hours jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD CONSTRAINT menu_product_sale_channels_valid CHECK (catalog_sale_channels_valid(sale_channels)),
    ADD CONSTRAINT menu_product_sale_hours_valid CHECK (catalog_sale_hours_valid(sale_hours));
