CREATE TABLE pickup_schedule_publications (
    store_id text NOT NULL REFERENCES stores(id),
    id uuid NOT NULL,
    schedule_date date NOT NULL CHECK (schedule_date >= DATE '0001-01-01'),
    start_time time NOT NULL,
    end_time time NOT NULL,
    capacity integer NOT NULL CHECK (capacity > 0),
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    operator_username text NOT NULL CHECK (operator_username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    previous_version text NOT NULL,
    new_version text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (store_id, id),
    UNIQUE (store_id, new_version),
    CHECK (previous_version <> new_version),
    CHECK (start_time < end_time AND end_time < TIME '24:00'
        AND EXTRACT(SECOND FROM start_time) = 0 AND EXTRACT(SECOND FROM end_time) = 0
        AND MOD(EXTRACT(MINUTE FROM start_time), 10) = 0 AND MOD(EXTRACT(MINUTE FROM end_time), 10) = 0)
);

CREATE TRIGGER pickup_schedule_publications_no_update
    BEFORE UPDATE ON pickup_schedule_publications
    FOR EACH STATEMENT EXECUTE FUNCTION prevent_availability_event_rewrite();
