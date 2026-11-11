CREATE TABLE travel_journal_entries (
    entry_id UUID PRIMARY KEY,
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES travel_accounts(account_id),
    result_id UUID NOT NULL,
    source_id VARCHAR(128) NOT NULL,
    place_title VARCHAR(200) NOT NULL,
    subject VARCHAR(16) NOT NULL CHECK (subject IN ('landscape', 'building', 'food')),
    stage VARCHAR(16) NOT NULL CHECK (stage IN ('wish', 'visited')),
    note TEXT NOT NULL,
    taken_on DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX travel_journal_trip_created_idx ON travel_journal_entries(trip_id, created_at DESC, entry_id DESC);

CREATE TABLE travel_journal_photos (
    entry_id UUID NOT NULL REFERENCES travel_journal_entries(entry_id) ON DELETE CASCADE,
    photo_index SMALLINT NOT NULL CHECK (photo_index BETWEEN 0 AND 2),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 1280),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 1280),
    image_bytes BYTEA NOT NULL CHECK (octet_length(image_bytes) <= 450000),
    PRIMARY KEY (entry_id, photo_index)
);

-- Retain only the identifiers needed to prevent a delayed create from restoring a deleted photo.
CREATE TABLE travel_journal_tombstones (
    trip_id UUID NOT NULL REFERENCES travel_trips(trip_id) ON DELETE CASCADE,
    entry_id UUID PRIMARY KEY
);
