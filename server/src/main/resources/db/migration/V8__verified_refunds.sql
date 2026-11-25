CREATE TABLE verified_refunds (
    provider_refund_id text PRIMARY KEY CHECK (provider_refund_id ~ '^[1-9][0-9]{0,18}$'),
    attempt_id uuid NOT NULL,
    provider_transaction_id text NOT NULL CHECK (provider_transaction_id ~ '^[1-9][0-9]{0,18}$'),
    amount bigint NOT NULL CHECK (amount BETWEEN 1 AND 2147483647),
    currency text NOT NULL CHECK (currency = 'RWF'),
    refund_status text NOT NULL CHECK (refund_status IN ('completed-bank-transfer', 'completed-momo',
        'completed-mpgs', 'completed-offline', 'completed-preauth')),
    store_id text NOT NULL REFERENCES stores(id),
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    operator_username text NOT NULL CHECK (operator_username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    cleared_order_payment boolean NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (attempt_id, provider_transaction_id),
    FOREIGN KEY (attempt_id, provider_transaction_id)
        REFERENCES payment_exceptions(attempt_id, provider_transaction_id)
);

CREATE FUNCTION prevent_verified_refund_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Verified refunds are append-only';
END;
$$;

CREATE TRIGGER verified_refunds_append_only
BEFORE UPDATE OR DELETE ON verified_refunds
FOR EACH ROW EXECUTE FUNCTION prevent_verified_refund_change();
