CREATE INDEX orders_reconciliation_day ON orders (store_id, accepted_at);

CREATE INDEX payment_exceptions_reconciliation_day ON payment_exceptions (created_at);

CREATE INDEX verified_refunds_reconciliation_day ON verified_refunds (store_id, recorded_at);

CREATE INDEX fiscal_receipts_reconciliation_day ON fiscal_receipts (store_id, attached_at);
