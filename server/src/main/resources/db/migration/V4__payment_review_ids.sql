ALTER TABLE payment_exceptions ADD COLUMN provider_transaction_id text;

UPDATE payment_exceptions exception
SET provider_transaction_id = attempt.provider_transaction_id
FROM payment_attempts attempt
WHERE exception.attempt_id = attempt.id;

ALTER TABLE payment_exceptions ALTER COLUMN provider_transaction_id SET NOT NULL;
ALTER TABLE payment_exceptions DROP CONSTRAINT payment_exceptions_pkey;
ALTER TABLE payment_exceptions ADD PRIMARY KEY (attempt_id, provider_transaction_id);
