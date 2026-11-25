CREATE TABLE operator_accounts (
    id uuid PRIMARY KEY,
    store_id text NOT NULL REFERENCES stores(id),
    username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    role text NOT NULL CHECK (role IN ('kitchen', 'pickup', 'manager')),
    password_hash text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    failed_logins integer NOT NULL DEFAULT 0 CHECK (failed_logins BETWEEN 0 AND 5),
    login_blocked_until timestamptz
);

CREATE TABLE operator_sessions (
    token_hash char(64) PRIMARY KEY,
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    expires_at timestamptz NOT NULL
);

CREATE INDEX operator_sessions_account_expiry ON operator_sessions(operator_id, expires_at);

CREATE TABLE operator_order_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders(id),
    store_id text NOT NULL REFERENCES stores(id),
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    operator_role text NOT NULL CHECK (operator_role IN ('kitchen', 'pickup', 'manager')),
    previous_status text NOT NULL,
    requested_status text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('changed', 'pickup_code_mismatch')),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((previous_status = 'accepted' AND requested_status = 'preparing' AND outcome = 'changed')
        OR (previous_status = 'preparing' AND requested_status = 'ready' AND outcome = 'changed')
        OR (previous_status = 'ready' AND requested_status = 'collected'))
);

CREATE UNIQUE INDEX operator_order_transition_once ON operator_order_events(order_id, requested_status)
    WHERE outcome = 'changed';

CREATE INDEX operator_order_pickup_attempts ON operator_order_events(order_id, operator_id, occurred_at)
    WHERE outcome = 'pickup_code_mismatch';

CREATE INDEX operator_active_order_queue ON orders(store_id, pickup_starts_at, id)
    WHERE payment_status = 'paid' AND status IN ('accepted', 'preparing', 'ready');
