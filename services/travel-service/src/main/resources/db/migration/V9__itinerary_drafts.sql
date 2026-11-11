CREATE TABLE travel_itinerary_drafts (
    draft_id UUID PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES travel_accounts(account_id),
    base_revision BIGINT NOT NULL CHECK (base_revision >= 0),
    draft_revision BIGINT NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
    status VARCHAR(16) NOT NULL CHECK (status IN ('proposed', 'rejected')),
    draft JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX travel_itinerary_drafts_trip_idx ON travel_itinerary_drafts(trip_id, created_at DESC, draft_id DESC);
