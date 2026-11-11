package app.travelagent.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

/** Personal media is separate from Trip state and is returned only to the workbench. */
@Service
public class TravelJournal {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final TravelResults results;
    private final JsonMapper json = JsonMapper.builder().build();

    public TravelJournal(JdbcTemplate jdbc, TransactionTemplate transactions, TravelResults results) {
        this.jdbc = jdbc; this.transactions = transactions; this.results = results;
    }

    public Map<String, Object> create(UUID actor, UUID trip, long expectedRevision, String requestId, UUID entry,
                                       UUID resultId, String sourceId, String subject, String stage, String note, String takenOn, List<?> inputPhotos) {
        if (actor == null || trip == null || expectedRevision < 0 || entry == null || entry.version() != 4 || resultId == null
                || sourceId == null || !sourceId.matches("[A-Za-z0-9_.:-]{1,128}")
                || subject == null || !Set.of("landscape", "building", "food").contains(subject)
                || stage == null || !Set.of("wish", "visited").contains(stage)
                || note == null || note.length() > 1000 || inputPhotos == null || inputPhotos.isEmpty() || inputPhotos.size() > 3)
            throw new TravelError("journal_input_invalid");
        String safeNote = (String) TripStateFactory.safeObject(Map.of("note", note.trim())).get("note");
        LocalDate date = null;
        if (takenOn != null && !takenOn.isBlank()) {
            try { if (!takenOn.matches("\\d{4}-\\d{2}-\\d{2}")) throw new IllegalArgumentException(); date = LocalDate.parse(takenOn); }
            catch (RuntimeException invalid) { throw new TravelError("journal_input_invalid"); }
        }
        var photos = new ArrayList<JournalImage>();
        var hashes = new ArrayList<Map<String, Object>>();
        for (Object input : inputPhotos) {
            if (!(input instanceof Map<?, ?> image) || !Set.of("data", "relief").containsAll(image.keySet())) throw new TravelError("journal_photo_invalid");
            var photo = JournalJpeg.sanitize(image.get("data"));
            var relief = validateRelief(subject, image.get("relief"));
            photos.add(new JournalImage(photo, relief));
            var digestInput = new LinkedHashMap<String, Object>(); digestInput.put("sha256", sha256(photo.bytes())); digestInput.put("relief", relief); hashes.add(digestInput);
        }
        var input = new LinkedHashMap<String, Object>(); input.put("tripId", trip.toString()); input.put("expectedRevision", expectedRevision);
        input.put("entryId", entry.toString()); input.put("resultId", resultId.toString()); input.put("sourceId", sourceId);
        input.put("subject", subject); input.put("stage", stage); input.put("note", safeNote); input.put("takenOn", date == null ? null : date.toString()); input.put("photos", hashes);
        final LocalDate savedDate = date;
        return receipt(actor, trip, entry, requestId, "journal_create", input, expectedRevision, () -> {
            if (jdbc.queryForObject("SELECT count(*) FROM travel_journal_entries WHERE trip_id=?", Integer.class, trip) >= 40) throw new TravelError("journal_trip_limit");
            if (jdbc.queryForObject("SELECT count(*) FROM travel_journal_entries WHERE entry_id=?", Integer.class, entry) > 0
                    || jdbc.queryForObject("SELECT count(*) FROM travel_journal_tombstones WHERE entry_id=?", Integer.class, entry) > 0)
                throw new TravelError("journal_id_conflict");
            var reference = results.read(actor, resultId);
            if (!trip.toString().equals(reference.get("tripId")) || !"places".equals(reference.get("kind"))) throw new TravelError("result_not_found");
            if (Boolean.TRUE.equals(reference.get("expired"))) throw new TravelError("result_expired");
            if (Boolean.TRUE.equals(reference.get("stale")) || ((Number) reference.get("tripRevision")).longValue() != expectedRevision) throw new TravelError("result_stale");
            if (!(reference.get("data") instanceof Map<?, ?> data) || !(data.get("candidates") instanceof List<?> candidates)) throw new TravelError("candidate_not_found");
            var matches = candidates.stream().filter(raw -> raw instanceof Map<?, ?> item && sourceId.equals(item.get("sourceId"))).toList();
            if (matches.size() != 1 || !(((Map<?, ?>) matches.get(0)).get("name") instanceof String title) || title.isBlank() || title.length() > 200)
                throw new TravelError("candidate_not_found");
            jdbc.update("""
                    INSERT INTO travel_journal_entries(entry_id,trip_id,created_by,result_id,source_id,place_title,subject,stage,note,taken_on)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                    """, entry, trip, actor, resultId, sourceId, title, subject, stage, safeNote, savedDate);
            for (int index = 0; index < photos.size(); index++) {
                var image = photos.get(index); var photo = image.photo();
                jdbc.update("INSERT INTO travel_journal_photos(entry_id,photo_index,width,height,image_bytes,relief) VALUES (?,?,?,?,?,CAST(? AS jsonb))",
                        entry, index, photo.width(), photo.height(), photo.bytes(), image.relief() == null ? null : json.writeValueAsString(image.relief()));
            }
            return Map.of("tripId", trip.toString(), "entryId", entry.toString());
        });
    }

    public Map<String, Object> delete(UUID actor, UUID trip, long expectedRevision, String requestId, UUID entry) {
        return delete(actor, trip, expectedRevision, requestId, entry, null);
    }

    public Map<String, Object> delete(UUID actor, UUID trip, long expectedRevision, String requestId, UUID entry, Long entryRevision) {
        if (actor == null || trip == null || expectedRevision < 0 || entry == null) throw new TravelError("journal_input_invalid");
        var input = new LinkedHashMap<String, Object>(); input.put("tripId", trip.toString()); input.put("expectedRevision", expectedRevision); input.put("entryId", entry.toString());
        if (entryRevision != null) input.put("expectedEntryRevision", entryRevision);
        return receipt(actor, trip, entry, requestId, "journal_delete", input,
                expectedRevision, () -> {
            if (entryRevision != null && ((Number) readOne(trip, entry).get("entryRevision")).longValue() != entryRevision) throw new TravelError("journal_revision_conflict");
            int removed = jdbc.update("DELETE FROM travel_journal_entries WHERE trip_id=? AND entry_id=?", trip, entry);
            if (removed != 1) throw new TravelError("journal_entry_not_found");
            jdbc.update("INSERT INTO travel_journal_tombstones(trip_id,entry_id) VALUES (?,?)", trip, entry);
            return Map.of("tripId", trip.toString(), "entryId", entry.toString());
        });
    }

    public Map<String, Object> saveEntry(UUID actor, UUID trip, long tripRevision, String requestId, UUID entry,
            long entryRevision, String title, String note, String takenOn, String subject, String stage,
            String visitStopId, List<?> inputPhotos) {
        if (actor == null || trip == null || entry == null || entry.version() != 4 || entryRevision < -1 || tripRevision < 0 || title == null || title.length() > 120
                || note == null || note.length() > 1000 || subject == null || !Set.of("landscape", "building", "food").contains(subject)
                || stage == null || !Set.of("wish", "visited").contains(stage) || inputPhotos == null || inputPhotos.size() > 3
                || (visitStopId != null && !visitStopId.matches("[A-Za-z0-9_.:-]{1,128}"))) throw new TravelError("journal_input_invalid");
        var safe = TripStateFactory.safeObject(Map.of("title", title.trim(), "note", note.trim()));
        String safeTitle = (String) safe.get("title"), safeNote = (String) safe.get("note");
        if (safeTitle.isBlank() && safeNote.isBlank() && inputPhotos.isEmpty()) throw new TravelError("journal_empty");
        LocalDate date = journalDate(takenOn);
        var input = new LinkedHashMap<String, Object>();
        input.put("tripId", trip.toString()); input.put("expectedRevision", tripRevision); input.put("entryId", entry.toString());
        input.put("expectedEntryRevision", entryRevision); input.put("title", safeTitle); input.put("note", safeNote);
        input.put("takenOn", date == null ? null : date.toString()); input.put("subject", subject); input.put("stage", stage);
        input.put("visitStopId", visitStopId); input.put("photos", inputPhotos);
        return receipt(actor, trip, entry, requestId, "journal_save", input, tripRevision, () -> {
            var existing = jdbc.query("SELECT revision,visit_stop_id FROM travel_journal_entries WHERE trip_id=? AND entry_id=?",
                    (rs, n) -> new EntryVersion(rs.getLong(1), rs.getString(2)), trip, entry);
            boolean creating = entryRevision == -1;
            if (creating && (!existing.isEmpty() || jdbc.queryForObject("SELECT count(*) FROM travel_journal_tombstones WHERE entry_id=?", Integer.class, entry) > 0))
                throw new TravelError("journal_id_conflict");
            if (!creating && existing.isEmpty()) throw new TravelError("journal_entry_not_found");
            if (!creating && existing.get(0).revision() != entryRevision) throw new TravelError("journal_revision_conflict");
            if (creating && jdbc.queryForObject("SELECT count(*) FROM travel_journal_entries WHERE trip_id=?", Integer.class, trip) >= 40)
                throw new TravelError("journal_trip_limit");
            if (visitStopId != null && (creating || !visitStopId.equals(existing.get(0).visit()))) requireVisit(trip, visitStopId);
            var stored = jdbc.query("SELECT photo_id,image_bytes,width,height,relief::text FROM travel_journal_photos WHERE entry_id=?",
                    (rs, n) -> new StoredImage(rs.getObject(1, UUID.class), rs.getBytes(2), rs.getInt(3), rs.getInt(4), rs.getString(5)), entry);
            var prepared = new ArrayList<StoredImage>();
            var identities = new java.util.HashSet<UUID>();
            for (Object raw : inputPhotos) {
                if (!(raw instanceof Map<?, ?> image) || !Set.of("photoId", "data", "relief").containsAll(image.keySet())) throw new TravelError("journal_photo_invalid");
                UUID id;
                try { id = UUID.fromString((String) image.get("photoId")); } catch (RuntimeException invalid) { throw new TravelError("journal_photo_invalid"); }
                if (id.version() != 4 || !identities.add(id)) throw new TravelError("journal_photo_invalid");
                var old = stored.stream().filter(item -> item.id().equals(id)).findFirst().orElse(null);
                if (old == null) {
                    if (jdbc.queryForObject("SELECT count(*) FROM travel_journal_photos WHERE photo_id=?", Integer.class, id) > 0) throw new TravelError("journal_photo_invalid");
                    var photo = JournalJpeg.sanitize(image.get("data"));
                    var recipe = validateRelief(subject, image.get("relief"));
                    prepared.add(new StoredImage(id, photo.bytes(), photo.width(), photo.height(), recipe == null ? null : json.writeValueAsString(recipe)));
                } else {
                    if (image.containsKey("data")) throw new TravelError("journal_photo_invalid");
                    Object value = image.containsKey("relief") ? image.get("relief") : old.relief() == null ? null : json.readValue(old.relief(), Map.class);
                    var recipe = validateRelief(subject, value);
                    prepared.add(new StoredImage(id, old.bytes(), old.width(), old.height(), recipe == null ? null : json.writeValueAsString(recipe)));
                }
            }
            long next = creating ? 0 : entryRevision + 1;
            if (creating) jdbc.update("""
                    INSERT INTO travel_journal_entries(entry_id,trip_id,created_by,place_title,title,note,taken_on,subject,stage,visit_stop_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                    """, entry, trip, actor, "", safeTitle, safeNote, date, subject, stage, visitStopId);
            else jdbc.update("""
                    UPDATE travel_journal_entries SET title=?,note=?,taken_on=?,subject=?,stage=?,visit_stop_id=?,revision=?,updated_at=CURRENT_TIMESTAMP
                    WHERE trip_id=? AND entry_id=?
                    """, safeTitle, safeNote, date, subject, stage, visitStopId, next, trip, entry);
            jdbc.update("DELETE FROM travel_journal_photos WHERE entry_id=?", entry);
            for (int i = 0; i < prepared.size(); i++) {
                var photo = prepared.get(i);
                jdbc.update("INSERT INTO travel_journal_photos(entry_id,photo_index,photo_id,width,height,image_bytes,relief) VALUES (?,?,?,?,?,?,CAST(? AS jsonb))",
                        entry, i, photo.id(), photo.width(), photo.height(), photo.bytes(), photo.relief());
            }
            return Map.of("tripId", trip.toString(), "entryId", entry.toString(), "entryRevision", next);
        });
    }

    public Map<String, Object> saveRelief(UUID actor, UUID trip, long tripRevision, String requestId, UUID entry,
            long entryRevision, UUID photo, Map<String, Object> recipe) {
        if (actor == null || trip == null || entry == null || photo == null || recipe == null || entryRevision < 0 || tripRevision < 0) throw new TravelError("journal_input_invalid");
        return receipt(actor, trip, entry, requestId, "journal_relief", Map.of("tripId", trip.toString(), "expectedRevision", tripRevision,
                "entryId", entry.toString(), "expectedEntryRevision", entryRevision, "photoId", photo.toString(), "relief", recipe), tripRevision, () -> {
            var item = readOne(trip, entry);
            if (((Number) item.get("entryRevision")).longValue() != entryRevision) throw new TravelError("journal_revision_conflict");
            var value = validateRelief((String) item.get("subject"), recipe);
            int count = jdbc.update("UPDATE travel_journal_photos SET relief=CAST(? AS jsonb) WHERE entry_id=? AND photo_id=?", json.writeValueAsString(value), entry, photo);
            if (count != 1) throw new TravelError("journal_photo_not_found");
            jdbc.update("UPDATE travel_journal_entries SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE entry_id=?", entry);
            return Map.of("tripId", trip.toString(), "entryId", entry.toString(), "entryRevision", entryRevision + 1);
        });
    }

    public Map<String, Object> get(UUID actor, UUID trip, UUID entry) {
        return transactions.execute(status -> { requireReadLocked(actor, trip); return Map.of("entry", readOne(trip, entry)); });
    }

    public Map<String, Object> photoById(UUID actor, UUID trip, UUID entry, UUID photo) {
        return transactions.execute(status -> {
            requireReadLocked(actor, trip);
            var data = jdbc.query("SELECT p.image_bytes FROM travel_journal_photos p JOIN travel_journal_entries e ON e.entry_id=p.entry_id WHERE e.trip_id=? AND e.entry_id=? AND p.photo_id=?",
                    (rs, n) -> rs.getBytes(1), trip, entry, photo);
            if (data.isEmpty()) throw new TravelError("journal_photo_not_found");
            return Map.of("mimeType", "image/jpeg", "data", Base64.getEncoder().encodeToString(data.get(0)));
        });
    }

    private void requireVisit(UUID trip, String stop) {
        Boolean exists = jdbc.queryForObject("""
                SELECT EXISTS(SELECT 1 FROM travel_trips t,jsonb_array_elements(COALESCE(t.state->'planning'->'adopted'->'stops','[]'::jsonb)) s
                    WHERE t.trip_id=? AND s->>'stopId'=?
                UNION ALL SELECT 1 FROM travel_itinerary_drafts d,jsonb_array_elements(COALESCE(d.draft->'stops','[]'::jsonb)) s
                    WHERE d.trip_id=? AND s->>'stopId'=?)
                """, Boolean.class, trip, stop, trip, stop);
        if (!Boolean.TRUE.equals(exists)) throw new TravelError("journal_visit_not_found");
    }

    private static LocalDate journalDate(String value) {
        if (value == null || value.isBlank()) return null;
        try { if (!value.matches("\\d{4}-\\d{2}-\\d{2}")) throw new IllegalArgumentException(); return LocalDate.parse(value); }
        catch (RuntimeException invalid) { throw new TravelError("journal_input_invalid"); }
    }

    public Map<String, Object> list(UUID actor, UUID trip) {
        return transactions.execute(status -> {
            requireReadLocked(actor, trip);
            var items = jdbc.query("""
                    SELECT entry_id,place_title,subject,stage,note,taken_on,created_at,title,visit_stop_id,revision,updated_at FROM travel_journal_entries
                    WHERE trip_id=? ORDER BY created_at DESC,entry_id DESC
                    """, (rs, n) -> entryView(rs), trip);
            var photosByEntry = new LinkedHashMap<String, List<Map<String, Object>>>();
            for (var item : items) { var photos = new ArrayList<Map<String, Object>>(); photosByEntry.put((String) item.get("entryId"), photos); item.put("photos", photos); }
            var photos = jdbc.query("""
                    SELECT p.entry_id,p.photo_index,p.width,p.height,octet_length(p.image_bytes),p.relief::text,p.photo_id
                    FROM travel_journal_photos p JOIN travel_journal_entries e ON e.entry_id=p.entry_id
                    WHERE e.trip_id=? ORDER BY p.entry_id,p.photo_index
                    """, (rs, n) -> new JournalPhoto(rs.getObject(1, UUID.class).toString(), photoView(rs, 2)), trip);
            for (var photo : photos) photosByEntry.get(photo.entryId()).add(photo.metadata());
            return Map.of("items", items);
        });
    }

    public Map<String, Object> photo(UUID actor, UUID trip, UUID entry, int index) {
        if (actor == null || trip == null || entry == null || index < 0 || index > 2) throw new TravelError("journal_photo_not_found");
        return transactions.execute(status -> {
            requireReadLocked(actor, trip);
            var rows = jdbc.query("""
                    SELECT p.image_bytes FROM travel_journal_photos p JOIN travel_journal_entries e ON e.entry_id=p.entry_id
                    WHERE e.trip_id=? AND e.entry_id=? AND p.photo_index=?
                    """, (rs, n) -> rs.getBytes(1), trip, entry, index);
            if (rows.isEmpty()) throw new TravelError("journal_photo_not_found");
            return Map.of("mimeType", "image/jpeg", "data", Base64.getEncoder().encodeToString(rows.get(0)));
        });
    }

    private Map<String, Object> receipt(UUID actor, UUID trip, UUID entry, String requestId, String type, Object input,
                                         long expectedRevision, Supplier<Map<String, Object>> operation) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String digest = sha256(json.writeValueAsString(canonical(input)).getBytes(StandardCharsets.UTF_8));
        return transactions.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> {}, actor + ":" + requestId);
            long revision = requireEditorLocked(actor, trip);
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> {}, "journal-entry:" + entry);
            var prior = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> new Prior(rs.getString(1), rs.getString(2), rs.getString(3)), actor, requestId);
            if (!prior.isEmpty()) {
                var old = prior.get(0);
                if (!type.equals(old.type()) || !digest.equals(old.digest())) throw new TravelError("request_id_conflict");
                var response = json.readValue(old.response(), Map.class);
                if (!trip.toString().equals(response.get("tripId")) || !entry.toString().equals(response.get("entryId"))) throw new TravelError("request_id_conflict");
                return withAppliedRevision(current(trip, entry, type), response);
            }
            if (revision != expectedRevision) throw new TravelError("revision_conflict");
            var saved = operation.get();
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?,?,CAST(? AS jsonb))",
                    actor, requestId, type, digest, json.writeValueAsString(saved));
            return withAppliedRevision(current(trip, entry, type), saved);
        });
    }

    private Map<String, Object> current(UUID trip, UUID entry, String type) {
        Integer count = jdbc.queryForObject("SELECT count(*) FROM travel_journal_entries WHERE trip_id=? AND entry_id=?", Integer.class, trip, entry);
        if (count == null || count == 0) return Map.of("status", "deleted", "entryId", entry.toString());
        if ("journal_delete".equals(type)) return Map.of("status", "present", "entryId", entry.toString());
        return Map.of("status", "saved", "entry", readOne(trip, entry));
    }

    private Map<String, Object> readOne(UUID trip, UUID entry) {
        var rows = jdbc.query("""
                SELECT entry_id,place_title,subject,stage,note,taken_on,created_at,title,visit_stop_id,revision,updated_at FROM travel_journal_entries WHERE trip_id=? AND entry_id=?
                """, (rs, n) -> entryView(rs), trip, entry);
        if (rows.isEmpty()) throw new TravelError("journal_entry_not_found");
        var item = rows.get(0);
        item.put("photos", jdbc.query("SELECT photo_index,width,height,octet_length(image_bytes),relief::text,photo_id FROM travel_journal_photos WHERE entry_id=? ORDER BY photo_index",
                (rs, n) -> photoView(rs, 1), entry));
        return item;
    }

    private Map<String, Object> photoView(java.sql.ResultSet rs, int start) throws java.sql.SQLException {
        var photo = new LinkedHashMap<String, Object>(); photo.put("index", rs.getInt(start)); photo.put("width", rs.getInt(start + 1));
        photo.put("height", rs.getInt(start + 2)); photo.put("byteLength", rs.getInt(start + 3));
        String relief = rs.getString(start + 4); photo.put("relief", relief == null ? null : json.readValue(relief, new tools.jackson.core.type.TypeReference<Map<String, Object>>() {}));
        photo.put("photoId", rs.getObject(start + 5, UUID.class).toString());
        return photo;
    }

    private static Map<String, Object> validateRelief(String subject, Object value) {
        if (value == null) return null;
        if ("food".equals(subject)) throw new TravelError("journal_relief_subject_unsupported");
        if (!(value instanceof Map<?, ?> recipe) || !recipe.keySet().equals(Set.of("version", "horizon", "depth", "style"))
                || !"photo-relief-v1".equals(recipe.get("version"))
                || !(recipe.get("horizon") instanceof Number horizon) || !Double.isFinite(horizon.doubleValue()) || horizon.doubleValue() < .2 || horizon.doubleValue() > .8
                || !(recipe.get("depth") instanceof Number depth) || !Double.isFinite(depth.doubleValue()) || depth.doubleValue() < .15 || depth.doubleValue() > 1
                || !(recipe.get("style") instanceof String style) || !Set.of("ink", "photo").contains(style)) throw new TravelError("journal_relief_invalid");
        return Map.of("version", "photo-relief-v1", "horizon", horizon.doubleValue(), "depth", depth.doubleValue(), "style", style);
    }

    private static Map<String, Object> entryView(java.sql.ResultSet rs) throws java.sql.SQLException {
        var item = new LinkedHashMap<String, Object>(); item.put("entryId", rs.getObject(1, UUID.class).toString()); item.put("placeTitle", rs.getString(2));
        item.put("subject", rs.getString(3)); item.put("stage", rs.getString(4)); item.put("note", rs.getString(5));
        item.put("takenOn", rs.getDate(6) == null ? null : rs.getDate(6).toLocalDate().toString()); item.put("createdAt", rs.getTimestamp(7).toInstant().toString());
        item.put("title", rs.getString(8)); item.put("visitStopId", rs.getString(9)); item.put("entryRevision", rs.getLong(10)); item.put("updatedAt", rs.getTimestamp(11).toInstant().toString()); return item;
    }

    private void requireReadLocked(UUID actor, UUID trip) {
        if (actor == null || trip == null) throw new TravelError("trip_not_found");
        var rows = jdbc.query("""
                SELECT t.trip_id FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                WHERE t.trip_id=? AND a.account_id=? FOR SHARE OF t
                """, (rs, n) -> rs.getObject(1, UUID.class), trip, actor);
        if (rows.isEmpty()) throw new TravelError("trip_not_found");
    }
    private long requireEditorLocked(UUID actor, UUID trip) {
        var rows = jdbc.query("""
                SELECT t.revision FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                WHERE t.trip_id=? AND a.account_id=? AND a.role IN ('owner','editor') FOR UPDATE OF t
                """, (rs, n) -> rs.getLong(1), trip, actor);
        if (rows.isEmpty()) throw new TravelError("trip_not_found");
        return rows.get(0);
    }
    private static Object canonical(Object input) {
        if (input instanceof Map<?, ?> map) { var sorted = new TreeMap<String, Object>(); map.forEach((key, value) -> sorted.put((String) key, canonical(value))); return sorted; }
        if (input instanceof List<?> list) return list.stream().map(TravelJournal::canonical).toList();
        return input;
    }
    private static String sha256(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static Map<String, Object> withAppliedRevision(Map<String, Object> current, Map<?, ?> applied) {
        if (!applied.containsKey("entryRevision")) return current;
        var result = new LinkedHashMap<>(current); result.put("appliedEntryRevision", applied.get("entryRevision")); return result;
    }
    private record Prior(String type, String digest, String response) {}
    private record EntryVersion(long revision, String visit) {}
    private record StoredImage(UUID id, byte[] bytes, int width, int height, String relief) {}
    private record JournalPhoto(String entryId, Map<String, Object> metadata) {}
    private record JournalImage(JournalJpeg.Photo photo, Map<String, Object> relief) {}
}
