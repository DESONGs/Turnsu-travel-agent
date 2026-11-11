CREATE TABLE travel_itinerary_reviews (
    trip_id UUID NOT NULL,
    account_id UUID NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    acknowledgments JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(acknowledgments)='object'),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (trip_id, account_id),
    FOREIGN KEY (trip_id, account_id) REFERENCES travel_trip_access(trip_id, account_id) ON DELETE CASCADE
);
