CREATE TABLE operator_availability_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id text NOT NULL REFERENCES stores(id),
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    operator_username text NOT NULL CHECK (operator_username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    action text NOT NULL CHECK (action IN ('store_open', 'product_available')),
    sku text,
    previous_value boolean NOT NULL,
    new_value boolean NOT NULL,
    previous_version text NOT NULL,
    new_version text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (store_id, new_version),
    CHECK (previous_value <> new_value AND previous_version <> new_version),
    CHECK ((action = 'store_open' AND sku IS NULL) OR (action = 'product_available' AND sku IS NOT NULL))
);

CREATE FUNCTION prevent_availability_event_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Availability history cannot be rewritten';
END
$$;

CREATE TRIGGER operator_availability_events_no_update
    BEFORE UPDATE ON operator_availability_events
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_availability_event_rewrite();
