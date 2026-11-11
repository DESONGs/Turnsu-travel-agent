CREATE TABLE travel_google_logins (
    state_hash CHAR(64) PRIMARY KEY,
    browser_hash CHAR(64) NOT NULL,
    pending_hash CHAR(64) NOT NULL REFERENCES travel_oauth_pending(request_hash) ON DELETE CASCADE,
    nonce_hash CHAR(64) NOT NULL,
    code_verifier VARCHAR(128) NOT NULL,
    account_id UUID REFERENCES travel_accounts(account_id),
    status VARCHAR(24) NOT NULL CHECK (status IN ('pending', 'exchanging', 'awaiting_consent')),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX travel_google_logins_expires_idx ON travel_google_logins(expires_at);
