ALTER TABLE travel_accounts ADD COLUMN verified_email VARCHAR(254);
ALTER TABLE travel_accounts ADD COLUMN verified_email_hash CHAR(64);
ALTER TABLE travel_accounts ADD COLUMN email_authoritative BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE travel_accounts ADD COLUMN email_verified_at TIMESTAMPTZ;
CREATE INDEX travel_accounts_verified_email_hash_idx ON travel_accounts(verified_email_hash) WHERE verified_email_hash IS NOT NULL;

CREATE TABLE travel_share_lookup_windows (
    account_id UUID NOT NULL REFERENCES travel_accounts(account_id) ON DELETE CASCADE,
    window_start TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    PRIMARY KEY (account_id, window_start)
);
