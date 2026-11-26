CREATE TABLE checkout_quota_windows (
    operation text NOT NULL CHECK (operation IN ('quote', 'order')),
    scope text NOT NULL CHECK (scope IN ('session', 'store')),
    subject text NOT NULL,
    window_start timestamptz NOT NULL,
    admitted integer NOT NULL CHECK (admitted > 0),
    PRIMARY KEY (operation, scope, subject, window_start)
);

CREATE INDEX checkout_quota_windows_expiry ON checkout_quota_windows(window_start);
