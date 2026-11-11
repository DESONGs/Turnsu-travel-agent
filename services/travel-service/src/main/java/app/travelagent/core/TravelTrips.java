package app.travelagent.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** The database transaction owns trip state, access and idempotent receipts. */
@Service
public final class TravelTrips {
    private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JsonMapper json;
    private final Clock clock;

    @Autowired
    public TravelTrips(JdbcTemplate jdbc, TransactionTemplate transactions) {
        this(jdbc, transactions, Clock.systemUTC());
    }

    public TravelTrips(JdbcTemplate jdbc, TransactionTemplate transactions, Clock clock) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.json = JsonMapper.builder().build();
        this.clock = clock;
    }

    public Map<String, Object> create(UUID accountId, String requestId, Map<String, Object> brief) {
        if (accountId == null) throw new TravelError("authentication_required");
        var checked = TripStateFactory.create(UUID.randomUUID().toString(), brief, clock.instant());
        var cleanBrief = asObject(checked.get("brief"));
        return receipt(accountId, requestId, "create_trip", Map.of("brief", cleanBrief), () -> {
            var id = UUID.fromString((String) checked.get("tripId"));
            jdbc.update("INSERT INTO travel_trips(trip_id, owner_id, state) VALUES (?, ?, CAST(? AS jsonb))",
                    id, accountId, json.writeValueAsString(checked));
            jdbc.update("INSERT INTO travel_trip_access(trip_id, account_id, role) VALUES (?, ?, 'owner')", id, accountId);
            return Map.of("tripId", id.toString(), "revision", 0, "accessRevision", 0, "role", "owner", "state", checked);
        });
    }

    public Map<String, Object> get(UUID accountId, UUID tripId) {
        requireIds(accountId, tripId);
        var rows = jdbc.query("""
                SELECT t.trip_id, t.revision, t.state::text, a.role, t.access_revision
                FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                WHERE t.trip_id=? AND a.account_id=?
                """, (rs, n) -> Map.<String, Object>of("tripId", rs.getObject("trip_id", UUID.class).toString(),
                "revision", rs.getLong("revision"), "accessRevision", rs.getLong("access_revision"), "role", rs.getString("role"), "state", parse(rs.getString("state"))), tripId, accountId);
        if (rows.isEmpty()) throw new TravelError("trip_not_found");
        return rows.get(0);
    }

    /** Scope updates are allowed only while the trip has no plan; later updates need the migrated planning rules. */
    public Map<String, Object> updateEmptyTripScope(UUID actor, UUID tripId, long expectedRevision,
                                                     String requestId, Map<String, Object> changes) {
        requireIds(actor, tripId);
        if (expectedRevision < 0 || changes == null || changes.isEmpty()) throw new TravelError("invalid_trip_input");
        if (changes.containsKey("journeys")) throw new TravelError("use_individual_journey_change");
        return receipt(actor, requestId, "update_trip_scope", Map.of("tripId", tripId.toString(),
                "expectedRevision", expectedRevision, "changes", changes), () -> requireEditorLocked(actor, tripId), () -> {
            var rows = jdbc.query("""
                    SELECT t.revision,t.state::text,a.role FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                    WHERE t.trip_id=? AND a.account_id=? AND a.role IN ('owner','editor') FOR UPDATE OF t
                    """, (rs, n) -> new EditableTrip(rs.getLong(1), parse(rs.getString(2)), rs.getString(3)), tripId, actor);
            if (rows.isEmpty()) throw new TravelError("trip_not_found");
            var current = rows.get(0);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            var state = current.state();
            if (hasPlanExceptRecordedTransport(state) || (hasRecordedTransport(state) && !Set.of("totalBudget", "currency").containsAll(changes.keySet())))
                throw new TravelError("scope_change_needs_planning_rules");
            var brief = new LinkedHashMap<>(asObject(state.get("brief")));
            brief.putAll(changes);
            var fresh = TripStateFactory.create(tripId.toString(), brief, clock.instant());
            if (canonical(state.get("brief")).equals(canonical(fresh.get("brief"))))
                return Map.of("tripId", tripId.toString(), "revision", current.revision(), "role", current.role(), "state", state);
            long next = current.revision() + 1;
            state.put("brief", fresh.get("brief"));
            state.put("budgetLedger", fresh.get("budgetLedger"));
            refreshRecordedTransportBudget(state);
            state.put("revision", next);
            state.put("storageVersion", next);
            state.put("updatedAt", clock.instant().toString());
            jdbc.update("UPDATE travel_trips SET revision=?,state=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                    next, json.writeValueAsString(state), tripId);
            return Map.of("tripId", tripId.toString(), "revision", next, "role", current.role(), "state", state);
        });
    }

    /** Update one direction without replacing unrelated outbound, return or transfer requests. */
    public Map<String, Object> upsertEmptyTripJourney(UUID actor, UUID tripId, long expectedRevision, String requestId, Map<String, Object> input) {
        var journey = TripStateFactory.safeObject(input);
        TripStateFactory.validateJourneys(List.of(journey));
        return changeJourney(actor, tripId, expectedRevision, requestId, journey, null);
    }

    public Map<String, Object> removeEmptyTripJourney(UUID actor, UUID tripId, long expectedRevision, String requestId, String journeyId) {
        if (journeyId == null || !journeyId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_journeys");
        return changeJourney(actor, tripId, expectedRevision, requestId, null, journeyId);
    }

    private Map<String, Object> changeJourney(UUID actor, UUID tripId, long expectedRevision, String requestId, Map<String, Object> journey, String removeId) {
        requireIds(actor, tripId);
        if (expectedRevision < 0) throw new TravelError("invalid_trip_input");
        String type = journey == null ? "remove_trip_journey" : "upsert_trip_journey";
        Object detail = journey == null ? removeId : journey;
        return receipt(actor, requestId, type, Map.of("tripId", tripId.toString(), "expectedRevision", expectedRevision, "detail", detail),
                () -> requireEditorLocked(actor, tripId), () -> {
            var rows = jdbc.query("""
                    SELECT t.revision,t.state::text,a.role FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                    WHERE t.trip_id=? AND a.account_id=? AND a.role IN ('owner','editor') FOR UPDATE OF t
                    """, (rs, n) -> new EditableTrip(rs.getLong(1), parse(rs.getString(2)), rs.getString(3)), tripId, actor);
            if (rows.isEmpty()) throw new TravelError("trip_not_found");
            var current = rows.get(0);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            var state = current.state();
            if (hasPlanExceptRecordedTransport(state) || hasRecordedTransport(state)) throw new TravelError("scope_change_needs_planning_rules");
            var brief = new LinkedHashMap<>(asObject(state.get("brief")));
            Object stored = brief.getOrDefault("journeys", List.of());
            TripStateFactory.validateJourneys(stored);
            var original = (List<?>) stored;
            var nextJourneys = new ArrayList<Map<String, Object>>();
            String id = journey == null ? removeId : (String) journey.get("journeyId");
            boolean found = false;
            for (Object value : original) {
                @SuppressWarnings("unchecked") var existing = (Map<String, Object>) value;
                if (id.equals(existing.get("journeyId"))) {
                    found = true;
                    if (journey != null) { var merged = new LinkedHashMap<>(existing); merged.putAll(journey); nextJourneys.add(merged); }
                }
                else nextJourneys.add(existing);
            }
            if (!found && journey == null) throw new TravelError("journey_not_found");
            if (!found) nextJourneys.add(journey);
            TripStateFactory.validateJourneys(nextJourneys);
            if (canonical(original).equals(canonical(nextJourneys))) return Map.of("tripId", tripId.toString(), "revision", current.revision(), "role", current.role(), "state", state);
            brief.put("journeys", nextJourneys); state.put("brief", brief);
            long next = current.revision() + 1;
            state.put("revision", next); state.put("storageVersion", next); state.put("updatedAt", clock.instant().toString());
            jdbc.update("UPDATE travel_trips SET revision=?,state=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                    next, json.writeValueAsString(state), tripId);
            return Map.of("tripId", tripId.toString(), "revision", next, "role", current.role(), "state", state);
        });
    }

    public Map<String, Object> upsertEmptyTripTraveler(UUID actor, UUID tripId, long expectedRevision,
                                                        String requestId, Map<String, Object> input) {
        requireIds(actor, tripId);
        if (expectedRevision < 0) throw new TravelError("invalid_trip_input");
        var changes = TripStateFactory.safeObject(input);
        if (!(changes.get("travelerId") instanceof String travelerId) || !travelerId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_travelers");
        return receipt(actor, requestId, "upsert_trip_traveler", Map.of("tripId", tripId.toString(), "expectedRevision", expectedRevision, "traveler", changes),
                () -> requireEditorLocked(actor, tripId), () -> {
            var rows = jdbc.query("""
                    SELECT t.revision,t.state::text,a.role FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                    WHERE t.trip_id=? AND a.account_id=? AND a.role IN ('owner','editor') FOR UPDATE OF t
                    """, (rs, n) -> new EditableTrip(rs.getLong(1), parse(rs.getString(2)), rs.getString(3)), tripId, actor);
            if (rows.isEmpty()) throw new TravelError("trip_not_found");
            var current = rows.get(0);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            var state = current.state();
            if (hasPlanExceptRecordedTransport(state)) throw new TravelError("scope_change_needs_planning_rules");
            hasRecordedTransport(state);
            if (!(state.get("travelers") instanceof List<?> existing) || existing.stream().anyMatch(item -> !(item instanceof Map<?, ?>))) throw new TravelError("invalid_travelers");
            var nextTravelers = new ArrayList<Map<String, Object>>();
            int found = -1;
            for (Object item : existing) {
                @SuppressWarnings("unchecked") var traveler = (Map<String, Object>) item;
                if (travelerId.equals(traveler.get("travelerId"))) { if (found >= 0) throw new TravelError("invalid_travelers"); found = nextTravelers.size(); }
                nextTravelers.add(traveler);
            }
            if (found < 0 && nextTravelers.size() >= 12) throw new TravelError("invalid_travelers");
            var previous = found < 0 ? Map.<String, Object>of() : nextTravelers.get(found);
            var merged = mergeTraveler(previous, changes, nextTravelers.size());
            var normalized = new LinkedHashMap<>(previous);
            normalized.putAll(TripStateFactory.travelers(List.of(merged)).get(0));
            if (previous.containsKey("softPreferences")) normalized.put("softPreferences", previous.get("softPreferences"));
            if (previous.containsKey("operability")) normalized.put("operability", previous.get("operability"));
            if (found < 0) nextTravelers.add(normalized); else nextTravelers.set(found, normalized);
            if (canonical(state.get("travelers")).equals(canonical(nextTravelers)))
                return Map.of("tripId", tripId.toString(), "revision", current.revision(), "role", current.role(), "state", state);
            long next = current.revision() + 1;
            state.put("travelers", nextTravelers); state.put("revision", next); state.put("storageVersion", next); state.put("updatedAt", clock.instant().toString());
            jdbc.update("UPDATE travel_trips SET revision=?,state=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                    next, json.writeValueAsString(state), tripId);
            return Map.of("tripId", tripId.toString(), "revision", next, "role", current.role(), "state", state);
        });
    }

    private static Map<String, Object> mergeTraveler(Map<String, Object> previous, Map<String, Object> changes, int count) {
        if (!Set.of("travelerId", "displayName", "relationship", "role", "language", "hardConstraints", "careNeeds").containsAll(changes.keySet())) throw new TravelError("invalid_travelers");
        var merged = new LinkedHashMap<String, Object>();
        for (String key : List.of("travelerId", "displayName", "relationship", "role", "language", "hardConstraints", "careNeeds"))
            if (previous.containsKey(key)) merged.put(key, previous.get(key));
        for (String key : List.of("travelerId", "displayName", "relationship", "role", "language")) if (changes.containsKey(key)) merged.put(key, changes.get(key));
        if (!merged.containsKey("displayName")) merged.put("displayName", "同行人 " + (count + 1));
        if (changes.containsKey("careNeeds")) {
            if (!(changes.get("careNeeds") instanceof Map<?, ?> updates)) throw new TravelError("invalid_traveler_constraints");
            Object oldValue = merged.getOrDefault("careNeeds", Map.of());
            if (!(oldValue instanceof Map<?, ?> oldCare)) throw new TravelError("invalid_traveler_constraints");
            var care = new LinkedHashMap<String, Object>();
            for (var group : oldCare.entrySet()) { if (!(group.getKey() instanceof String key)) throw new TravelError("invalid_traveler_constraints"); care.put(key, group.getValue()); }
            for (var group : updates.entrySet()) {
                if (!(group.getKey() instanceof String key) || !(group.getValue() instanceof Map<?, ?> values)) throw new TravelError("invalid_traveler_constraints");
                Object original = care.getOrDefault(key, Map.of());
                if (!(original instanceof Map<?, ?> oldFields)) throw new TravelError("invalid_traveler_constraints");
                var fields = new LinkedHashMap<String, Object>();
                for (var entry : oldFields.entrySet()) { if (!(entry.getKey() instanceof String field)) throw new TravelError("invalid_traveler_constraints"); fields.put(field, entry.getValue()); }
                for (var entry : values.entrySet()) {
                    if (!(entry.getKey() instanceof String field)) throw new TravelError("invalid_traveler_constraints");
                    if ("food".equals(key) && "exclusions".equals(field) && fields.get(field) instanceof List<?> old && entry.getValue() instanceof List<?> additions) {
                        var combined = new ArrayList<Object>(old); for (Object value : additions) if (!combined.contains(value)) combined.add(value); fields.put(field, combined);
                    } else fields.put(field, entry.getValue());
                }
                care.put(key, fields);
            }
            merged.put("careNeeds", care);
        }
        if (changes.containsKey("hardConstraints")) {
            if (!(changes.get("hardConstraints") instanceof List<?> additions) || !(merged.getOrDefault("hardConstraints", List.of()) instanceof List<?> old)) throw new TravelError("invalid_traveler_constraints");
            var hard = new ArrayList<Object>(old);
            for (Object value : additions) if (!hard.contains(value)) hard.add(value);
            merged.put("hardConstraints", hard);
        }
        return merged;
    }

    /** Explicit user edits remove only the identified traveler or requirement from an otherwise empty trip. */
    public Map<String, Object> removeEmptyTripTravelerRequirement(UUID actor, UUID tripId, long expectedRevision,
                                                                   String requestId, String travelerId, Map<String, Object> target) {
        requireIds(actor, tripId);
        if (expectedRevision < 0 || travelerId == null || !travelerId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_travelers");
        var checked = TripStateFactory.safeObject(target);
        String type = checked.get("type") instanceof String value ? value : "";
        if (!("traveler".equals(type) && checked.keySet().equals(Set.of("type")))
                && !("care".equals(type) && checked.keySet().equals(Set.of("type", "group", "field"))
                    && checked.get("group") instanceof String group && checked.get("field") instanceof String field && TripStateFactory.isRemovableCareField(group, field))
                && !("food_exclusion".equals(type) && checked.keySet().equals(Set.of("type", "value")) && checked.get("value") instanceof String food && !food.isBlank() && food.length() <= 80)
                && !("hard_constraint".equals(type) && checked.keySet().equals(Set.of("type", "value")) && "foreign_guest_required".equals(checked.get("value"))))
            throw new TravelError("invalid_traveler_constraints");
        return receipt(actor, requestId, "remove_trip_traveler_requirement", Map.of("tripId", tripId.toString(),
                "expectedRevision", expectedRevision, "travelerId", travelerId, "target", checked), () -> requireEditorLocked(actor, tripId), () -> {
            var rows = jdbc.query("""
                    SELECT t.revision,t.state::text,a.role FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                    WHERE t.trip_id=? AND a.account_id=? AND a.role IN ('owner','editor') FOR UPDATE OF t
                    """, (rs, n) -> new EditableTrip(rs.getLong(1), parse(rs.getString(2)), rs.getString(3)), tripId, actor);
            if (rows.isEmpty()) throw new TravelError("trip_not_found");
            var current = rows.get(0);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            var state = current.state();
            if (hasPlanExceptRecordedTransport(state)) throw new TravelError("scope_change_needs_planning_rules");
            hasRecordedTransport(state);
            if (!(state.get("travelers") instanceof List<?> existing) || existing.stream().anyMatch(item -> !(item instanceof Map<?, ?>))) throw new TravelError("invalid_travelers");
            var nextTravelers = new ArrayList<Map<String, Object>>();
            int found = -1;
            for (Object item : existing) {
                @SuppressWarnings("unchecked") var traveler = (Map<String, Object>) item;
                if (travelerId.equals(traveler.get("travelerId"))) { if (found >= 0) throw new TravelError("invalid_travelers"); found = nextTravelers.size(); }
                nextTravelers.add(traveler);
            }
            if (found < 0) throw new TravelError("traveler_not_found");
            if ("traveler".equals(type)) {
                for (Object value : (List<?>) state.getOrDefault("confirmedTransport", List.of())) {
                    if (!(value instanceof Map<?, ?> fact) || !(fact.get("travelerIds") instanceof List<?> passengers)) throw new TravelError("invalid_transport_fact");
                    if (passengers.contains(travelerId)) throw new TravelError("traveler_used_by_transport");
                }
                nextTravelers.remove(found);
            }
            else {
                var traveler = new LinkedHashMap<>(nextTravelers.get(found));
                if ("hard_constraint".equals(type)) {
                    if (!(traveler.get("hardConstraints") instanceof List<?> hard)) throw new TravelError("requirement_not_found");
                    var next = new ArrayList<Object>(hard);
                    if (!next.remove(Map.of("type", checked.get("value")))) throw new TravelError("requirement_not_found");
                    traveler.put("hardConstraints", next);
                } else {
                    if (!(traveler.get("careNeeds") instanceof Map<?, ?> careValue)) throw new TravelError("requirement_not_found");
                    @SuppressWarnings("unchecked") var care = new LinkedHashMap<>((Map<String, Object>) careValue);
                    String group = "food_exclusion".equals(type) ? "food" : (String) checked.get("group");
                    String field = "food_exclusion".equals(type) ? "exclusions" : (String) checked.get("field");
                    if ("care".equals(type) && "food".equals(group) && "exclusions".equals(field)) throw new TravelError("invalid_traveler_constraints");
                    if (!(care.get(group) instanceof Map<?, ?> fieldsValue)) throw new TravelError("requirement_not_found");
                    @SuppressWarnings("unchecked") var fields = new LinkedHashMap<>((Map<String, Object>) fieldsValue);
                    if ("food_exclusion".equals(type)) {
                        if (!(fields.get(field) instanceof List<?> exclusions)) throw new TravelError("requirement_not_found");
                        var remaining = new ArrayList<Object>(exclusions);
                        if (!remaining.remove(checked.get("value"))) throw new TravelError("requirement_not_found");
                        fields.put(field, remaining);
                    } else if (!fields.containsKey(field)) throw new TravelError("requirement_not_found");
                    else fields.remove(field);
                    care.put(group, fields); traveler.put("careNeeds", care);
                }
                nextTravelers.set(found, traveler);
            }
            long next = current.revision() + 1;
            state.put("travelers", nextTravelers); state.put("revision", next); state.put("storageVersion", next); state.put("updatedAt", clock.instant().toString());
            jdbc.update("UPDATE travel_trips SET revision=?,state=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                    next, json.writeValueAsString(state), tripId);
            return Map.of("tripId", tripId.toString(), "revision", next, "role", current.role(), "state", state);
        });
    }

    /** User-recorded bookings are preserved as facts, not treated as a verified provider result. */
    public Map<String, Object> saveConfirmedTransport(UUID actor, UUID tripId, long expectedRevision,
                                                       String requestId, Map<String, Object> input) {
        requireIds(actor, tripId);
        if (expectedRevision < 0) throw new TravelError("invalid_transport_fact");
        var clean = TripStateFactory.safeObject(input);
        if (!Set.of("transportId", "mode", "number", "origin", "destination", "departure", "arrival", "travelerIds", "price").containsAll(clean.keySet())) throw new TravelError("invalid_transport_fact");
        String id = transportText(clean.get("transportId"), 128);
        if (!id.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_transport_fact");
        String mode = transportText(clean.get("mode"), 20);
        if (!Set.of("flight", "train", "bus", "ferry", "other").contains(mode)) throw new TravelError("invalid_transport_fact");
        String origin = transportText(clean.get("origin"), 120), destination = transportText(clean.get("destination"), 120);
        String number = clean.get("number") == null ? "" : transportText(clean.get("number"), 30);
        if (!number.isEmpty() && !number.matches("[A-Za-z0-9 -]{1,30}")) throw new TravelError("invalid_transport_fact");
        var departure = transportTime(clean.get("departure"));
        var arrival = transportTime(clean.get("arrival"));
        if (!Instant.parse((String) arrival.get("instant")).isAfter(Instant.parse((String) departure.get("instant")))) throw new TravelError("invalid_transport_times");
        var price = clean.get("price") == null ? null : transportPrice(clean.get("price"));
        Object travelersValue = clean.getOrDefault("travelerIds", List.of());
        if (!(travelersValue instanceof List<?> travelers) || travelers.size() > 12 || travelers.stream().anyMatch(value -> !(value instanceof String text) || !text.matches("[A-Za-z0-9_.:-]{1,128}"))
                || new java.util.HashSet<>(travelers).size() != travelers.size()) throw new TravelError("invalid_transport_fact");
        return receipt(actor, requestId, "save_confirmed_transport", Map.of("tripId", tripId.toString(), "expectedRevision", expectedRevision, "transport", clean),
                () -> requireEditorLocked(actor, tripId), () -> {
            var rows = jdbc.query("""
                    SELECT t.revision,t.state::text,a.role FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                    WHERE t.trip_id=? AND a.account_id=? AND a.role IN ('owner','editor') FOR UPDATE OF t
                    """, (rs, n) -> new EditableTrip(rs.getLong(1), parse(rs.getString(2)), rs.getString(3)), tripId, actor);
            if (rows.isEmpty()) throw new TravelError("trip_not_found");
            var current = rows.get(0);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            var state = current.state();
            if (hasPlanExceptRecordedTransport(state)) throw new TravelError("transport_change_needs_planning_rules");
            if (!(state.get("travelers") instanceof List<?> people)) throw new TravelError("invalid_travelers");
            for (Object person : travelers) if (people.stream().noneMatch(item -> item instanceof Map<?, ?> record && person.equals(record.get("travelerId")))) throw new TravelError("traveler_not_found");
            Object stored = state.getOrDefault("confirmedTransport", List.of());
            if (!(stored instanceof List<?> facts) || facts.stream().anyMatch(item -> !(item instanceof Map<?, ?>))) throw new TravelError("invalid_transport_fact");
            var nextFacts = new ArrayList<Map<String, Object>>(); int found = -1;
            for (Object item : facts) {
                @SuppressWarnings("unchecked") var fact = (Map<String, Object>) item;
                if (id.equals(fact.get("transportId"))) { if (found >= 0) throw new TravelError("invalid_transport_fact"); found = nextFacts.size(); }
                nextFacts.add(fact);
            }
            if (found < 0 && nextFacts.size() >= 40) throw new TravelError("transport_capacity_exceeded");
            var fact = new LinkedHashMap<String, Object>();
            fact.put("transportId", id); fact.put("mode", mode); fact.put("number", number); fact.put("origin", origin); fact.put("destination", destination);
            fact.put("departure", departure); fact.put("arrival", arrival); fact.put("travelerIds", travelers);
            if (price != null) fact.put("price", price);
            fact.put("source", "user_recorded"); fact.put("verified", false);
            if (found >= 0) fact.put("recordedAt", nextFacts.get(found).get("recordedAt"));
            if (found >= 0 && canonical(nextFacts.get(found)).equals(canonical(fact))) return Map.of("tripId", tripId.toString(), "revision", current.revision(), "role", current.role(), "state", state);
            fact.put("recordedAt", clock.instant().toString());
            if (found < 0) nextFacts.add(fact); else nextFacts.set(found, fact);
            long next = current.revision() + 1;
            state.put("confirmedTransport", nextFacts); state.put("transportOverlaps", recordedTransportOverlaps(nextFacts));
            refreshRecordedTransportBudget(state);
            state.put("revision", next); state.put("storageVersion", next); state.put("updatedAt", clock.instant().toString());
            jdbc.update("UPDATE travel_trips SET revision=?,state=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?", next, json.writeValueAsString(state), tripId);
            return Map.of("tripId", tripId.toString(), "revision", next, "role", current.role(), "state", state);
        });
    }

    public Map<String, Object> removeConfirmedTransport(UUID actor, UUID tripId, long expectedRevision, String requestId, String transportId) {
        requireIds(actor, tripId);
        if (expectedRevision < 0 || transportId == null || !transportId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_transport_fact");
        return receipt(actor, requestId, "remove_confirmed_transport", Map.of("tripId", tripId.toString(), "expectedRevision", expectedRevision, "transportId", transportId),
                () -> requireEditorLocked(actor, tripId), () -> {
            var rows = jdbc.query("""
                    SELECT t.revision,t.state::text,a.role FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                    WHERE t.trip_id=? AND a.account_id=? AND a.role IN ('owner','editor') FOR UPDATE OF t
                    """, (rs, n) -> new EditableTrip(rs.getLong(1), parse(rs.getString(2)), rs.getString(3)), tripId, actor);
            if (rows.isEmpty()) throw new TravelError("trip_not_found");
            var current = rows.get(0);
            if (current.revision() != expectedRevision) throw new TravelError("revision_conflict");
            var state = current.state();
            if (hasPlanExceptRecordedTransport(state)) throw new TravelError("transport_change_needs_planning_rules");
            if (!(state.get("confirmedTransport") instanceof List<?> facts) || facts.stream().anyMatch(item -> !(item instanceof Map<?, ?>))) throw new TravelError("invalid_transport_fact");
            var nextFacts = new ArrayList<>(facts); int before = nextFacts.size();
            nextFacts.removeIf(item -> transportId.equals(((Map<?, ?>) item).get("transportId")));
            if (before - nextFacts.size() != 1) throw new TravelError("transport_fact_not_found");
            long next = current.revision() + 1;
            state.put("confirmedTransport", nextFacts); state.put("transportOverlaps", recordedTransportOverlaps(nextFacts));
            refreshRecordedTransportBudget(state);
            state.put("revision", next); state.put("storageVersion", next); state.put("updatedAt", clock.instant().toString());
            jdbc.update("UPDATE travel_trips SET revision=?,state=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?", next, json.writeValueAsString(state), tripId);
            return Map.of("tripId", tripId.toString(), "revision", next, "role", current.role(), "state", state);
        });
    }

    private static String transportText(Object value, int max) {
        if (!(value instanceof String text) || text.isBlank() || text.length() > max) throw new TravelError("invalid_transport_fact");
        return text.trim();
    }
    private static Map<String, Object> transportTime(Object value) {
        if (!(value instanceof Map<?, ?> time) || !Set.of("local", "timeZone", "utcOffset").containsAll(time.keySet()) || !time.keySet().containsAll(Set.of("local", "timeZone"))) throw new TravelError("invalid_transport_fact");
        return TripTime.resolve(time.get("local"), time.get("timeZone"), time.get("utcOffset"));
    }

    private static Map<String, Object> transportPrice(Object value) {
        if (!(value instanceof Map<?, ?> price) || !price.keySet().equals(Set.of("amount", "currency", "unit", "taxes", "coverage"))
                || !(price.get("amount") instanceof String amount) || !amount.matches("[0-9]{1,15}(?:\\.[0-9]{1,6})?")
                || !(price.get("currency") instanceof String currency)
                || !currency.matches("[A-Z]{3}") || "XXX".equals(currency)
                || !(price.get("unit") instanceof String unit) || !Set.of("total", "per_person").contains(unit)
                || !(price.get("taxes") instanceof String taxes) || !Set.of("included", "excluded", "unknown").contains(taxes)
                || !(price.get("coverage") instanceof String coverage) || !Set.of("segment", "shared_or_unknown").contains(coverage))
            throw new TravelError("invalid_transport_price");
        try { java.util.Currency.getInstance(currency); }
        catch (IllegalArgumentException invalid) { throw new TravelError("invalid_transport_price"); }
        return Map.of("amount", amount, "currency", currency, "unit", unit, "taxes", taxes, "coverage", coverage);
    }

    private static List<Map<String, Object>> recordedTransportOverlaps(List<?> facts) {
        var warnings = new ArrayList<Map<String, Object>>();
        for (int i = 0; i < facts.size(); i++) for (int j = i + 1; j < facts.size(); j++) {
            if (!(facts.get(i) instanceof Map<?, ?> first) || !(facts.get(j) instanceof Map<?, ?> second)
                    || !(first.get("transportId") instanceof String firstId) || !(second.get("transportId") instanceof String secondId)
                    || !(first.get("departure") instanceof Map<?, ?> firstDeparture) || !(first.get("arrival") instanceof Map<?, ?> firstArrival)
                    || !(second.get("departure") instanceof Map<?, ?> secondDeparture) || !(second.get("arrival") instanceof Map<?, ?> secondArrival)
                    || !(first.get("travelerIds") instanceof List<?> firstPassengers) || !(second.get("travelerIds") instanceof List<?> secondPassengers))
                throw new TravelError("invalid_transport_fact");
            Instant firstStart, firstEnd, secondStart, secondEnd;
            try {
                firstStart = Instant.parse((String) firstDeparture.get("instant")); firstEnd = Instant.parse((String) firstArrival.get("instant"));
                secondStart = Instant.parse((String) secondDeparture.get("instant")); secondEnd = Instant.parse((String) secondArrival.get("instant"));
            } catch (RuntimeException invalid) { throw new TravelError("invalid_transport_fact"); }
            if (!firstEnd.isAfter(firstStart) || !secondEnd.isAfter(secondStart)) throw new TravelError("invalid_transport_fact");
            if (!firstStart.isBefore(secondEnd) || !secondStart.isBefore(firstEnd)) continue;
            var shared = firstPassengers.stream().filter(secondPassengers::contains).toList();
            if (!shared.isEmpty()) warnings.add(Map.of("code", "transport_overlap", "firstTransportId", firstId, "secondTransportId", secondId, "travelerIds", shared));
            else if (firstPassengers.isEmpty() || secondPassengers.isEmpty()) warnings.add(Map.of("code", "transport_overlap_passengers_unknown", "firstTransportId", firstId, "secondTransportId", secondId));
        }
        return warnings;
    }

    private static void refreshRecordedTransportBudget(Map<String, Object> state) {
        Object ledgerValue = state.get("budgetLedger");
        if (!(ledgerValue instanceof Map<?, ?>)) throw new TravelError("invalid_budget");
        @SuppressWarnings("unchecked") var ledger = new LinkedHashMap<>((Map<String, Object>) ledgerValue);
        ledger.put("recordedTransport", RecordedTransportBudget.summarize(state.getOrDefault("confirmedTransport", List.of()), ledger));
        state.put("budgetLedger", ledger);
    }

    private static boolean hasRecordedTransport(Map<String, Object> state) {
        Object recorded = state.getOrDefault("confirmedTransport", List.of());
        if (!(recorded instanceof List<?> facts) || facts.stream().anyMatch(item -> !(item instanceof Map<?, ?>))) throw new TravelError("invalid_transport_fact");
        return !facts.isEmpty();
    }

    private static boolean hasPlanExceptRecordedTransport(Map<String, Object> state) {
        return List.of("nodes", "edges", "pendingProposals", "proposalHistory", "feedbackLedger", "fulfillmentLedger", "fulfillmentEvents", "changeJournal")
                .stream().anyMatch(key -> hasContent(state, key)) || state.get("planning") != null || evidenceExists(state);
    }

    private static boolean hasContent(Map<String, Object> state, String key) {
        Object value = state.get(key);
        return value instanceof List<?> items && !items.isEmpty();
    }

    private static boolean evidenceExists(Map<String, Object> state) {
        Object value = state.get("evidence");
        return value instanceof Map<?, ?> evidence && evidence.values().stream().anyMatch(item -> item instanceof List<?> entries && !entries.isEmpty());
    }

    public Map<String, Object> list(UUID accountId, int limit, Instant beforeTime, UUID beforeId) {
        if (accountId == null) throw new TravelError("authentication_required");
        if (limit < 1 || limit > 100 || (beforeTime == null) != (beforeId == null)) throw new TravelError("invalid_page");
        var sql = """
                SELECT t.trip_id, t.revision, t.updated_at, t.state->'brief'->>'destination' AS destination, a.role
                FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                WHERE a.account_id=?
                """ + (beforeTime == null ? "" : " AND (t.updated_at, t.trip_id) < (?, ?) ")
                + " ORDER BY t.updated_at DESC, t.trip_id DESC LIMIT ?";
        var mapper = (org.springframework.jdbc.core.RowMapper<Map<String, Object>>) (rs, n) -> {
            var row = new LinkedHashMap<String, Object>();
            row.put("tripId", rs.getObject("trip_id", UUID.class).toString());
            row.put("revision", rs.getLong("revision"));
            row.put("role", rs.getString("role"));
            row.put("destination", rs.getString("destination"));
            row.put("updatedAt", rs.getTimestamp("updated_at").toInstant().toString());
            return row;
        };
        var rows = beforeTime == null
                ? jdbc.query(sql, mapper, accountId, limit + 1)
                : jdbc.query(sql, mapper, accountId, java.sql.Timestamp.from(beforeTime), beforeId, limit + 1);
        var items = rows.size() > limit ? rows.subList(0, limit) : rows;
        Object cursor = null;
        if (rows.size() > limit) {
            var last = items.get(items.size() - 1);
            cursor = Map.of("updatedAt", last.get("updatedAt"), "tripId", last.get("tripId"));
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("items", items);
        result.put("nextCursor", cursor);
        return result;
    }

    public Map<String, Object> grant(UUID actor, UUID tripId, UUID target, String role, long expectedAccessRevision, String requestId) {
        requireIds(actor, tripId);
        if (target == null || actor.equals(target) || expectedAccessRevision < 0 || !("viewer".equals(role) || "editor".equals(role))) throw new TravelError("invalid_share");
        return receipt(actor, requestId, "grant_trip_access", Map.of("tripId", tripId.toString(), "target", target.toString(), "role", role,
                "expectedAccessRevision", expectedAccessRevision), () -> requireOwnerLocked(actor, tripId), () -> {
            long current = requireOwnerLocked(actor, tripId);
            if (current != expectedAccessRevision) throw new TravelError("access_revision_conflict");
            var exists = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM travel_accounts WHERE account_id=?)", Boolean.class, target);
            if (!Boolean.TRUE.equals(exists)) throw new TravelError("account_not_found");
            var existing = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), tripId, target);
            long next = current;
            if (existing.isEmpty() || !role.equals(existing.get(0))) {
                jdbc.update("""
                        INSERT INTO travel_trip_access(trip_id, account_id, role) VALUES (?, ?, ?)
                        ON CONFLICT (trip_id, account_id) DO UPDATE SET role=EXCLUDED.role
                        """, tripId, target, role);
                if ("viewer".equals(role)) cancelTasksForRevokedEditor(tripId, target);
                next = current + 1;
                jdbc.update("UPDATE travel_trips SET access_revision=? WHERE trip_id=?", next, tripId);
            }
            return Map.of("tripId", tripId.toString(), "accountId", target.toString(), "role", role, "accessRevision", next);
        });
    }

    public Map<String, Object> revoke(UUID actor, UUID tripId, UUID target, long expectedAccessRevision, String requestId) {
        requireIds(actor, tripId);
        if (target == null || actor.equals(target) || expectedAccessRevision < 0) throw new TravelError("invalid_share");
        return receipt(actor, requestId, "revoke_trip_access", Map.of("tripId", tripId.toString(), "target", target.toString(),
                "expectedAccessRevision", expectedAccessRevision), () -> requireOwnerLocked(actor, tripId), () -> {
            long current = requireOwnerLocked(actor, tripId);
            if (current != expectedAccessRevision) throw new TravelError("access_revision_conflict");
            int deleted = jdbc.update("DELETE FROM travel_trip_access WHERE trip_id=? AND account_id=? AND role<>'owner'", tripId, target);
            if (deleted > 0) cancelTasksForRevokedEditor(tripId, target);
            long next = deleted > 0 ? current + 1 : current;
            if (deleted > 0) jdbc.update("UPDATE travel_trips SET access_revision=? WHERE trip_id=?", next, tripId);
            return Map.of("tripId", tripId.toString(), "accountId", target.toString(), "revoked", deleted > 0, "accessRevision", next);
        });
    }

    private long requireOwnerLocked(UUID actor, UUID tripId) {
        var rows = jdbc.query("""
                SELECT t.access_revision FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                WHERE t.trip_id=? AND a.account_id=? AND a.role='owner' AND t.owner_id=? FOR UPDATE OF t
                """, (rs, n) -> rs.getLong(1), tripId, actor, actor);
        if (rows.isEmpty()) throw new TravelError("trip_not_found");
        return rows.get(0);
    }

    private void cancelTasksForRevokedEditor(UUID trip, UUID actor) {
        jdbc.update("UPDATE travel_risk_follow_ups SET enabled=false,revision=revision+1,next_check_at=NULL,lease_id=NULL,lease_until=NULL,weather=weather || '{\"status\":\"authorization_lost\"}'::jsonb WHERE trip_id=? AND enabled_by=? AND enabled",trip,actor);
        jdbc.update("""
                UPDATE travel_planning_tasks SET status='cancelled',generation=generation+1,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP
                WHERE trip_id=? AND created_by=? AND status IN ('queued','running','paused','needs_context')
                """, trip, actor);
    }

    private void requireEditorLocked(UUID actor, UUID tripId) {
        var locked = jdbc.query("SELECT trip_id FROM travel_trips WHERE trip_id=? FOR UPDATE", (rs, n) -> rs.getObject(1, UUID.class), tripId);
        if (locked.isEmpty()) throw new TravelError("trip_not_found");
        var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), tripId, actor);
        if (roles.isEmpty() || !("owner".equals(roles.get(0)) || "editor".equals(roles.get(0)))) throw new TravelError("trip_not_found");
    }

    private Map<String, Object> receipt(UUID actor, String requestId, String type, Object input, Supplier<Map<String, Object>> operation) {
        return receipt(actor, requestId, type, input, () -> {}, operation);
    }

    private Map<String, Object> receipt(UUID actor, String requestId, String type, Object input, Runnable authorize, Supplier<Map<String, Object>> operation) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String hash = sha256(json.writeValueAsString(canonical(input)));
        return transactions.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> {}, actor + ":" + requestId);
            authorize.run();
            var rows = jdbc.query("SELECT command_type, input_hash, response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> new Receipt(rs.getString(1), rs.getString(2), rs.getString(3)), actor, requestId);
            if (!rows.isEmpty()) {
                var previous = rows.get(0);
                if (!type.equals(previous.type()) || !hash.equals(previous.hash())) throw new TravelError("request_id_conflict");
                var recorded = parse(previous.response());
                if (List.of("update_trip_scope", "upsert_trip_traveler", "remove_trip_traveler_requirement", "save_confirmed_transport", "remove_confirmed_transport", "upsert_trip_journey", "remove_trip_journey").contains(type)) return get(actor, UUID.fromString((String) recorded.get("tripId")));
                if (List.of("grant_trip_access", "revoke_trip_access").contains(type)) return currentShare(actor, recorded, type);
                return recorded;
            }
            var result = operation.get();
            jdbc.update("INSERT INTO travel_command_receipts(account_id, request_id, command_type, input_hash, response) VALUES (?, ?, ?, ?, CAST(? AS jsonb))",
                    actor, requestId, type, hash, json.writeValueAsString(result));
            return result;
        });
    }

    private Map<String, Object> parse(String value) { return json.readValue(value, OBJECT); }

    private Map<String, Object> currentShare(UUID actor, Map<String, Object> recorded, String type) {
        UUID trip = UUID.fromString((String) recorded.get("tripId")), target = UUID.fromString((String) recorded.get("accountId"));
        long revision = requireOwnerLocked(actor, trip);
        var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), trip, target);
        var result = new LinkedHashMap<String, Object>(); result.put("tripId", trip.toString()); result.put("accountId", target.toString());
        result.put("accessRevision", revision); result.put("status", roles.isEmpty() ? "not_shared" : "shared");
        if (!roles.isEmpty()) result.put("role", roles.get(0));
        if ("revoke_trip_access".equals(type)) result.put("revoked", roles.isEmpty());
        return result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asObject(Object value) { return (Map<String, Object>) value; }

    private static Object canonical(Object value) {
        if (value instanceof Map<?, ?> map) {
            var sorted = new TreeMap<String, Object>();
            map.forEach((key, nested) -> sorted.put((String) key, canonical(nested)));
            return sorted;
        }
        if (value instanceof List<?> list) {
            var result = new ArrayList<>();
            list.forEach(item -> result.add(canonical(item)));
            return result;
        }
        return value;
    }

    private static String sha256(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static void requireIds(UUID account, UUID trip) {
        if (account == null) throw new TravelError("authentication_required");
        if (trip == null) throw new TravelError("trip_not_found");
    }

    private record Receipt(String type, String hash, String response) {}
    private record EditableTrip(long revision, Map<String, Object> state, String role) {}
}
