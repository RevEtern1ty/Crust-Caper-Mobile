ALTER TABLE quotes ADD COLUMN web_checkout boolean NOT NULL DEFAULT false;

UPDATE quotes q
SET web_checkout = true
WHERE EXISTS (SELECT FROM guest_sessions g WHERE g.id = q.guest_session_id AND g.web_token_hash IS NOT NULL)
   OR EXISTS (SELECT FROM orders o WHERE o.quote_id = q.id AND o.checkout_channel = 'web');

ALTER TABLE orders ADD COLUMN web_checkout_guest_session_id uuid REFERENCES guest_sessions(id) ON DELETE SET NULL;
ALTER TABLE orders ADD CONSTRAINT web_checkout_guest_channel CHECK (
    web_checkout_guest_session_id IS NULL OR checkout_channel = 'web'
);

ALTER TABLE order_access_challenges ALTER COLUMN order_code DROP NOT NULL;
ALTER TABLE order_access_challenges ADD COLUMN checkout_recovery boolean NOT NULL DEFAULT false;
ALTER TABLE order_access_challenges ADD CONSTRAINT order_access_lookup CHECK (
    (NOT checkout_recovery AND order_code IS NOT NULL)
    OR (checkout_recovery AND order_id IS NOT NULL AND order_code IS NULL)
);
