CREATE TABLE travel_oauth_clients (
    client_id VARCHAR(128) PRIMARY KEY,
    client_name VARCHAR(255) NOT NULL,
    redirect_uris JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE travel_oauth_pending (
    request_hash CHAR(64) PRIMARY KEY,
    client_id VARCHAR(128) NOT NULL REFERENCES travel_oauth_clients(client_id),
    redirect_uri TEXT NOT NULL,
    client_state TEXT NOT NULL,
    code_challenge VARCHAR(128) NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE travel_oauth_codes (
    code_hash CHAR(64) PRIMARY KEY,
    client_id VARCHAR(128) NOT NULL REFERENCES travel_oauth_clients(client_id),
    account_id UUID NOT NULL REFERENCES travel_accounts(account_id),
    redirect_uri TEXT NOT NULL,
    code_challenge VARCHAR(128) NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE travel_oauth_grants (
    grant_id UUID PRIMARY KEY,
    client_id VARCHAR(128) NOT NULL REFERENCES travel_oauth_clients(client_id),
    account_id UUID NOT NULL REFERENCES travel_accounts(account_id),
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX travel_oauth_grants_account_idx ON travel_oauth_grants(account_id);

CREATE TABLE travel_oauth_access (
    token_hash CHAR(64) PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES travel_oauth_grants(grant_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX travel_oauth_access_grant_idx ON travel_oauth_access(grant_id);

CREATE TABLE travel_oauth_refresh (
    token_hash CHAR(64) PRIMARY KEY,
    grant_id UUID NOT NULL REFERENCES travel_oauth_grants(grant_id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE INDEX travel_oauth_refresh_grant_idx ON travel_oauth_refresh(grant_id);
