CREATE TABLE travel_accounts (
    account_id UUID PRIMARY KEY,
    google_subject VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE travel_trips (
    trip_id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES travel_accounts(account_id),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX travel_trips_owner_updated_idx ON travel_trips(owner_id, updated_at DESC);

CREATE TABLE travel_trip_access (
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES travel_accounts(account_id),
    role VARCHAR(12) NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    PRIMARY KEY (trip_id, account_id)
);
CREATE INDEX travel_trip_access_account_idx ON travel_trip_access(account_id, trip_id);

CREATE TABLE travel_command_receipts (
    account_id UUID NOT NULL REFERENCES travel_accounts(account_id),
    request_id VARCHAR(128) NOT NULL,
    command_type VARCHAR(64) NOT NULL,
    input_hash CHAR(64) NOT NULL,
    response JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (account_id, request_id)
);
