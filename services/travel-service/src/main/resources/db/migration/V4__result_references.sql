CREATE TABLE travel_result_references (
    result_id UUID PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    trip_revision BIGINT NOT NULL CHECK (trip_revision >= 0),
    kind VARCHAR(32) NOT NULL,
    source VARCHAR(80) NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL,
    fresh_until TIMESTAMPTZ NOT NULL,
    coverage VARCHAR(32) NOT NULL,
    data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX travel_result_references_trip_idx ON travel_result_references(trip_id, checked_at DESC);
CREATE INDEX travel_result_references_expiry_idx ON travel_result_references(fresh_until) WHERE data IS NOT NULL;
