ALTER TABLE payment_attempts ADD COLUMN verified_at timestamptz;

ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempt_verified_paid
    CHECK (verified_at IS NULL OR status = 'paid');

CREATE INDEX orders_operations_handoff ON orders (store_id, id)
    WHERE status <> 'collected'
      AND payment_status NOT IN ('refund_pending', 'refunded')
      AND NOT (payment_status = 'paid' AND status IN ('accepted', 'preparing', 'ready'));

CREATE INDEX orders_operations_pending_receipts ON orders (store_id, id)
    WHERE status = 'collected' AND payment_status = 'paid' AND receipt_status = 'pending';
