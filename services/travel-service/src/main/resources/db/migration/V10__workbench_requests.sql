CREATE TABLE travel_workbench_requests (
    handoff_id UUID PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    draft_id UUID NOT NULL REFERENCES travel_itinerary_drafts(draft_id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES travel_accounts(account_id),
    trip_revision BIGINT NOT NULL CHECK (trip_revision >= 0),
    draft_revision BIGINT NOT NULL CHECK (draft_revision >= 0),
    notification VARCHAR(16) NOT NULL CHECK (notification IN ('saved', 'sending', 'sent', 'failed', 'unknown')),
    work_status VARCHAR(16) NOT NULL CHECK (work_status IN ('saved', 'accepted', 'superseded')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX travel_workbench_requests_trip_idx ON travel_workbench_requests(trip_id,created_at DESC,handoff_id DESC);
