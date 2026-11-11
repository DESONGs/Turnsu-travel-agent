ALTER TABLE travel_itinerary_drafts DROP CONSTRAINT travel_itinerary_drafts_status_check;
ALTER TABLE travel_itinerary_drafts ADD CONSTRAINT travel_itinerary_drafts_status_check CHECK (status IN ('proposed','rejected','adopted'));

CREATE TABLE travel_risk_follow_ups (
    trip_id UUID PRIMARY KEY REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    adoption_id UUID NOT NULL,
    trip_revision BIGINT NOT NULL,
    enabled_by UUID NOT NULL REFERENCES travel_accounts(account_id),
    enabled BOOLEAN NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    stops_at TIMESTAMPTZ NOT NULL,
    next_check_at TIMESTAMPTZ,
    lease_id UUID,
    lease_until TIMESTAMPTZ,
    weather JSONB NOT NULL DEFAULT '{"status":"pending"}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX travel_risk_follow_ups_due_idx ON travel_risk_follow_ups(next_check_at) WHERE enabled;

CREATE TABLE travel_risk_changes (
    event_id BIGSERIAL PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    adoption_id UUID NOT NULL,
    kind VARCHAR(32) NOT NULL CHECK (kind='weather_changed'),
    result_id UUID NOT NULL REFERENCES travel_result_references(result_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX travel_risk_changes_trip_idx ON travel_risk_changes(trip_id,event_id DESC);
