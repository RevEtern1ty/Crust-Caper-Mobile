ALTER TABLE orders ADD COLUMN mobile_checkout_guest_session_id uuid REFERENCES guest_sessions(id) ON DELETE SET NULL;
ALTER TABLE orders ADD CONSTRAINT mobile_checkout_guest_channel CHECK (
    mobile_checkout_guest_session_id IS NULL OR checkout_channel = 'mobile'
);

ALTER TABLE order_access_challenges ADD COLUMN mobile_checkout_recovery boolean NOT NULL DEFAULT false;
ALTER TABLE order_access_challenges ADD CONSTRAINT mobile_checkout_recovery_purpose CHECK (
    NOT mobile_checkout_recovery OR checkout_recovery
);
