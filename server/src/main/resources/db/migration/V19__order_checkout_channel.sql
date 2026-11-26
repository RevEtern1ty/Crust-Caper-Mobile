ALTER TABLE orders ADD COLUMN checkout_channel text NOT NULL DEFAULT 'mobile'
    CHECK (checkout_channel IN ('mobile', 'web'));
