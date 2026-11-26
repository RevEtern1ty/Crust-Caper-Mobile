ALTER TABLE order_read_grants ADD COLUMN privacy_verified_at timestamptz;

CREATE TABLE order_erasure_requests (
    id uuid PRIMARY KEY,
    order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
    store_id text NOT NULL REFERENCES stores(id),
    submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'pending',
    reviewed_at timestamptz,
    reviewed_by uuid REFERENCES operator_accounts(id),
    CHECK ((status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
        OR (status = 'in_review' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);

CREATE INDEX order_erasure_requests_store_queue ON order_erasure_requests(store_id, status, submitted_at, id);
