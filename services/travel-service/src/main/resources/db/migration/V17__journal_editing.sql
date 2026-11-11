ALTER TABLE travel_journal_entries ALTER COLUMN result_id DROP NOT NULL;
ALTER TABLE travel_journal_entries ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE travel_journal_entries ADD COLUMN title VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE travel_journal_entries ADD COLUMN visit_stop_id VARCHAR(128);
ALTER TABLE travel_journal_entries ADD COLUMN revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE travel_journal_entries ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE travel_journal_photos ADD COLUMN photo_id UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX travel_journal_photo_identity_idx ON travel_journal_photos(photo_id);
