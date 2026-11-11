package app.travelagent.core;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** References share the trip ACL; expired source payloads are unavailable even before cleanup runs. */
@Service
public class TravelResults {
    private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final JsonMapper json = JsonMapper.builder().build();

    public TravelResults(JdbcTemplate jdbc, TransactionTemplate transactions) { this.jdbc = jdbc; this.transactions = transactions; }

    public Map<String, Object> saveWeather(UUID actor, UUID trip, long expectedRevision, Map<String, Object> result) {
        if (!"amap_weather".equals(result.get("provider"))) throw new TravelError("invalid_source_result");
        return save(actor, trip, expectedRevision, result, "weather", 3 * 3600);
    }

    public Map<String, Object> savePlaces(UUID actor, UUID trip, long expectedRevision, Map<String, Object> result) {
        if (!"amap_places".equals(result.get("provider"))) throw new TravelError("invalid_source_result");
        return save(actor, trip, expectedRevision, result, "places", 30 * 60);
    }

    public Map<String, Object> saveFlightStatus(UUID actor, UUID trip, long expectedRevision, Map<String, Object> result) {
        if (!"cirium_flight_status".equals(result.get("provider"))) throw new TravelError("invalid_source_result");
        return save(actor, trip, expectedRevision, result, "flight_status", 15 * 60);
    }

    public Map<String, Object> saveWalkingRoute(UUID actor, UUID trip, long expectedRevision, Map<String, Object> result) {
        if (!"amap_walking_route".equals(result.get("provider"))) throw new TravelError("invalid_source_result");
        return save(actor, trip, expectedRevision, result, "walking_route", 15 * 60);
    }

    private Map<String, Object> save(UUID actor, UUID trip, long expectedRevision, Map<String, Object> result, String kind, long maxAgeSeconds) {
        if (!"completed".equals(result.get("status"))) throw new TravelError("invalid_source_result");
        String data = json.writeValueAsString(result);
        if (data.length() > 65536) throw new TravelError("source_result_too_large");
        Instant checked = Instant.parse((String) result.get("checkedAt"));
        Instant expiry = Instant.parse((String) result.get("freshUntil"));
        if (!expiry.isAfter(checked) || expiry.isAfter(checked.plusSeconds(maxAgeSeconds))) throw new TravelError("invalid_source_result");
        return transactions.execute(status -> {
            var revisions = jdbc.query("SELECT revision FROM travel_trips WHERE trip_id=? FOR UPDATE", (rs, n) -> rs.getLong(1), trip);
            if (revisions.isEmpty()) throw new TravelError("trip_not_found");
            var access = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), trip, actor);
            if (access.isEmpty()) throw new TravelError("trip_not_found");
            if (revisions.get(0) != expectedRevision) throw new TravelError("revision_conflict");
            UUID id = UUID.randomUUID();
            jdbc.update("""
                    INSERT INTO travel_result_references(result_id,trip_id,trip_revision,kind,source,checked_at,fresh_until,coverage,data)
                    VALUES (?,?,?,?,?,?,?,?,CAST(? AS jsonb))
                    """, id, trip, expectedRevision, kind, result.get("provider"), Timestamp.from(checked), Timestamp.from(expiry), result.get("coverage"), data);
            return reference(id, trip, expectedRevision, kind, (String) result.get("provider"), checked, expiry,
                    (String) result.get("coverage"), result, false, false);
        });
    }

    public Map<String, Object> read(UUID actor, UUID resultId) {
        var rows = jdbc.query("""
                SELECT r.result_id,r.trip_id,r.trip_revision,r.kind,r.source,r.checked_at,r.fresh_until,r.coverage,
                       CASE WHEN r.fresh_until>CURRENT_TIMESTAMP THEN r.data::text ELSE NULL END,
                       (r.fresh_until<=CURRENT_TIMESTAMP OR r.data IS NULL) AS expired,(r.trip_revision<>t.revision) AS stale
                FROM travel_result_references r JOIN travel_trip_access a ON a.trip_id=r.trip_id JOIN travel_trips t ON t.trip_id=r.trip_id
                WHERE r.result_id=? AND a.account_id=?
                """, (rs, n) -> reference(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getLong(3), rs.getString(4),
                rs.getString(5), rs.getTimestamp(6).toInstant(), rs.getTimestamp(7).toInstant(), rs.getString(8),
                rs.getString(9) == null ? null : json.readValue(rs.getString(9), OBJECT), rs.getBoolean(10), rs.getBoolean(11)), resultId, actor);
        if (rows.isEmpty()) throw new TravelError("result_not_found");
        return rows.get(0);
    }

    /** A model can identify every place while display-specific detail remains separate. */
    public static Map<String, Object> modelSummary(Map<String, Object> reference) {
        var result = new LinkedHashMap<>(reference);
        if (!(result.get("data") instanceof Map<?, ?> data)) return result;
        if ("walking_route".equals(result.get("kind"))) {
            var summary = new LinkedHashMap<String, Object>();
            for (String key : List.of("status", "provider", "coverage", "returnedCount", "unusable", "checkedAt", "freshUntil", "scheduleBasis", "sourceDocumentation", "endpoints"))
                if (data.containsKey(key)) summary.put(key, data.get(key));
            var alternatives = new ArrayList<Map<String, Object>>();
            if (data.get("alternatives") instanceof List<?> list) for (Object value : list) {
                if (!(value instanceof Map<?, ?> route)) { alternatives.add(Map.of("summaryStatus", "invalid_route_record")); continue; }
                var alternative = new LinkedHashMap<String, Object>();
                for (String key : List.of("sourceIndex", "distanceMeters", "durationSeconds", "stairsReported", "stepFreeStatus"))
                    if (route.containsKey(key)) alternative.put(key, route.get(key));
                if (route.get("steps") instanceof List<?> steps) {
                    alternative.put("stepCount", steps.size());
                    alternative.put("stepsWithMissingDetails", steps.stream().filter(step -> !(step instanceof Map<?, ?> item)
                            || !(item.get("missing") instanceof List<?> missing) || !missing.isEmpty()).count());
                    alternative.put("stepsStatus", "omitted_from_model_summary");
                } else alternative.put("stepsStatus", "not_returned");
                alternatives.add(alternative);
            }
            summary.put("alternatives", alternatives);
            if (!(data.get("alternatives") instanceof List<?>)) summary.put("alternativesStatus", "invalid_source_result");
            result.put("data", summary);
            return result;
        }
        if (!"places".equals(result.get("kind"))) return result;
        var summary = new LinkedHashMap<String, Object>();
        for (String key : List.of("status", "provider", "destination", "domain", "keyword", "page", "pageSize", "returnedCount",
                "nextPage", "providerResultLimitReached", "coverage", "unusable", "checkedAt", "freshUntil", "sourceDocumentation"))
            if (data.containsKey(key)) summary.put(key, data.get(key));
        var candidates = new ArrayList<Map<String, Object>>();
        if (data.get("candidates") instanceof List<?> list) for (Object value : list) if (value instanceof Map<?, ?> place) {
            var candidate = new LinkedHashMap<String, Object>();
            candidate.put("sourceId", place.get("sourceId")); candidate.put("name", place.get("name"));
            candidates.add(candidate);
        }
        summary.put("candidates", candidates);
        result.put("data", summary);
        return result;
    }

    private static Map<String, Object> reference(UUID resultId, UUID trip, long revision, String kind, String source,
                                                  Instant checkedAt, Instant freshUntil, String coverage, Object data, boolean expired, boolean stale) {
        var reference = new LinkedHashMap<String, Object>();
        reference.put("resultId", resultId.toString()); reference.put("tripId", trip.toString()); reference.put("tripRevision", revision);
        reference.put("kind", kind); reference.put("source", source); reference.put("checkedAt", checkedAt.toString());
        reference.put("freshUntil", freshUntil.toString()); reference.put("coverage", coverage); reference.put("expired", expired); reference.put("stale", stale); reference.put("data", data);
        return reference;
    }
}
