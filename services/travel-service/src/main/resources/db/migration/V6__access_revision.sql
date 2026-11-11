ALTER TABLE travel_trips ADD COLUMN access_revision BIGINT NOT NULL DEFAULT 0 CHECK (access_revision >= 0);
