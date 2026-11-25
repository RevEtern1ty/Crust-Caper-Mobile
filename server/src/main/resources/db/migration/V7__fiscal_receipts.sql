CREATE TABLE fiscal_receipts (
    order_id uuid PRIMARY KEY REFERENCES orders(id),
    store_id text NOT NULL REFERENCES stores(id),
    reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$'),
    total_rwf bigint NOT NULL CHECK (total_rwf > 0),
    document bytea NOT NULL CHECK (octet_length(document) BETWEEN 14 AND 1048576),
    sha256 bytea GENERATED ALWAYS AS (sha256(document)) STORED,
    attached_by uuid NOT NULL REFERENCES operator_accounts(id),
    attached_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX fiscal_receipt_reference_in_store
    ON fiscal_receipts (store_id, lower(reference COLLATE "C"));

CREATE INDEX orders_receipt_queue
    ON orders (store_id, (CASE WHEN receipt_status = 'pending' THEN 0 ELSE 1 END), created_at DESC, id)
    WHERE payment_status = 'paid';
