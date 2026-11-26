CREATE FUNCTION pickup_reservation_occupies_slot(order_status text, expires_at timestamptz, checked_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN order_status <> 'cancelled' AND (order_status <> 'awaiting_payment' OR expires_at > checked_at);

ALTER TABLE operator_availability_events
    DROP CONSTRAINT operator_availability_events_action_check,
    DROP CONSTRAINT operator_availability_events_check,
    DROP CONSTRAINT operator_availability_events_check1,
    ALTER COLUMN previous_value DROP NOT NULL,
    ALTER COLUMN new_value DROP NOT NULL,
    ADD COLUMN slot_id text,
    ADD COLUMN previous_capacity integer,
    ADD COLUMN new_capacity integer,
    ADD CONSTRAINT operator_availability_event_version CHECK (previous_version <> new_version),
    ADD CONSTRAINT operator_availability_event_values CHECK (
        (action IN ('store_open', 'product_available')
         AND ((action = 'store_open' AND sku IS NULL) OR (action = 'product_available' AND sku IS NOT NULL))
         AND previous_value IS NOT NULL AND new_value IS NOT NULL AND previous_value <> new_value
         AND slot_id IS NULL AND previous_capacity IS NULL AND new_capacity IS NULL)
        OR
        (action = 'slot_capacity' AND sku IS NULL AND previous_value IS NULL AND new_value IS NULL
         AND slot_id IS NOT NULL AND previous_capacity IS NOT NULL AND new_capacity IS NOT NULL
         AND previous_capacity >= 0 AND new_capacity >= 0 AND previous_capacity <> new_capacity)
    );
