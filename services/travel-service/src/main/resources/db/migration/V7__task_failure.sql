ALTER TABLE travel_planning_tasks DROP CONSTRAINT travel_planning_tasks_status_check;
ALTER TABLE travel_planning_tasks ADD CONSTRAINT travel_planning_tasks_status_check
    CHECK (status IN ('queued','running','paused','completed','needs_context','cancelled','superseded','failed'));
ALTER TABLE travel_planning_tasks ADD COLUMN failure_code VARCHAR(64);
