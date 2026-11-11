package app.travelagent.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** Component layout has its own revision and never changes the travel state. */
@Service
public class WorkbenchDocuments {
    private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() {};
    private static final List<String> FIXED = WorkbenchCatalog.fixedTypes();
    private static final List<String> REGISTERED = WorkbenchCatalog.registeredTypes();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JsonMapper json = JsonMapper.builder().build();

    public WorkbenchDocuments(JdbcTemplate jdbc, TransactionTemplate transactions) { this.jdbc = jdbc; this.transactions = transactions; }

    public Map<String, Object> catalog() { return WorkbenchCatalog.view(); }

    public Map<String, Object> get(UUID actor, UUID trip) {
        if (actor == null || trip == null) throw new TravelError("trip_not_found");
        return transactions.execute(status -> { lockAndAuthorize(actor, trip, false); ensure(trip); return read(trip); });
    }

    public Map<String, Object> compose(UUID actor, UUID trip, long expectedTripRevision, long expectedLayoutRevision,
                                       String requestId, List<String> componentTypes) {
        if (actor == null || trip == null || expectedTripRevision < 0 || expectedLayoutRevision < 0
                || requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}") || componentTypes == null
                || componentTypes.size() < 2 || componentTypes.size() > REGISTERED.size()
                || !componentTypes.subList(0, 2).equals(FIXED) || componentTypes.stream().anyMatch(java.util.Objects::isNull) || !REGISTERED.containsAll(componentTypes)
                || new java.util.HashSet<>(componentTypes).size() != componentTypes.size())
            throw new TravelError("invalid_component_layout");
        String digest = hash(json.writeValueAsString(List.of(trip.toString(), expectedTripRevision, expectedLayoutRevision, componentTypes)));
        return transactions.execute(status -> {
            advisory(actor + ":" + requestId);
            long revision = lockAndAuthorize(actor, trip, true);
            var receipts = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> new Receipt(rs.getString(1), rs.getString(2), rs.getString(3)), actor, requestId);
            if (!receipts.isEmpty()) {
                var prior = receipts.get(0);
                if (!"compose_workbench".equals(prior.type()) || !digest.equals(prior.digest())) throw new TravelError("request_id_conflict");
                return read(trip);
            }
            if (revision != expectedTripRevision) throw new TravelError("revision_conflict");
            ensure(trip);
            var documents = jdbc.query("SELECT layout_revision,document::text FROM travel_workbench_documents WHERE trip_id=? FOR UPDATE",
                    (rs, n) -> new Document(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), trip);
            var current = documents.get(0);
            if (current.revision() != expectedLayoutRevision) throw new TravelError("layout_revision_conflict");
            var existing = components(current.content());
            var removed = removed(current.content());
            if (componentTypes.stream().anyMatch(removed::contains)) throw new TravelError("protected_component");
            var seen = new java.util.HashSet<String>();
            for (var component : existing) {
                if (!(component.get("type") instanceof String type) || !WorkbenchCatalog.supports(component) || !seen.add(type))
                    throw new TravelError("unsupported_component_preserved");
                if (!componentTypes.contains(type) && (Boolean.TRUE.equals(component.get("pinned")) || Boolean.TRUE.equals(component.get("userModified"))))
                    throw new TravelError("protected_component");
            }
            var next = new ArrayList<Map<String, Object>>();
            for (String type : componentTypes) {
                var previous = existing.stream().filter(item -> type.equals(item.get("type"))).findFirst();
                if ("places".equals(type) && previous.isEmpty()) throw new TravelError("component_data_required");
                next.add(previous.orElseGet(() -> component(type)));
            }
            long layoutRevision = current.revision();
            if (!existing.equals(next)) {
                layoutRevision++;
                jdbc.update("UPDATE travel_workbench_documents SET layout_revision=?,document=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                        layoutRevision, json.writeValueAsString(document(current.content(), next, removed, removedComponents(current.content()))), trip);
            }
            var result = read(trip);
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?, ?, CAST(? AS jsonb))",
                    actor, requestId, "compose_workbench", digest, json.writeValueAsString(result));
            return result;
        });
    }

    /** App-only action is still protected by the authenticated account, role and revisions. */
    public Map<String, Object> userEdit(UUID actor, UUID trip, long expectedTripRevision, long expectedLayoutRevision,
                                        String requestId, String action) {
        return userEdit(actor, trip, expectedTripRevision, expectedLayoutRevision, requestId, action, "requirements");
    }

    public Map<String, Object> userEdit(UUID actor, UUID trip, long expectedTripRevision, long expectedLayoutRevision,
                                        String requestId, String action, String componentType) {
        if (actor == null || trip == null || expectedTripRevision < 0 || expectedLayoutRevision < 0
                || requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")
                || action == null || !List.of("pin", "unpin", "hide", "show").contains(action)
                || componentType == null || !List.of("requirements", "places").contains(componentType)) throw new TravelError("invalid_component_layout");
        String digest = hash(json.writeValueAsString(List.of(trip.toString(), expectedTripRevision, expectedLayoutRevision, action, componentType)));
        return transactions.execute(status -> {
            advisory(actor + ":" + requestId);
            long revision = lockAndAuthorize(actor, trip, true);
            var receipts = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> new Receipt(rs.getString(1), rs.getString(2), rs.getString(3)), actor, requestId);
            if (!receipts.isEmpty()) {
                var prior = receipts.get(0);
                if (!"edit_workbench".equals(prior.type()) || !digest.equals(prior.digest())) throw new TravelError("request_id_conflict");
                return read(trip);
            }
            if (revision != expectedTripRevision) throw new TravelError("revision_conflict");
            ensure(trip);
            var docs = jdbc.query("SELECT layout_revision,document::text FROM travel_workbench_documents WHERE trip_id=? FOR UPDATE",
                    (rs, n) -> new Document(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), trip);
            var current = docs.get(0);
            if (current.revision() != expectedLayoutRevision) throw new TravelError("layout_revision_conflict");
            var existing = components(current.content());
            var next = new ArrayList<Map<String, Object>>(existing);
            var removed = new ArrayList<>(removed(current.content()));
            var removedItems = new LinkedHashMap<>(removedComponents(current.content()));
            int index = -1;
            for (int i = 0; i < next.size(); i++) if (componentType.equals(next.get(i).get("type"))) { if (index >= 0) throw new TravelError("unsupported_component_preserved"); index = i; }
            if ("hide".equals(action) && index >= 0) { removedItems.put(componentType, next.remove(index)); if (!removed.contains(componentType)) removed.add(componentType); }
            else if ("show".equals(action) && index < 0) {
                var restored = removedItems.remove(componentType);
                if (restored == null && "places".equals(componentType)) throw new TravelError("component_data_required");
                var item = new LinkedHashMap<>(restored == null ? component(componentType) : restored);
                item.put("userModified", true); next.add(item); removed.remove(componentType);
            }
            else if (("pin".equals(action) || "unpin".equals(action)) && index >= 0) {
                var item = new LinkedHashMap<>(next.get(index));
                item.put("pinned", "pin".equals(action)); item.put("userModified", true); next.set(index, item);
            } else if (("pin".equals(action) || "unpin".equals(action)) && index < 0) throw new TravelError("component_not_found");
            if (!existing.equals(next) || !removed(current.content()).equals(removed)) {
                jdbc.update("UPDATE travel_workbench_documents SET layout_revision=?,document=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                        current.revision() + 1, json.writeValueAsString(document(current.content(), next, removed, removedItems)), trip);
            }
            var result = read(trip);
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?, ?, CAST(? AS jsonb))",
                    actor, requestId, "edit_workbench", digest, json.writeValueAsString(result));
            return result;
        });
    }

    /** Add a fresh source page without replacing earlier pages or changing the trip itself. */
    public Map<String, Object> presentPlaces(UUID actor, UUID trip, long expectedTripRevision, long expectedLayoutRevision,
                                             String requestId, UUID resultId) {
        if (actor == null || trip == null || resultId == null || expectedTripRevision < 0 || expectedLayoutRevision < 0
                || requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_component_layout");
        String digest = hash(json.writeValueAsString(List.of(trip.toString(), expectedTripRevision, expectedLayoutRevision, resultId.toString())));
        return transactions.execute(status -> {
            advisory(actor + ":" + requestId);
            long revision = lockAndAuthorize(actor, trip, true);
            var receipts = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> new Receipt(rs.getString(1), rs.getString(2), rs.getString(3)), actor, requestId);
            if (!receipts.isEmpty()) {
                var prior = receipts.get(0);
                if (!"present_places".equals(prior.type()) || !digest.equals(prior.digest())) throw new TravelError("request_id_conflict");
                var current = new LinkedHashMap<>(read(trip));
                @SuppressWarnings("unchecked") var content = (Map<String, Object>) current.get("document");
                String presentation = "no_longer_present";
                if (pendingPlaces(content).contains(resultId.toString())) presentation = "pending_confirmation";
                else if (components(content).stream().anyMatch(item -> "places".equals(item.get("type")) && placeResultIds(item).contains(resultId.toString()))) presentation = "shown";
                else {
                    var hidden = removedComponents(content).get("places");
                    if (hidden != null && placeResultIds(hidden).contains(resultId.toString())) presentation = "already_hidden";
                }
                current.put("presentation", presentation);
                return current;
            }
            if (revision != expectedTripRevision) throw new TravelError("revision_conflict");
            requireFreshPlaces(trip, resultId, revision);
            ensure(trip);
            var docs = jdbc.query("SELECT layout_revision,document::text FROM travel_workbench_documents WHERE trip_id=? FOR UPDATE",
                    (rs, n) -> new Document(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), trip);
            var current = docs.get(0);
            if (current.revision() != expectedLayoutRevision) throw new TravelError("layout_revision_conflict");
            var existing = components(current.content());
            var next = new ArrayList<Map<String, Object>>(existing);
            var pending = new ArrayList<>(pendingPlaces(current.content()));
            int index = -1;
            for (int i = 0; i < next.size(); i++) if ("places".equals(next.get(i).get("type"))) { if (index >= 0) throw new TravelError("unsupported_component_preserved"); index = i; }
            boolean hidden = removed(current.content()).contains("places");
            if (hidden && index >= 0) throw new TravelError("unsupported_component_preserved");
            var hiddenItem = removedComponents(current.content()).get("places");
            if ((index >= 0 && !WorkbenchCatalog.supports(next.get(index))) || (hiddenItem != null && !WorkbenchCatalog.supports(hiddenItem)))
                throw new TravelError("unsupported_component_preserved");
            boolean alreadyShown = index >= 0 && placeResultIds(next.get(index)).contains(resultId.toString());
            boolean alreadyHidden = hidden && hiddenItem != null && placeResultIds(hiddenItem).contains(resultId.toString());
            boolean protectedItem = index >= 0 && (Boolean.TRUE.equals(next.get(index).get("pinned")) || Boolean.TRUE.equals(next.get(index).get("userModified")));
            String presentation = alreadyHidden ? "already_hidden" : "shown";
            if (!alreadyShown && !alreadyHidden && (hidden || protectedItem || pending.contains(resultId.toString()))) {
                presentation = "pending_confirmation";
                if (!pending.contains(resultId.toString())) {
                    if (pending.size() >= 128) throw new TravelError("component_capacity_exceeded");
                    pending.add(resultId.toString());
                }
            } else if (!alreadyShown && !alreadyHidden && index < 0) next.add(placeComponent(resultId));
            else if (!alreadyShown && !alreadyHidden) {
                var item = new LinkedHashMap<>(next.get(index));
                var resultIds = new ArrayList<>(placeResultIds(item));
                if (resultIds.size() >= 128) throw new TravelError("component_capacity_exceeded");
                resultIds.add(resultId.toString()); item.put("resultIds", resultIds);
                next.set(index, item);
            }
            if (!existing.equals(next) || !pendingPlaces(current.content()).equals(pending)) {
                var updated = document(current.content(), next, removed(current.content()), removedComponents(current.content()));
                updated.put("pendingPlaceResults", pending);
                jdbc.update("UPDATE travel_workbench_documents SET layout_revision=?,document=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                        current.revision() + 1, json.writeValueAsString(updated), trip);
            }
            var result = new LinkedHashMap<>(read(trip));
            result.put("presentation", presentation);
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?, ?, CAST(? AS jsonb))",
                    actor, requestId, "present_places", digest, json.writeValueAsString(result));
            return result;
        });
    }

    /** User review changes the layout only; it never adopts an itinerary or makes a booking. */
    public Map<String, Object> decidePlaces(UUID actor, UUID trip, long expectedTripRevision, long expectedLayoutRevision,
                                           String requestId, UUID resultId, String decision) {
        if (actor == null || trip == null || resultId == null || expectedTripRevision < 0 || expectedLayoutRevision < 0
                || requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}") || decision == null || !List.of("accept", "reject").contains(decision))
            throw new TravelError("invalid_component_layout");
        String digest = hash(json.writeValueAsString(List.of(trip.toString(), expectedTripRevision, expectedLayoutRevision, resultId.toString(), decision)));
        return transactions.execute(status -> {
            advisory(actor + ":" + requestId);
            long revision = lockAndAuthorize(actor, trip, true);
            var receipts = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> new Receipt(rs.getString(1), rs.getString(2), rs.getString(3)), actor, requestId);
            if (!receipts.isEmpty()) {
                var prior = receipts.get(0);
                if (!"decide_places".equals(prior.type()) || !digest.equals(prior.digest())) throw new TravelError("request_id_conflict");
                return read(trip);
            }
            if (revision != expectedTripRevision) throw new TravelError("revision_conflict");
            ensure(trip);
            var docs = jdbc.query("SELECT layout_revision,document::text FROM travel_workbench_documents WHERE trip_id=? FOR UPDATE",
                    (rs, n) -> new Document(rs.getLong(1), json.readValue(rs.getString(2), OBJECT)), trip);
            var current = docs.get(0);
            if (current.revision() != expectedLayoutRevision) throw new TravelError("layout_revision_conflict");
            var pending = new ArrayList<>(pendingPlaces(current.content()));
            if (!pending.remove(resultId.toString())) throw new TravelError("suggestion_not_found");
            var next = new ArrayList<>(components(current.content()));
            var removed = new ArrayList<>(removed(current.content()));
            var removedItems = new LinkedHashMap<>(removedComponents(current.content()));
            if ("accept".equals(decision)) {
                requireFreshPlaces(trip, resultId, revision);
                int index = -1;
                for (int i = 0; i < next.size(); i++) if ("places".equals(next.get(i).get("type"))) { if (index >= 0) throw new TravelError("unsupported_component_preserved"); index = i; }
                boolean hidden = removed.contains("places");
                if (hidden && index >= 0) throw new TravelError("unsupported_component_preserved");
                Map<String, Object> previous = index >= 0 ? next.get(index) : hidden ? removedItems.get("places") : null;
                if (hidden && previous == null) throw new TravelError("unsupported_component_preserved");
                if (previous != null && !WorkbenchCatalog.supports(previous)) throw new TravelError("unsupported_component_preserved");
                var item = previous == null ? new LinkedHashMap<>(placeComponent(resultId)) : new LinkedHashMap<>(previous);
                var ids = new ArrayList<>(placeResultIds(item));
                if (!ids.contains(resultId.toString())) {
                    if (ids.size() >= 128) throw new TravelError("component_capacity_exceeded");
                    ids.add(resultId.toString()); item.put("resultIds", ids);
                }
                item.put("userModified", true);
                if (index < 0) next.add(item); else next.set(index, item);
                if (hidden) { removed.remove("places"); removedItems.remove("places"); }
            }
            var updated = document(current.content(), next, removed, removedItems);
            updated.put("pendingPlaceResults", pending);
            jdbc.update("UPDATE travel_workbench_documents SET layout_revision=?,document=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                    current.revision() + 1, json.writeValueAsString(updated), trip);
            var result = read(trip);
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?, ?, CAST(? AS jsonb))",
                    actor, requestId, "decide_places", digest, json.writeValueAsString(result));
            return result;
        });
    }

    private void requireFreshPlaces(UUID trip, UUID result, long revision) {
        var refs = jdbc.query("""
                SELECT kind,trip_revision,(data IS NOT NULL AND fresh_until>CURRENT_TIMESTAMP) AS fresh
                FROM travel_result_references WHERE result_id=? AND trip_id=?
                """, (rs, n) -> Map.<String, Object>of("kind", rs.getString(1), "revision", rs.getLong(2), "fresh", rs.getBoolean(3)), result, trip);
        if (refs.isEmpty() || !"places".equals(refs.get(0).get("kind"))) throw new TravelError("result_not_found");
        if (!Boolean.TRUE.equals(refs.get(0).get("fresh"))) throw new TravelError("result_expired");
        if (((Number) refs.get(0).get("revision")).longValue() != revision) throw new TravelError("result_stale");
    }

    private static List<String> pendingPlaces(Map<String, Object> document) {
        Object value = document.get("pendingPlaceResults");
        if (value == null) return List.of();
        if (!(value instanceof List<?> list) || list.size() > 128 || list.stream().anyMatch(id -> !(id instanceof String))
                || new java.util.HashSet<>(list).size() != list.size()) throw new TravelError("unsupported_component_preserved");
        return list.stream().map(String.class::cast).toList();
    }

    private static List<String> placeResultIds(Map<String, Object> item) {
        Object value = item.get("resultIds");
        if (value == null && item.get("resultId") instanceof String id) return List.of(id);
        if (!(value instanceof List<?> list) || list.isEmpty() || list.size() > 128
                || list.stream().anyMatch(id -> !(id instanceof String)) || new java.util.HashSet<>(list).size() != list.size())
            throw new TravelError("unsupported_component_preserved");
        return list.stream().map(String.class::cast).toList();
    }

    private long lockAndAuthorize(UUID actor, UUID trip, boolean write) {
        var revisions = jdbc.query("SELECT revision FROM travel_trips WHERE trip_id=? FOR UPDATE", (rs, n) -> rs.getLong(1), trip);
        if (revisions.isEmpty()) throw new TravelError("trip_not_found");
        var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), trip, actor);
        if (roles.isEmpty() || (write && !("owner".equals(roles.get(0)) || "editor".equals(roles.get(0))))) throw new TravelError("trip_not_found");
        return revisions.get(0);
    }
    private void ensure(UUID trip) {
        var doc = Map.of("schemaVersion", "travel-workbench-v1", "components", List.of(component("itinerary"), component("map"), component("requirements")), "userRemoved", List.of());
        jdbc.update("INSERT INTO travel_workbench_documents(trip_id,document) VALUES (?,CAST(? AS jsonb)) ON CONFLICT (trip_id) DO NOTHING", trip, json.writeValueAsString(doc));
    }
    private Map<String, Object> read(UUID trip) {
        var rows = jdbc.query("SELECT layout_revision,document::text FROM travel_workbench_documents WHERE trip_id=?",
                (rs, n) -> Map.<String, Object>of("tripId", trip.toString(), "layoutRevision", rs.getLong(1), "document", json.readValue(rs.getString(2), OBJECT)), trip);
        if (rows.isEmpty()) throw new TravelError("workbench_not_found");
        return rows.get(0);
    }
    private static Map<String, Object> component(String type) {
        return Map.of("id", type, "type", type, "version", WorkbenchCatalog.version(type), "pinned", FIXED.contains(type), "userModified", false);
    }
    private static Map<String, Object> placeComponent(UUID resultId) {
        var item = new LinkedHashMap<>(component("places"));
        item.put("resultId", resultId.toString()); item.put("resultIds", List.of(resultId.toString()));
        return item;
    }
    @SuppressWarnings("unchecked") private static List<Map<String, Object>> components(Map<String, Object> document) {
        Object value = document.get("components");
        if (!(value instanceof List<?> list) || list.stream().anyMatch(item -> !(item instanceof Map<?, ?>))) throw new TravelError("invalid_component_layout");
        return (List<Map<String, Object>>) value;
    }
    private static List<String> removed(Map<String, Object> document) {
        Object value = document.get("userRemoved");
        if (value == null) return List.of();
        if (!(value instanceof List<?> list) || list.stream().anyMatch(item -> !(item instanceof String))) throw new TravelError("invalid_component_layout");
        return list.stream().map(String.class::cast).toList();
    }
    private static Map<String, Map<String, Object>> removedComponents(Map<String, Object> document) {
        Object value = document.get("removedComponents");
        if (value == null) return Map.of();
        if (!(value instanceof Map<?, ?> map)) throw new TravelError("invalid_component_layout");
        var result = new LinkedHashMap<String, Map<String, Object>>();
        for (var entry : map.entrySet()) {
            if (!(entry.getKey() instanceof String key) || !(entry.getValue() instanceof Map<?, ?> raw)) throw new TravelError("invalid_component_layout");
            var item = new LinkedHashMap<String, Object>();
            for (var field : raw.entrySet()) { if (!(field.getKey() instanceof String name)) throw new TravelError("invalid_component_layout"); item.put(name, field.getValue()); }
            result.put(key, item);
        }
        return result;
    }
    private static Map<String, Object> document(Map<String, Object> previous, List<Map<String, Object>> components,
                                                 List<String> removed, Map<String, Map<String, Object>> removedItems) {
        var result = new LinkedHashMap<>(previous);
        result.put("components", components); result.put("userRemoved", removed); result.put("removedComponents", removedItems);
        return result;
    }
    private void advisory(String value) { jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> {}, value); }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private record Receipt(String type, String digest, String response) {}
    private record Document(long revision, Map<String, Object> content) {}
}
