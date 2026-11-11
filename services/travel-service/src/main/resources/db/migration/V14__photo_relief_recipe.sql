-- A recipe records local visual settings, not a reconstructed scene or external model.
ALTER TABLE travel_journal_photos ADD COLUMN relief JSONB;
