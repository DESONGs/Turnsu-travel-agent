package app.travelagent.provider;

import app.travelagent.core.TravelError;
import app.travelagent.core.TripStateFactory;
import java.math.BigDecimal;
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

/** Optional POI research. These are map references, not inventory or verified opening hours. */
@Component
public final class AmapPlaceClient {
    private static final String SOURCE = "amap_places";
    private static final Map<String, String> TYPES = Map.of("food", "050000", "stay", "100000", "play", "110000|140000", "transport", "150000");
    private static final Set<String> QUOTA = Set.of("10003", "10004", "10014", "10015", "10019", "10020", "10021", "10029", "10044", "10045");
    private static final Set<String> AUTH = Set.of("10001", "10002", "10005", "10006", "10007", "10008", "10009", "10012", "10013", "10041");
    private final String key;
    private final String secret;
    private final boolean enabled;
    private final WebClient http;

    public AmapPlaceClient(Environment environment, WebClient.Builder builder) {
        key = environment.getProperty("TRAVEL_AMAP_API_KEY", "");
        secret = environment.getProperty("TRAVEL_AMAP_API_SECRET", "");
        enabled = environment.getProperty("TRAVEL_AMAP_PLACES_ENABLED", Boolean.class, false);
        http = builder.baseUrl("https://restapi.amap.com").build();
    }

    public Mono<Map<String, Object>> search(Map<String, Object> brief, String domain, String keyword, int page, int pageSize) {
        if (!TYPES.containsKey(domain) || keyword == null || keyword.length() > 80
                || page < 1 || pageSize < 1 || pageSize > 25 || (long) (page - 1) * pageSize >= 200)
            throw new TravelError("invalid_place_search");
        TripStateFactory.safeObject(Map.of("keyword", keyword));
        String destination = text(brief.get("destination"), 120);
        String country = text(brief.get("countryCode"), 2);
        if (destination == null) return Mono.just(status("needs_context", "destination_required"));
        if (country == null) return Mono.just(status("needs_context", "country_required"));
        if (!"CN".equals(country)) return Mono.just(status("source_not_covered", "amap_places_china_only"));
        if (!enabled || key.isBlank()) return Mono.just(status("provider_unavailable", "amap_places_not_configured"));
        var query = new TreeMap<String, String>();
        query.put("key", key); query.put("types", TYPES.get(domain)); query.put("region", destination);
        query.put("city_limit", "true"); query.put("show_fields", "business");
        query.put("page_num", String.valueOf(page)); query.put("page_size", String.valueOf(pageSize)); query.put("output", "json");
        if (!keyword.isBlank()) query.put("keywords", keyword.trim());
        if (!secret.isBlank()) query.put("sig", signature(query, secret));
        return http.get().uri(builder -> {
            builder.path("/v5/place/text"); query.forEach(builder::queryParam); return builder.build();
        }).retrieve().bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(Duration.ofSeconds(12))
                .<Map<String, Object>>map(payload -> {
                    var result = new LinkedHashMap<>(normalize(payload, destination, domain, page, pageSize, Instant.now()));
                    if ("completed".equals(result.get("status"))) result.put("keyword", keyword.trim());
                    return result;
                })
                .onErrorResume(error -> Mono.just(status("provider_unavailable", "amap_places_request_failed")));
    }

    static Map<String, Object> normalize(Map<String, Object> payload, String destination, String domain, int page, int pageSize, Instant now) {
        if (!"1".equals(payload.get("status"))) {
            String code = text(payload.get("infocode"), 20);
            if (code == null) code = "";
            if (QUOTA.contains(code)) return status("rate_limited", "amap_quota_limited");
            if (AUTH.contains(code)) return status("authorization_required", "amap_access_not_authorized");
            return status("provider_unavailable", "amap_request_rejected");
        }
        if (!(payload.get("pois") instanceof List<?> pois) || pois.size() > pageSize) return status("provider_unavailable", "invalid_places_response");
        int reported;
        try { reported = Integer.parseInt(String.valueOf(payload.get("count"))); }
        catch (NumberFormatException invalid) { return status("provider_unavailable", "invalid_places_count"); }
        if (reported != pois.size()) return status("provider_unavailable", "inconsistent_places_count");
        var candidates = new ArrayList<Map<String, Object>>();
        var unusable = new ArrayList<Map<String, Object>>();
        for (int index = 0; index < pois.size(); index++) {
            if (!(pois.get(index) instanceof Map<?, ?> poi)) {
                unusable.add(Map.of("index", index, "reason", "invalid_place_record"));
                continue;
            }
            String id = text(poi.get("id"), 128), name = text(poi.get("name"), 200);
            if (id == null || name == null) {
                unusable.add(Map.of("index", index, "reason", id == null ? "place_id_missing" : "place_name_missing"));
                continue;
            }
            var candidate = new LinkedHashMap<String, Object>();
            candidate.put("sourceId", id); candidate.put("domain", domain); candidate.put("name", name);
            candidate.put("address", text(poi.get("address"), 300)); candidate.put("city", text(poi.get("cityname"), 120));
            candidate.put("district", text(poi.get("adname"), 120)); candidate.put("type", text(poi.get("type"), 240));
            var coordinates = coordinates(poi.get("location"));
            candidate.put("coordinates", coordinates);
            candidate.put("coordinatesStatus", coordinates == null ? "not_returned_or_invalid" : "available");
            var business = poi.get("business") instanceof Map<?, ?> fields ? fields : Map.of();
            candidate.put("ratingReference", text(business.get("rating"), 40));
            candidate.put("averageCostReference", text(business.get("cost"), 40));
            candidate.put("openingHoursReference", text(business.get("opentime_week"), 300));
            candidate.put("mapReferenceOnly", true); candidate.put("inventoryVerified", false); candidate.put("openingVerified", false);
            try { candidates.add(TripStateFactory.safeObject(candidate)); }
            catch (TravelError invalid) { unusable.add(Map.of("index", index, "reason", "source_record_cannot_be_shared")); }
        }
        boolean atLimit = (long) page * pageSize >= 200;
        var result = new LinkedHashMap<String, Object>();
        result.put("status", "completed"); result.put("provider", SOURCE); result.put("destination", destination); result.put("domain", domain);
        result.put("page", page); result.put("pageSize", pageSize); result.put("returnedCount", reported);
        result.put("nextPage", reported == pageSize && !atLimit ? page + 1 : null);
        result.put("providerResultLimitReached", (long) (page - 1) * pageSize + reported >= 200);
        result.put("coverage", unusable.isEmpty() ? "page" : "partial"); result.put("candidates", candidates); result.put("unusable", unusable);
        result.put("checkedAt", now.toString()); result.put("freshUntil", now.plus(Duration.ofMinutes(30)).toString());
        result.put("sourceDocumentation", "https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch");
        return result;
    }

    private static Map<String, Object> coordinates(Object value) {
        String location = text(value, 80);
        if (location == null) return null;
        var parts = location.split(",", -1);
        if (parts.length != 2) return null;
        try {
            var longitude = new BigDecimal(parts[0]); var latitude = new BigDecimal(parts[1]);
            if (longitude.abs().compareTo(BigDecimal.valueOf(180)) > 0 || latitude.abs().compareTo(BigDecimal.valueOf(90)) > 0) return null;
            return Map.of("longitude", longitude, "latitude", latitude, "coordinateSystem", "GCJ-02");
        } catch (NumberFormatException invalid) { return null; }
    }

    private static String text(Object value, int limit) {
        if (!(value instanceof String text) || text.isBlank() || text.length() > limit) return null;
        return text.trim();
    }
    private static Map<String, Object> status(String status, String reason) { return Map.of("status", status, "reason", reason, "provider", SOURCE); }
    private static String signature(Map<String, String> values, String secret) {
        String canonical = values.entrySet().stream().map(entry -> entry.getKey() + "=" + entry.getValue()).collect(java.util.stream.Collectors.joining("&")) + secret;
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(canonical.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
