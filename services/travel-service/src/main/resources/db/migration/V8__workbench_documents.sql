CREATE TABLE travel_workbench_documents (
    trip_id UUID PRIMARY KEY REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    layout_revision BIGINT NOT NULL DEFAULT 0 CHECK (layout_revision >= 0),
    document JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
