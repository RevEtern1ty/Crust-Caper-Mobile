ALTER TABLE operator_accounts
    ADD COLUMN mfa_encrypted_secret bytea,
    ADD COLUMN mfa_last_counter bigint,
    ADD CONSTRAINT operator_account_mfa_secret_length CHECK (
        mfa_encrypted_secret IS NULL OR octet_length(mfa_encrypted_secret) = 49
    ),
    ADD CONSTRAINT operator_account_mfa_watermark CHECK (
        mfa_last_counter IS NULL OR (mfa_encrypted_secret IS NOT NULL AND mfa_last_counter >= 0)
    );

ALTER TABLE operator_sessions ADD COLUMN mfa_verified boolean NOT NULL DEFAULT false;

CREATE TABLE operator_mfa_enrollments (
    operator_id uuid NOT NULL REFERENCES operator_accounts(id),
    enrollment_digest bytea NOT NULL CHECK (octet_length(enrollment_digest) = 32),
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (operator_id, enrollment_digest)
);
