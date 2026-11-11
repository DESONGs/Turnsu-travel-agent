CREATE TABLE travel_planning_tasks (
    task_id UUID PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES travel_accounts(account_id),
    request_id VARCHAR(128) NOT NULL,
    input_hash CHAR(64) NOT NULL,
    objective TEXT NOT NULL,
    base_revision BIGINT NOT NULL CHECK (base_revision >= 0),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    status VARCHAR(24) NOT NULL CHECK (status IN ('queued','running','paused','completed','needs_context','cancelled','superseded')),
    checkpoint JSONB,
    suggestion JSONB,
    lease_id UUID,
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (created_by, request_id)
);
CREATE INDEX travel_planning_tasks_queue_idx ON travel_planning_tasks(status, created_at);
CREATE INDEX travel_planning_tasks_account_idx ON travel_planning_tasks(created_by, status);
CREATE INDEX travel_planning_tasks_trip_idx ON travel_planning_tasks(trip_id, created_at DESC);
