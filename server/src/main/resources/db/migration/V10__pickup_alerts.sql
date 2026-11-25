CREATE TABLE pickup_alerts (
    id uuid PRIMARY KEY,
    order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    guest_session_id uuid NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL,
    locale text NOT NULL CHECK (locale IN ('en', 'rw')),
    encrypted_token bytea CHECK (octet_length(encrypted_token) BETWEEN 30 AND 512),
    enabled boolean NOT NULL,
    state text NOT NULL CHECK (state IN (
        'waiting', 'pending', 'sending', 'receipt_pending', 'verifying_receipt',
        'sent', 'cancelled', 'failed', 'delivery_unknown'
    )),
    send_attempts integer NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
    receipt_attempts integer NOT NULL DEFAULT 0 CHECK (receipt_attempts >= 0),
    queued_at timestamptz,
    next_attempt_at timestamptz,
    lease_id uuid,
    lease_until timestamptz,
    expo_ticket_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (order_id, guest_session_id, installation_id),
    CHECK (enabled = (encrypted_token IS NOT NULL))
);

CREATE INDEX pickup_alerts_waiting
    ON pickup_alerts (order_id) WHERE enabled AND state = 'waiting';
CREATE INDEX pickup_alerts_due
    ON pickup_alerts (next_attempt_at, id) WHERE enabled AND state IN ('pending', 'receipt_pending');
CREATE INDEX pickup_alerts_leases
    ON pickup_alerts (lease_until, id) WHERE state IN ('sending', 'verifying_receipt');
CREATE INDEX pickup_alerts_guest
    ON pickup_alerts (guest_session_id);
