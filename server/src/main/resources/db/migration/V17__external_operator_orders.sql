CREATE TABLE operator_external_order_channels (
    store_id text NOT NULL REFERENCES stores(id),
    id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
    label text NOT NULL CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 80),
    enabled boolean NOT NULL DEFAULT true,
    PRIMARY KEY (store_id, id)
);

CREATE TABLE operator_external_orders (
    id uuid PRIMARY KEY,
    store_id text NOT NULL,
    channel text NOT NULL,
    channel_label text NOT NULL,
    external_reference text COLLATE "C" NOT NULL CHECK (external_reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
    scheduled_at timestamptz NOT NULL,
    lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 1 AND 30),
    registered_by uuid NOT NULL REFERENCES operator_accounts(id),
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'preparing', 'ready', 'collected', 'cancelled')),
    FOREIGN KEY (store_id, channel) REFERENCES operator_external_order_channels(store_id, id),
    UNIQUE (store_id, channel, external_reference)
);

CREATE INDEX operator_external_order_queue ON operator_external_orders(store_id, scheduled_at, id)
    WHERE status IN ('accepted', 'preparing', 'ready');

CREATE TABLE operator_external_order_events (
    order_id uuid NOT NULL REFERENCES operator_external_orders(id),
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    operator_role text NOT NULL CHECK (operator_role IN ('kitchen', 'pickup', 'manager')),
    previous_status text NOT NULL,
    requested_status text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (order_id, requested_status),
    CHECK ((requested_status = 'preparing' AND previous_status = 'accepted' AND operator_role IN ('kitchen', 'manager'))
        OR (requested_status = 'ready' AND previous_status = 'preparing' AND operator_role IN ('kitchen', 'manager'))
        OR (requested_status = 'collected' AND previous_status = 'ready' AND operator_role IN ('pickup', 'manager'))
        OR (requested_status = 'cancelled' AND previous_status IN ('accepted', 'preparing', 'ready') AND operator_role = 'manager'))
);
