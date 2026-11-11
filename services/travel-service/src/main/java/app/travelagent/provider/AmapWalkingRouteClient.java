package app.travelagent.provider;

import app.travelagent.core.TravelError;
import app.travelagent.core.TripStateFactory;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** Optional read-only walking estimates; route, accessibility and future conditions remain unverified. */
@Component
public final class AmapWalkingRouteClient {
    private static final String SOURCE = "amap_walking_route";
    private static final Set<String> QUOTA = Set.of("10003", "10004", "10014", "10015", "10019", "10020", "10021", "10029", "10044", "10045");
    private static final Set<String> AUTH = Set.of("10001", "10002", "10005", "10006", "10007", "10008", "10009", "10012", "10013", "10041");
    private final String key, secret;
    private final boolean enabled;
    private final WebClient http;

    public AmapWalkingRouteClient(Environment environment, WebClient.Builder builder) {
        key = environment.getProperty("TRAVEL_AMAP_API_KEY", "");
        secret = environment.getProperty("TRAVEL_AMAP_API_SECRET", "");
        enabled = environment.getProperty("TRAVEL_AMAP_WALKING_ENABLED", Boolean.class, false);
        http = builder.baseUrl("https://restapi.amap.com").build();
    }

    public Mono<Map<String, Object>> lookup(Map<String, Object> brief, Map<?, ?> origin, Map<?, ?> destination) {
        String start = coordinate(origin), end = coordinate(destination);
        if (!(brief.get("countryCode") instanceof String country) || country.isBlank()) return Mono.just(status("needs_context", "country_required"));
        if (!"CN".equals(country)) return Mono.just(status("source_not_covered", "amap_walking_china_only"));
        if (!enabled || key.isBlank()) return Mono.just(status("provider_unavailable", "amap_walking_not_configured"));
        var query = new TreeMap<String, String>();
        query.put("key", key); query.put("origin", start); query.put("destination", end); query.put("show_fields", "cost,navi,polyline");
        if (!secret.isBlank()) query.put("sig", signature(query, secret));
        return http.get().uri(builder -> { builder.path("/v5/direction/walking"); query.forEach(builder::queryParam); return builder.build(); })
                .retrieve().bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {}).timeout(Duration.ofSeconds(12))
                .map(payload -> normalize(payload, Instant.now()))
                .onErrorResume(error -> Mono.just(status("provider_unavailable", "amap_walking_request_failed")));
    }

    static Map<String, Object> normalize(Map<String, Object> payload, Instant now) {
        if (!"1".equals(payload.get("status"))) {
            String code = payload.get("infocode") instanceof String text ? text : "";
            if (QUOTA.contains(code)) return status("rate_limited", "amap_quota_limited");
            if (AUTH.contains(code)) return status("authorization_required", "amap_access_not_authorized");
            return status("provider_unavailable", "amap_walking_request_rejected");
        }
        if (!(payload.get("route") instanceof Map<?, ?> route) || !(route.get("paths") instanceof List<?> paths) || paths.size() > 25)
            return status("provider_unavailable", "invalid_walking_response");
        try {
            if (Integer.parseInt(String.valueOf(payload.get("count"))) != paths.size()) return status("provider_unavailable", "inconsistent_walking_count");
        } catch (NumberFormatException invalid) { return status("provider_unavailable", "invalid_walking_response"); }
        var alternatives = new ArrayList<Map<String, Object>>();
        var unusable = new ArrayList<Map<String, Object>>();
        boolean partialDetails = false;
        for (int i = 0; i < paths.size(); i++) {
            if (!(paths.get(i) instanceof Map<?, ?> path)) { unusable.add(Map.of("index", i, "reason", "invalid_route_record")); continue; }
            Long distance = nonnegative(path.get("distance"));
            Long duration = path.get("cost") instanceof Map<?, ?> cost ? nonnegative(cost.get("duration")) : null;
            if (distance == null || duration == null) { unusable.add(Map.of("index", i, "reason", "distance_or_duration_missing")); continue; }
            if (!(path.get("steps") instanceof List<?> rawSteps) || rawSteps.size() > 200) {
                unusable.add(Map.of("index", i, "reason", "route_steps_missing_or_too_large")); continue;
            }
            var steps = new ArrayList<Map<String, Object>>();
            if (rawSteps.isEmpty() && distance > 0) partialDetails = true;
            boolean bad = false, stairs = false;
            for (Object raw : rawSteps) {
                if (!(raw instanceof Map<?, ?> step)) { bad = true; break; }
                String instruction = step.get("instruction") instanceof String text && text.length() <= 500 ? text : null;
                Object rawWalkType = step.get("navi") instanceof Map<?, ?> navi && navi.get("walk_type") != null ? navi.get("walk_type") : step.get("walk_type");
                String walkType = rawWalkType instanceof String || rawWalkType instanceof Number ? rawWalkType.toString() : null;
                if (walkType != null && !walkType.matches("[0-9]{1,3}")) { bad = true; break; }
                stairs |= "20".equals(walkType);
                String polyline = step.get("polyline") instanceof String text && text.length() <= 12000 ? text : null;
                if (step.get("polyline") != null && polyline == null) { bad = true; break; }
                Long stepDistance = nonnegative(step.get("step_distance"));
                var missing = new ArrayList<String>();
                if (instruction == null) missing.add("instruction");
                if (stepDistance == null) missing.add("distance");
                if (walkType == null) missing.add("walk_type");
                if (polyline == null) missing.add("polyline");
                partialDetails |= !missing.isEmpty();
                var record = new LinkedHashMap<String, Object>();
                record.put("instruction", instruction); record.put("distanceMeters", stepDistance);
                record.put("walkType", walkType); record.put("polylineGcj02", polyline); record.put("missing", missing);
                try { steps.add(TripStateFactory.safeObject(record)); } catch (TravelError invalid) { bad = true; break; }
            }
            if (bad) { unusable.add(Map.of("index", i, "reason", "route_step_unusable")); continue; }
            var alternative = new LinkedHashMap<String, Object>();
            alternative.put("sourceIndex", i); alternative.put("distanceMeters", distance); alternative.put("durationSeconds", duration);
            alternative.put("steps", steps); alternative.put("stairsReported", stairs ? true : null); alternative.put("stepFreeStatus", "not_verified");
            alternatives.add(alternative);
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("status", "completed"); result.put("provider", SOURCE); result.put("coverage", unusable.isEmpty() && !partialDetails ? "query" : "partial");
        result.put("returnedCount", paths.size()); result.put("alternatives", alternatives); result.put("unusable", unusable);
        result.put("checkedAt", now.toString()); result.put("freshUntil", now.plusSeconds(900).toString());
        result.put("scheduleBasis", "query_time_estimate"); result.put("sourceDocumentation", "https://lbs.amap.com/api/webservice/guide/api/newroute");
        return result;
    }

    private static String coordinate(Map<?, ?> input) {
        if (input == null || !"GCJ-02".equals(input.get("coordinateSystem")) || !(input.get("longitude") instanceof Number longitude)
                || !(input.get("latitude") instanceof Number latitude)) throw new TravelError("route_coordinates_unavailable");
        try {
            var x = new BigDecimal(longitude.toString()); var y = new BigDecimal(latitude.toString());
            if (x.abs().compareTo(BigDecimal.valueOf(180)) > 0 || y.abs().compareTo(BigDecimal.valueOf(90)) > 0) throw new TravelError("route_coordinates_unavailable");
            return x.setScale(6, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString() + "," + y.setScale(6, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString();
        } catch (NumberFormatException invalid) { throw new TravelError("route_coordinates_unavailable"); }
    }
    private static Long nonnegative(Object value) {
        try {
            if (!(value instanceof String || value instanceof Number)) return null;
            long parsed = Long.parseLong(value.toString());
            return parsed >= 0 && parsed <= 10_000_000 ? parsed : null;
        } catch (NumberFormatException invalid) { return null; }
    }
    private static Map<String, Object> status(String state, String reason) { return Map.of("status", state, "reason", reason, "provider", SOURCE); }
    private static String signature(Map<String, String> values, String secret) {
        String canonical = values.entrySet().stream().map(entry -> entry.getKey() + "=" + entry.getValue()).collect(java.util.stream.Collectors.joining("&")) + secret;
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(canonical.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
