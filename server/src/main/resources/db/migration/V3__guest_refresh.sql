ALTER TABLE guest_sessions ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE guest_sessions ADD COLUMN refresh_token_hash char(64) UNIQUE;

CREATE TABLE guest_access_tokens (
    token_hash char(64) PRIMARY KEY,
    guest_session_id uuid NOT NULL REFERENCES guest_sessions(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE INDEX guest_access_tokens_guest_expiry ON guest_access_tokens(guest_session_id, expires_at);
