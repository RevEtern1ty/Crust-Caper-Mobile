CREATE TABLE fiscal_receipt_corrections (
    order_id uuid PRIMARY KEY REFERENCES fiscal_receipts(order_id),
    store_id text NOT NULL REFERENCES stores(id),
    reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$'),
    refund_total_rwf bigint NOT NULL CHECK (refund_total_rwf > 0),
    provider_refund_id text NOT NULL UNIQUE REFERENCES verified_refunds(provider_refund_id),
    document bytea NOT NULL CHECK (octet_length(document) BETWEEN 14 AND 1048576),
    sha256 bytea GENERATED ALWAYS AS (sha256(document)) STORED,
    attached_by uuid NOT NULL REFERENCES operator_accounts(id),
    attached_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX fiscal_receipt_correction_reference_in_store
    ON fiscal_receipt_corrections (store_id, lower(reference COLLATE "C"));

CREATE FUNCTION guard_fiscal_receipt_correction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Fiscal receipt corrections are append-only';
    END IF;

    IF NOT EXISTS (
        SELECT FROM fiscal_receipts receipt
        JOIN orders o ON o.id = receipt.order_id
        JOIN verified_refunds refund ON refund.provider_refund_id = NEW.provider_refund_id
        JOIN payment_attempts attempt ON attempt.id = refund.attempt_id AND attempt.order_id = o.id
        JOIN operator_accounts manager ON manager.id = NEW.attached_by
        WHERE receipt.order_id = NEW.order_id
            AND receipt.store_id = NEW.store_id AND o.store_id = NEW.store_id
            AND refund.store_id = NEW.store_id AND manager.store_id = NEW.store_id
            AND manager.enabled AND manager.role = 'manager'
            AND o.payment_status = 'refunded' AND refund.cleared_order_payment AND refund.currency = 'RWF'
            AND refund.amount = NEW.refund_total_rwf AND receipt.total_rwf = NEW.refund_total_rwf
            AND o.total = NEW.refund_total_rwf
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'fiscal_receipt_correction_order_evidence',
            MESSAGE = 'Fiscal correction must match the original receipt, verified full refund and manager store';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fiscal_receipt_corrections_guard
    BEFORE INSERT OR UPDATE OR DELETE ON fiscal_receipt_corrections
    FOR EACH ROW EXECUTE FUNCTION guard_fiscal_receipt_correction();
