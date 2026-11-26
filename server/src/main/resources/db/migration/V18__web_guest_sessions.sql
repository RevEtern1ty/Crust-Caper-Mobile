ALTER TABLE guest_sessions ADD COLUMN web_token_hash char(64) UNIQUE;

ALTER TABLE guest_sessions ADD CONSTRAINT guest_session_credential_channel CHECK (
    web_token_hash IS NULL OR (token_hash IS NULL AND refresh_token_hash IS NULL)
);
