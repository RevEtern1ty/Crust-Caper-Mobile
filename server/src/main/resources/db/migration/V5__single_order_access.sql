CREATE INDEX orders_access_code ON orders ((right(id::text, 8)));

CREATE TABLE order_access_challenges (
    id uuid PRIMARY KEY,
    guest_session_id uuid NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
    order_code char(8) NOT NULL CHECK (order_code ~ '^[0-9a-f]{8}$'),
    phone_digest bytea NOT NULL CHECK (octet_length(phone_digest) = 32),
    order_id uuid REFERENCES orders(id),
    state text NOT NULL CHECK (state IN ('queued','sending','sent','checking','verified','closed')),
    provider_reference text UNIQUE,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    reserved_at timestamptz
);

CREATE INDEX order_access_guest_rate ON order_access_challenges(guest_session_id, created_at);
CREATE INDEX order_access_dispatch_queue ON order_access_challenges(created_at) WHERE state = 'queued';
CREATE INDEX order_access_contact_cooldown ON order_access_challenges(reserved_at) WHERE reserved_at IS NOT NULL;
CREATE INDEX order_access_cleanup ON order_access_challenges(expires_at);

CREATE TABLE order_read_grants (
    guest_session_id uuid NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
    order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (guest_session_id, order_id)
);
