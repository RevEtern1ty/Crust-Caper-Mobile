CREATE TABLE stores (
    id text PRIMARY KEY,
    name jsonb NOT NULL,
    area jsonb NOT NULL,
    hours jsonb NOT NULL,
    open boolean NOT NULL,
    tax_basis_points integer NOT NULL CHECK (tax_basis_points BETWEEN 0 AND 10000),
    version text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    support_url text,
    directions_url text
);

CREATE TABLE menu_products (
    store_id text NOT NULL REFERENCES stores(id),
    sku text NOT NULL,
    position integer NOT NULL,
    product jsonb NOT NULL,
    PRIMARY KEY (store_id, sku)
);

CREATE TABLE pickup_slots (
    store_id text NOT NULL REFERENCES stores(id),
    id text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    capacity integer NOT NULL CHECK (capacity >= 0),
    PRIMARY KEY (store_id, id)
);

CREATE INDEX pickup_slots_upcoming ON pickup_slots(store_id, starts_at);

CREATE TABLE guest_sessions (
    id uuid PRIMARY KEY,
    token_hash char(64) NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL
);

CREATE TABLE quotes (
    id uuid PRIMARY KEY,
    guest_session_id uuid NOT NULL REFERENCES guest_sessions(id),
    store_id text NOT NULL REFERENCES stores(id),
    slot_id text NOT NULL,
    pickup_starts_at timestamptz NOT NULL,
    pickup_ends_at timestamptz NOT NULL,
    lines jsonb NOT NULL,
    total bigint NOT NULL CHECK (total >= 0),
    tax bigint NOT NULL CHECK (tax BETWEEN 0 AND total),
    expires_at timestamptz NOT NULL,
    FOREIGN KEY (store_id, slot_id) REFERENCES pickup_slots(store_id, id)
);

CREATE TABLE orders (
    id uuid PRIMARY KEY,
    quote_id uuid NOT NULL UNIQUE REFERENCES quotes(id),
    guest_session_id uuid NOT NULL REFERENCES guest_sessions(id),
    request_key text NOT NULL,
    store_id text NOT NULL REFERENCES stores(id),
    slot_id text NOT NULL,
    phone text NOT NULL,
    email text,
    lines jsonb NOT NULL,
    total bigint NOT NULL CHECK (total > 0),
    tax bigint NOT NULL CHECK (tax BETWEEN 0 AND total),
    status text NOT NULL CHECK (status IN ('awaiting_payment','accepted','preparing','ready','collected','cancelled')),
    payment_status text NOT NULL CHECK (payment_status IN ('unpaid','processing','paid','declined','refund_pending','refunded')),
    pickup_code text,
    receipt_status text NOT NULL DEFAULT 'pending' CHECK (receipt_status IN ('pending','issued','corrected')),
    receipt_url text,
    created_at timestamptz NOT NULL,
    reservation_expires_at timestamptz NOT NULL,
    pickup_starts_at timestamptz NOT NULL,
    pickup_ends_at timestamptz NOT NULL,
    UNIQUE (guest_session_id, request_key),
    FOREIGN KEY (store_id, slot_id) REFERENCES pickup_slots(store_id, id)
);

CREATE INDEX orders_slot_capacity ON orders(store_id, slot_id, status, reservation_expires_at);

CREATE TABLE payment_attempts (
    id uuid PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders(id),
    sequence bigint GENERATED ALWAYS AS IDENTITY,
    request_key text NOT NULL,
    status text NOT NULL CHECK (status IN ('processing','paid','declined')),
    checkout_url text,
    provider_transaction_id text UNIQUE,
    last_checked_at timestamptz,
    UNIQUE (order_id, request_key)
);

CREATE INDEX payment_attempts_latest ON payment_attempts(order_id, sequence DESC);

CREATE TABLE payment_exceptions (
    attempt_id uuid PRIMARY KEY REFERENCES payment_attempts(id),
    reason text NOT NULL,
    created_at timestamptz NOT NULL
);
