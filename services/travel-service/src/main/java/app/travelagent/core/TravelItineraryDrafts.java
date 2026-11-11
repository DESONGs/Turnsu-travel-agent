package app.travelagent.core;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
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
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** Source-backed drafts remain suggestions until the domain adoption command records human review. */
@Service
public class TravelItineraryDrafts {
    private static final TypeReference<Map<String, Object>> OBJECT = new TypeReference<>() {};
    private static final Set<String> ROLES = Set.of("intercity_arrival", "transport_departure", "transport_arrival", "vehicle_pickup", "vehicle_return",
            "parking", "rest", "bag_drop", "stay_check_in", "stay_departure", "stay_return", "meal", "activity", "local_transport");
    private static final Set<String> STOP_FIELDS = Set.of("stopId", "sourceResultId", "sourceId", "role", "startLocal", "timeZone", "utcOffset", "durationMinutes");
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final TravelResults results;
    private final JsonMapper json = JsonMapper.builder().build();

    public TravelItineraryDrafts(JdbcTemplate jdbc, TransactionTemplate transactions, TravelResults results) {
        this.jdbc = jdbc; this.transactions = transactions; this.results = results;
    }

    public Map<String, Object> stage(UUID actor, UUID trip, long expectedRevision, String requestId, List<Map<String, Object>> stops) {
        if (actor == null || trip == null || expectedRevision < 0 || stops == null || stops.isEmpty() || stops.size() > 128) throw new TravelError("invalid_itinerary_draft");
        var safe = TripStateFactory.safeObject(Map.of("stops", stops));
        @SuppressWarnings("unchecked") var cleanStops = (List<Map<String, Object>>) safe.get("stops");
        return receipt(actor, trip, requestId, "stage_itinerary_draft", Map.of("tripId", trip.toString(), "expectedRevision", expectedRevision, "stops", cleanStops), () -> {
            long revision = lockAndAuthorize(actor, trip, true);
            if (revision != expectedRevision) throw new TravelError("revision_conflict");
            var normalized = validateStops(actor, trip, revision, cleanStops);
            var draft = Map.<String, Object>of("schemaVersion", "travel-itinerary-draft-v1", "stops", normalized,
                    "timeConflicts", timeConflicts(normalized), "transportOverlaps", transportOverlaps(trip, normalized), "canAdopt", false,
                    "unchecked", List.of("time_zone_source", "transport_connections", "opening_and_reservations", "inventory_and_prices", "budget", "traveler_constraints", "complete_trip"));
            UUID draftId = UUID.randomUUID();
            jdbc.update("INSERT INTO travel_itinerary_drafts(draft_id,trip_id,created_by,base_revision,status,draft) VALUES (?,?,?,?, 'proposed', CAST(? AS jsonb))",
                    draftId, trip, actor, revision, json.writeValueAsString(draft));
            return readOne(actor, trip, draftId);
        });
    }

    public Map<String, Object> list(UUID actor, UUID trip, int limit, Instant beforeTime, UUID beforeId) {
        if (actor == null || trip == null) throw new TravelError("trip_not_found");
        if (limit < 1 || limit > 50 || (beforeTime == null) != (beforeId == null)) throw new TravelError("invalid_page");
        return transactions.execute(status -> {
            lockAndAuthorize(actor, trip, false);
            String sql = """
                    SELECT d.draft_id,d.trip_id,d.base_revision,d.draft_revision,d.status,d.draft::text,d.created_at,t.revision
                    FROM travel_itinerary_drafts d JOIN travel_trips t ON t.trip_id=d.trip_id
                    WHERE d.trip_id=? AND d.status='proposed'
                    """ + (beforeTime == null ? "" : " AND (d.created_at,d.draft_id) < (?,?) ") + " ORDER BY d.created_at DESC,d.draft_id DESC LIMIT ?";
            var mapper = (org.springframework.jdbc.core.RowMapper<Map<String, Object>>) (rs, n) -> draftView(rs);
            var rows = beforeTime == null ? jdbc.query(sql, mapper, trip, limit + 1)
                    : jdbc.query(sql, mapper, trip, java.sql.Timestamp.from(beforeTime), beforeId, limit + 1);
            var items = rows.size() > limit ? rows.subList(0, limit) : rows;
            Object cursor = rows.size() > limit ? Map.of("createdAt", items.get(items.size() - 1).get("createdAt"), "draftId", items.get(items.size() - 1).get("draftId")) : null;
            var result = new LinkedHashMap<String, Object>(); result.put("items", items); result.put("nextCursor", cursor); return result;
        });
    }

    public Map<String, Object> get(UUID actor, UUID trip, UUID draftId) {
        if (actor == null || trip == null || draftId == null) throw new TravelError("draft_not_found");
        return readOne(actor, trip, draftId);
    }

    /** Recheck the available facts; unsupported checks remain explicit, never model-approved. */
    public Map<String, Object> verify(UUID actor, UUID trip, UUID draftId, long expectedRevision, long expectedDraftRevision) {
        return transactions.execute(status -> {
            long revision = lockAndAuthorize(actor, trip, false);
            if (revision != expectedRevision) throw new TravelError("revision_conflict");
            var saved = readOne(actor, trip, draftId);
            if (!"proposed".equals(saved.get("status"))) throw new TravelError("draft_not_found");
            if (((Number) saved.get("draftRevision")).longValue() != expectedDraftRevision) throw new TravelError("draft_revision_conflict");
            @SuppressWarnings("unchecked") var draft = (Map<String, Object>) saved.get("draft");
            @SuppressWarnings("unchecked") var stops = (List<Map<String, Object>>) draft.get("stops");
            var checks = new ArrayList<Map<String, Object>>();
            var sourceSet = new LinkedHashMap<String, Object>();
            var sourceDetails = new LinkedHashMap<String, Map<String,Object>>();
            boolean sourceValid = !Boolean.TRUE.equals(saved.get("stale"));
            for (var stop : stops) {
                String id = (String) stop.get("sourceResultId");
                if (sourceSet.containsKey(id)) continue;
                try {
                    var source = results.read(actor, UUID.fromString(id));
                    sourceDetails.put(id, source);
                    boolean valid = trip.toString().equals(source.get("tripId")) && !Boolean.TRUE.equals(source.get("expired")) && !Boolean.TRUE.equals(source.get("stale"));
                    sourceValid &= valid;
                    sourceSet.put(id, Map.of("resultId", id, "tripRevision", source.get("tripRevision"), "freshUntil", source.get("freshUntil"), "current", valid));
                } catch (TravelError error) { sourceValid = false; sourceSet.put(id, Map.of("resultId", id, "current", false)); }
            }
            checks.add(check("sources", sourceValid ? "passed" : "blocked", sourceValid ? "地点引用仍有效。" : "旅行要求或地点引用已变化，需要重新查询并形成草案。"));
            var overlaps = timeConflicts(stops);
            checks.add(check("visit_times", overlaps.isEmpty() ? "passed" : "blocked", overlaps.isEmpty() ? "到访时间未发现重叠。" : "部分到访时间重叠，需要调整。"));
            var transportWarnings = transportOverlaps(trip, stops);
            checks.add(check("recorded_transport", transportWarnings.isEmpty() ? "passed" : "needs_review", transportWarnings.isEmpty()
                    ? "未发现与已记录交通的时间重叠；完整衔接仍需核验。" : "可能与已记录交通重叠，需要核对乘坐人及安排是否描述同一段交通。"));
            String stateText = jdbc.queryForObject("SELECT state::text FROM travel_trips WHERE trip_id=?", String.class, trip);
            var state = json.readValue(stateText, OBJECT);
            for (var stop : stops) {
                String id = (String) stop.get("stopId");
                String visit = stop.get("startLocal") + "（" + stop.get("timeZone") + "）的到访";
                checks.add(check("time_zone_source:" + id, "unverified", visit + "：地点所在时区尚未由来源核实。"));
                checks.add(check("opening_and_reservations:" + id, "unverified", visit + "：营业及预约条件尚未核实。"));
                checks.add(check("inventory_and_prices:" + id, "unverified", visit + "：库存、费用和包含项尚未核实。"));
            }
            checks.add(check("transport_connections", "unverified", "往返、跨城和逐段接驳尚未完成核验。"));
            @SuppressWarnings("unchecked") var ledger = (Map<String, Object>) state.get("budgetLedger");
            var budget = RecordedTransportBudget.summarize(state.getOrDefault("confirmedTransport", List.of()), ledger);
            boolean overBudget = "recorded_transport_exceeds_budget".equals(budget.get("comparison"));
            checks.add(check("budget", overBudget ? "blocked" : "unverified", overBudget
                    ? "仅已记录交通的已知费用就超过预算，需要先调整。" : "全程费用、币种换算及预算尚未完成核验。"));
            Object people = state.get("travelers");
            if (people instanceof List<?> travelers && !travelers.isEmpty()) {
                for (Object person : travelers) if (person instanceof Map<?, ?> traveler) {
                    checks.add(check("traveler_constraints:" + traveler.get("travelerId"), "unverified",
                            (traveler.get("displayName") instanceof String name && !name.isBlank() ? name : "这位同行人") + "的步行、设施、饮食及其他要求尚未逐项核验。"));
                }
            } else checks.add(check("traveler_constraints", "unverified", "同行人及其步行、设施、饮食等要求尚未完整确认和核验。"));
            if (state.get("transportOverlaps") instanceof List<?> warnings && warnings.stream().anyMatch(value -> value instanceof Map<?, ?> item && "transport_overlap".equals(item.get("code"))))
                checks.add(check("booked_transport_conflict", "blocked", "同一乘坐人的已订交通时间存在冲突，需要先处理。"));
            checks.add(check("complete_trip", "unverified", "全部日期、餐次、住宿和完整往返尚未核对；暂定行程仅保存当前列出的到访。"));
            checks.add(check("risk_follow_up_coverage", "unverified", "目前仅支持目的地天气检查，航班、营业、预约和交通衔接尚未持续跟进；天气来源不可用或超出窗口时也不能完成检查。"));
            String followUpStopsAt = followUpStopTime(state, stops).toString();
            if (!Instant.parse(followUpStopsAt).isAfter(Instant.now())) checks.add(check("trip_end", "blocked", "当前行程已结束，不能作为待出行的暂定行程采用。"));
            checks = new ArrayList<>(ItineraryReviewBasis.bind(checks, stops, state, sourceDetails));
            var report = new LinkedHashMap<String, Object>();
            report.put("tripId", trip.toString()); report.put("draftId", draftId.toString()); report.put("tripRevision", revision);
            report.put("draftRevision", expectedDraftRevision); report.put("checkedAt", Instant.now().toString()); report.put("checks", checks); report.put("followUpStopsAt", followUpStopsAt);
            report.put("canAdopt", checks.stream().allMatch(item -> "passed".equals(item.get("status"))));
            report.put("canAdoptTentatively", checks.stream().noneMatch(item -> "blocked".equals(item.get("status"))));
            report.put("requiredAcknowledgments", checks.stream().filter(item -> List.of("unverified", "needs_review").contains(item.get("status"))).map(item -> item.get("id")).toList());
            report.put("readSet", Map.of("tripRevision", revision, "draftRevision", expectedDraftRevision, "sources", List.copyOf(sourceSet.values())));
            report.put("timeConflicts", overlaps); report.put("transportWarnings", transportWarnings);
            report.put("reviewDigest", hash(json.writeValueAsString(canonical(Map.of("readSet", report.get("readSet"), "checks", checks, "stops", stops)))));
            return report;
        });
    }

    static Instant followUpStopTime(Map<String,Object> state, List<Map<String,Object>> stops) {
        Instant finish=stops.stream().map(stop -> Instant.parse((String)stop.get("endAt"))).max(Instant::compareTo).orElseThrow();
        if (state.get("confirmedTransport") instanceof List<?> facts) for (Object value:facts)
            if (value instanceof Map<?,?> fact && fact.get("arrival") instanceof Map<?,?> arrival && arrival.get("instant") instanceof String at) {
                Instant end=Instant.parse(at); if(end.isAfter(finish)) finish=end;
            }
        return finish.plusSeconds(24*3600);
    }

    private static Map<String, Object> check(String id, String status, String message) { return Map.of("id", id, "status", status, "message", message); }

    /** Compare one explicitly selected estimate with two adjacent visits; this never adopts the draft. */
    public Map<String, Object> assessWalkingRoute(UUID actor, UUID trip, UUID draftId, long expectedRevision, long expectedDraftRevision,
                                                  String originStopId, String destinationStopId, UUID routeResultId, int sourceIndex) {
        if (actor == null || trip == null || draftId == null || routeResultId == null || expectedRevision < 0 || expectedDraftRevision < 0 || sourceIndex < 0)
            throw new TravelError("invalid_itinerary_draft");
        String fromId = identifier(originStopId), toId = identifier(destinationStopId);
        if (fromId.equals(toId)) throw new TravelError("invalid_route_input");
        return transactions.execute(status -> {
            long revision = lockAndAuthorize(actor, trip, false);
            if (revision != expectedRevision) throw new TravelError("revision_conflict");
            var rows = jdbc.query("SELECT base_revision,draft_revision,status,draft::text FROM travel_itinerary_drafts WHERE trip_id=? AND draft_id=? FOR UPDATE",
                    (rs, n) -> Map.<String, Object>of("base", rs.getLong(1), "revision", rs.getLong(2), "status", rs.getString(3),
                            "draft", json.readValue(rs.getString(4), OBJECT)), trip, draftId);
            if (rows.isEmpty() || !"proposed".equals(rows.get(0).get("status"))) throw new TravelError("draft_not_found");
            if (((Number) rows.get(0).get("base")).longValue() != revision) throw new TravelError("draft_stale");
            if (((Number) rows.get(0).get("revision")).longValue() != expectedDraftRevision) throw new TravelError("draft_revision_conflict");
            Object rawStops = ((Map<?, ?>) rows.get(0).get("draft")).get("stops");
            if (!(rawStops instanceof List<?> values) || values.stream().anyMatch(value -> !(value instanceof Map<?, ?>))) throw new TravelError("invalid_itinerary_draft");
            var stops = new ArrayList<Map<?, ?>>();
            for (Object value : values) stops.add((Map<?, ?>) value);
            try { stops.sort(java.util.Comparator.comparing(stop -> Instant.parse((String) stop.get("startAt")))); }
            catch (RuntimeException invalid) { throw new TravelError("invalid_itinerary_draft"); }
            int position = -1;
            for (int i = 0; i < stops.size(); i++) if (fromId.equals(stops.get(i).get("stopId"))) position = i;
            if (position < 0 || position + 1 >= stops.size() || !toId.equals(stops.get(position + 1).get("stopId")))
                throw new TravelError("route_visits_not_adjacent");
            var from = stops.get(position); var to = stops.get(position + 1);
            var reference = results.read(actor, routeResultId);
            if (!trip.toString().equals(reference.get("tripId")) || !"walking_route".equals(reference.get("kind"))) throw new TravelError("result_not_found");
            if (Boolean.TRUE.equals(reference.get("expired"))) throw new TravelError("result_expired");
            if (Boolean.TRUE.equals(reference.get("stale")) || ((Number) reference.get("tripRevision")).longValue() != revision) throw new TravelError("result_stale");
            if (!(reference.get("data") instanceof Map<?, ?> data) || !(data.get("endpoints") instanceof Map<?, ?> endpoints)
                    || !matchesEndpoint(endpoints.get("origin"), from) || !matchesEndpoint(endpoints.get("destination"), to))
                throw new TravelError("route_endpoints_mismatch");
            if (!(data.get("alternatives") instanceof List<?> alternatives)) throw new TravelError("invalid_source_result");
            var selected = alternatives.stream().filter(value -> value instanceof Map<?, ?> alternative && alternative.get("sourceIndex") instanceof Number number
                    && number.intValue() == sourceIndex && number.doubleValue() == sourceIndex).toList();
            if (selected.size() != 1 || !(((Map<?, ?>) selected.get(0)).get("durationSeconds") instanceof Number duration)
                    || duration.longValue() < 0 || duration.doubleValue() != duration.longValue()) throw new TravelError("route_alternative_not_found");
            long gap = java.time.Duration.between(Instant.parse((String) from.get("endAt")), Instant.parse((String) to.get("startAt"))).getSeconds();
            long required = duration.longValue();
            return Map.of("draftId", draftId.toString(), "draftRevision", expectedDraftRevision, "routeResultId", routeResultId.toString(),
                    "originStopId", fromId, "destinationStopId", toId, "sourceIndex", sourceIndex, "gapSeconds", gap,
                    "estimatedWalkingSeconds", required, "fitsEstimatedDuration", gap >= required, "basis", "query_time_estimate_not_future_guarantee");
        });
    }

    private static boolean matchesEndpoint(Object endpoint, Map<?, ?> stop) {
        return endpoint instanceof Map<?, ?> value && java.util.Objects.equals(value.get("resultId"), stop.get("sourceResultId"))
                && java.util.Objects.equals(value.get("sourceId"), stop.get("sourceId"));
    }

    public Map<String, Object> reject(UUID actor, UUID trip, UUID draftId, long expectedRevision, String requestId) {
        if (actor == null || trip == null || draftId == null || expectedRevision < 0) throw new TravelError("invalid_itinerary_draft");
        return receipt(actor, trip, requestId, "reject_itinerary_draft", Map.of("tripId", trip.toString(), "draftId", draftId.toString(), "expectedRevision", expectedRevision), () -> {
            if (lockAndAuthorize(actor, trip, true) != expectedRevision) throw new TravelError("revision_conflict");
            int changed = jdbc.update("UPDATE travel_itinerary_drafts SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND draft_id=? AND status='proposed'", trip, draftId);
            if (changed == 0) throw new TravelError("draft_not_found");
            jdbc.update("UPDATE travel_workbench_requests SET work_status='superseded',updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND draft_id=? AND work_status<>'superseded'", trip, draftId);
            return readOne(actor, trip, draftId);
        });
    }

    /** User time edits affect one visit in one draft; other visits and formal state are preserved. */
    public Map<String, Object> editVisit(UUID actor, UUID trip, UUID draftId, long expectedRevision, long expectedDraftRevision,
                                         String requestId, String stopId, Map<String, Object> changes) {
        if (actor == null || trip == null || draftId == null || expectedRevision < 0 || expectedDraftRevision < 0 || changes == null)
            throw new TravelError("invalid_itinerary_draft");
        String checkedStop = identifier(stopId);
        var safe = TripStateFactory.safeObject(changes);
        if (!Set.of("startLocal", "timeZone", "utcOffset", "durationMinutes").containsAll(safe.keySet())
                || !safe.keySet().containsAll(Set.of("startLocal", "timeZone", "durationMinutes"))) throw new TravelError("invalid_itinerary_draft");
        return receipt(actor, trip, requestId, "edit_itinerary_visit", Map.of("tripId", trip.toString(), "draftId", draftId.toString(),
                "expectedRevision", expectedRevision, "expectedDraftRevision", expectedDraftRevision, "stopId", checkedStop, "changes", safe), () -> {
            if (lockAndAuthorize(actor, trip, true) != expectedRevision) throw new TravelError("revision_conflict");
            var rows = jdbc.query("SELECT draft_revision,draft::text FROM travel_itinerary_drafts WHERE trip_id=? AND draft_id=? AND status='proposed' FOR UPDATE",
                    (rs, n) -> Map.<String, Object>of("revision", rs.getLong(1), "draft", json.readValue(rs.getString(2), OBJECT)), trip, draftId);
            if (rows.isEmpty()) throw new TravelError("draft_not_found");
            if (((Number) rows.get(0).get("revision")).longValue() != expectedDraftRevision) throw new TravelError("draft_revision_conflict");
            @SuppressWarnings("unchecked") var draft = new LinkedHashMap<>((Map<String, Object>) rows.get(0).get("draft"));
            Object rawStops = draft.get("stops");
            if (!(rawStops instanceof List<?> original) || original.stream().anyMatch(item -> !(item instanceof Map<?, ?>))) throw new TravelError("invalid_itinerary_draft");
            var next = new ArrayList<Map<String, Object>>();
            int found = 0;
            for (Object raw : original) {
                @SuppressWarnings("unchecked") var old = (Map<String, Object>) raw;
                if (!checkedStop.equals(old.get("stopId"))) { next.add(old); continue; }
                found++;
                var visit = new LinkedHashMap<>(old); visit.remove("utcOffset"); visit.putAll(safe);
                next.add(normalizeTime(visit));
            }
            if (found != 1) throw new TravelError(found == 0 ? "visit_not_found" : "duplicate_visit_id");
            if (!original.equals(next)) {
                draft.put("stops", next); draft.put("timeConflicts", timeConflicts(next)); draft.put("transportOverlaps", transportOverlaps(trip, next));
                jdbc.update("UPDATE travel_itinerary_drafts SET draft_revision=?,draft=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND draft_id=?",
                        expectedDraftRevision + 1, json.writeValueAsString(draft), trip, draftId);
                jdbc.update("UPDATE travel_workbench_requests SET work_status='superseded',updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND draft_id=? AND work_status<>'superseded'", trip, draftId);
            }
            return readOne(actor, trip, draftId);
        });
    }

    private List<Map<String, Object>> validateStops(UUID actor, UUID trip, long revision, List<Map<String, Object>> stops) {
        var normalized = new ArrayList<Map<String, Object>>();
        var ids = new HashSet<String>();
        var sourceCache = new LinkedHashMap<UUID, Map<String, Object>>();
        for (var stop : stops) {
            if (stop == null || !STOP_FIELDS.containsAll(stop.keySet())) throw new TravelError("invalid_itinerary_draft");
            String stopId = identifier(stop.get("stopId"));
            if (!ids.add(stopId)) throw new TravelError("duplicate_visit_id");
            String sourceId = identifier(stop.get("sourceId"));
            UUID resultId;
            try { resultId = UUID.fromString(text(stop.get("sourceResultId"))); }
            catch (RuntimeException invalid) { throw new TravelError("invalid_itinerary_draft"); }
            String role = text(stop.get("role"));
            if (!ROLES.contains(role)) throw new TravelError("invalid_itinerary_draft");
            var reference = sourceCache.computeIfAbsent(resultId, id -> results.read(actor, id));
            if (!trip.toString().equals(reference.get("tripId")) || !"places".equals(reference.get("kind"))) throw new TravelError("result_not_found");
            if (Boolean.TRUE.equals(reference.get("expired"))) throw new TravelError("result_expired");
            if (Boolean.TRUE.equals(reference.get("stale")) || ((Number) reference.get("tripRevision")).longValue() != revision) throw new TravelError("result_stale");
            if (!(reference.get("data") instanceof Map<?, ?> data) || !(data.get("domain") instanceof String domain)
                    || !Set.of("food", "stay", "play", "transport").contains(domain) || !(data.get("candidates") instanceof List<?> candidates))
                throw new TravelError("invalid_source_result");
            var matching = candidates.stream().filter(item -> item instanceof Map<?, ?> place && sourceId.equals(place.get("sourceId"))).toList();
            if (matching.isEmpty()) throw new TravelError("candidate_not_found");
            if (matching.stream().anyMatch(item -> !domain.equals(((Map<?, ?>) item).get("domain")))) throw new TravelError("invalid_source_result");
            if (!roleMatchesDomain(role, domain)) throw new TravelError("plan_role_domain_mismatch");
            var visit = new LinkedHashMap<String, Object>();
            visit.put("stopId", stopId); visit.put("sourceResultId", resultId.toString()); visit.put("sourceId", sourceId); visit.put("role", role);
            visit.put("startLocal", stop.get("startLocal")); visit.put("timeZone", stop.get("timeZone")); visit.put("durationMinutes", stop.get("durationMinutes"));
            if (stop.containsKey("utcOffset")) visit.put("utcOffset", stop.get("utcOffset"));
            normalized.add(normalizeTime(visit));
        }
        return normalized;
    }

    /** Ported from the previous itinerary scheduler: a place cannot silently change travel domains. */
    private static boolean roleMatchesDomain(String role, String domain) {
        if (Set.of("parking", "vehicle_pickup", "vehicle_return", "rest").contains(role)) return true;
        if (Set.of("transport_departure", "transport_arrival", "intercity_arrival", "local_transport").contains(role)) return "transport".equals(domain);
        if (Set.of("bag_drop", "stay_check_in", "stay_departure", "stay_return").contains(role)) return "stay".equals(domain);
        if ("meal".equals(role)) return Set.of("food", "stay").contains(domain);
        return "activity".equals(role) && "play".equals(domain);
    }

    private static Map<String, Object> normalizeTime(Map<String, Object> input) {
        int duration = integer(input.get("durationMinutes"));
        if (duration < 0 || duration > 720) throw new TravelError("invalid_itinerary_draft");
        var time = TripTime.resolve(input.get("startLocal"), input.get("timeZone"), input.get("utcOffset"));
        Instant start = Instant.parse((String) time.get("instant"));
        var visit = new LinkedHashMap<>(input);
        visit.put("startLocal", time.get("local")); visit.put("timeZone", time.get("timeZone")); visit.put("utcOffset", time.get("utcOffset"));
        visit.put("durationMinutes", duration); visit.put("startAt", start.toString()); visit.put("endAt", start.plusSeconds(duration * 60L).toString());
        return visit;
    }

    private static List<Map<String, Object>> timeConflicts(List<Map<String, Object>> stops) {
        int count = stops.size();
        int[] groups = new int[count]; for (int i = 0; i < count; i++) groups[i] = i;
        for (int i = 0; i < count; i++) for (int j = i + 1; j < count; j++) {
            Instant aStart = Instant.parse((String) stops.get(i).get("startAt")), aEnd = Instant.parse((String) stops.get(i).get("endAt"));
            Instant bStart = Instant.parse((String) stops.get(j).get("startAt")), bEnd = Instant.parse((String) stops.get(j).get("endAt"));
            if (aStart.isBefore(aEnd) && bStart.isBefore(bEnd) && aStart.isBefore(bEnd) && bStart.isBefore(aEnd)) {
                int a = i, b = j; while (groups[a] != a) a = groups[a]; while (groups[b] != b) b = groups[b]; groups[a] = b;
            }
        }
        var members = new LinkedHashMap<Integer, List<String>>();
        for (int i = 0; i < count; i++) {
            int root = i; while (groups[root] != root) root = groups[root];
            members.computeIfAbsent(root, ignored -> new ArrayList<>()).add((String) stops.get(i).get("stopId"));
        }
        var issues = new ArrayList<Map<String, Object>>();
        for (var group : members.values()) if (group.size() > 1) issues.add(Map.of("code", "time_overlap", "stopIds", group));
        return issues;
    }

    /** An overlap is a warning: a visit has no passenger assignment and may describe the transport itself. */
    private List<Map<String, Object>> transportOverlaps(UUID trip, List<Map<String, Object>> stops) {
        String stored = jdbc.queryForObject("SELECT state::text FROM travel_trips WHERE trip_id=?", String.class, trip);
        if (stored == null) throw new TravelError("trip_not_found");
        var state = json.readValue(stored, OBJECT);
        Object raw = state.getOrDefault("confirmedTransport", List.of());
        if (!(raw instanceof List<?> facts)) throw new TravelError("invalid_transport_fact");
        var warnings = new ArrayList<Map<String, Object>>();
        for (Object value : facts) {
            if (!(value instanceof Map<?, ?> fact) || !(fact.get("transportId") instanceof String id)
                    || !(fact.get("departure") instanceof Map<?, ?> departure) || !(fact.get("arrival") instanceof Map<?, ?> arrival)
                    || !(departure.get("instant") instanceof String departText) || !(arrival.get("instant") instanceof String arriveText))
                throw new TravelError("invalid_transport_fact");
            Instant start, end;
            try { start = Instant.parse(departText); end = Instant.parse(arriveText); }
            catch (RuntimeException invalid) { throw new TravelError("invalid_transport_fact"); }
            if (!end.isAfter(start)) throw new TravelError("invalid_transport_fact");
            for (var stop : stops) {
                Instant visitStart = Instant.parse((String) stop.get("startAt")), visitEnd = Instant.parse((String) stop.get("endAt"));
                boolean timedOverlap = visitStart.isBefore(visitEnd) && visitStart.isBefore(end) && start.isBefore(visitEnd);
                boolean pointInside = visitStart.equals(visitEnd) && visitStart.isAfter(start) && visitStart.isBefore(end);
                if (timedOverlap || pointInside)
                    warnings.add(Map.of("code", "recorded_transport_overlap", "stopId", stop.get("stopId"), "transportId", id));
            }
        }
        return warnings;
    }

    private Map<String, Object> readOne(UUID actor, UUID trip, UUID draftId) {
        var rows = jdbc.query("""
                SELECT d.draft_id,d.trip_id,d.base_revision,d.draft_revision,d.status,d.draft::text,d.created_at,t.revision
                FROM travel_itinerary_drafts d JOIN travel_trips t ON t.trip_id=d.trip_id JOIN travel_trip_access a ON a.trip_id=d.trip_id
                WHERE d.trip_id=? AND d.draft_id=? AND a.account_id=?
                """, (rs, n) -> draftView(rs), trip, draftId, actor);
        if (rows.isEmpty()) throw new TravelError("draft_not_found");
        return rows.get(0);
    }
    private Map<String, Object> draftView(java.sql.ResultSet rs) throws java.sql.SQLException {
        return Map.of("draftId", rs.getObject(1, UUID.class).toString(), "tripId", rs.getObject(2, UUID.class).toString(),
                "baseRevision", rs.getLong(3), "draftRevision", rs.getLong(4), "status", rs.getString(5), "draft", json.readValue(rs.getString(6), OBJECT),
                "createdAt", rs.getTimestamp(7).toInstant().toString(), "stale", rs.getLong(3) != rs.getLong(8));
    }
    private long lockAndAuthorize(UUID actor, UUID trip, boolean write) {
        var revisions = jdbc.query("SELECT revision FROM travel_trips WHERE trip_id=? FOR UPDATE", (rs, n) -> rs.getLong(1), trip);
        if (revisions.isEmpty()) throw new TravelError("trip_not_found");
        var roles = jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?", (rs, n) -> rs.getString(1), trip, actor);
        if (roles.isEmpty() || (write && !("owner".equals(roles.get(0)) || "editor".equals(roles.get(0))))) throw new TravelError("trip_not_found");
        return revisions.get(0);
    }
    private Map<String, Object> receipt(UUID actor, UUID trip, String requestId, String kind, Object input, Supplier<Map<String, Object>> action) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String hash = hash(json.writeValueAsString(canonical(input)));
        return transactions.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", rs -> {}, actor + ":" + requestId);
            lockAndAuthorize(actor, trip, true);
            var rows = jdbc.query("SELECT command_type,input_hash,response::text FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs, n) -> Map.of("kind", rs.getString(1), "hash", rs.getString(2), "response", rs.getString(3)), actor, requestId);
            if (!rows.isEmpty()) {
                var prior = rows.get(0);
                if (!kind.equals(prior.get("kind")) || !hash.equals(prior.get("hash"))) throw new TravelError("request_id_conflict");
                var recorded = json.readValue(prior.get("response"), OBJECT);
                return readOne(actor, trip, UUID.fromString((String) recorded.get("draftId")));
            }
            var response = action.get();
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?,?,CAST(? AS jsonb))",
                    actor, requestId, kind, hash, json.writeValueAsString(response));
            return response;
        });
    }
    private static Object canonical(Object value) {
        if (value instanceof Map<?, ?> map) { var sorted = new TreeMap<String, Object>(); map.forEach((k, v) -> sorted.put((String) k, canonical(v))); return sorted; }
        if (value instanceof List<?> list) return list.stream().map(TravelItineraryDrafts::canonical).toList();
        return value;
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String text(Object value) { if (!(value instanceof String text) || text.isBlank()) throw new TravelError("invalid_itinerary_draft"); return text; }
    private static String identifier(Object value) { String id = text(value); if (!id.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_itinerary_draft"); return id; }
    private static int integer(Object value) { if (!(value instanceof Number number) || number.doubleValue() != number.intValue()) throw new TravelError("invalid_itinerary_draft"); return number.intValue(); }
}
