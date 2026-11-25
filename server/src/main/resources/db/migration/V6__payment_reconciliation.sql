ALTER TABLE payment_attempts ADD COLUMN initiated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX payment_attempts_reconciliation ON payment_attempts (last_checked_at ASC NULLS FIRST, initiated_at, id)
    WHERE status = 'processing';
