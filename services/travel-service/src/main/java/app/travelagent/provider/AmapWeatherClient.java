package app.travelagent.provider;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** Explicitly enabled AMap Web Service weather. No key or raw error is returned to callers. */
@Component
public class AmapWeatherClient {
    private static final String BASE = "https://restapi.amap.com";
    private static final Pattern DATE = Pattern.compile("(?<!\\d)(\\d{4}-\\d{2}-\\d{2})(?!\\d)");
    private final String apiKey;
    private final String apiSecret;
    private final boolean enabled;
    private final WebClient http;

    public AmapWeatherClient(Environment environment, WebClient.Builder builder) {
        apiKey = environment.getProperty("TRAVEL_AMAP_API_KEY", "");
        apiSecret = environment.getProperty("TRAVEL_AMAP_API_SECRET", "");
        enabled = environment.getProperty("TRAVEL_AMAP_WEATHER_ENABLED", Boolean.class, false);
        http = builder.baseUrl(BASE).build();
    }

    public Mono<Map<String, Object>> forecast(Map<String, Object> brief) {
        String country = string(brief.get("countryCode"));
        String destination = string(brief.get("destination"));
        if (destination.isBlank() || destination.length() > 120) return Mono.just(status("needs_context", "destination_required"));
        if (country.isBlank()) return Mono.just(status("needs_context", "country_required"));
        if (!"CN".equals(country)) return Mono.just(status("source_not_covered", "amap_weather_china_only"));
        if (!enabled || apiKey.isBlank()) return Mono.just(status("provider_unavailable", "amap_weather_not_configured"));
        return request("/v3/geocode/geo", Map.of("address", destination, "city", destination, "output", "json"))
                .flatMap(location -> {
                    var failure = failure(location);
                    if (failure != null) return Mono.just(failure);
                    var codes = new LinkedHashSet<String>();
                    for (var entry : objects(location.get("geocodes"))) {
                        String code = string(entry.get("adcode"));
                        if (code.matches("[0-9]{6}")) codes.add(code);
                    }
                    if (codes.isEmpty()) return Mono.just(status("needs_context", "destination_not_resolved"));
                    if (codes.size() > 1) return Mono.just(status("needs_context", "destination_ambiguous"));
                    String code = codes.iterator().next();
                    return request("/v3/weather/weatherInfo", Map.of("city", code, "extensions", "all", "output", "json"))
                            .map(payload -> normalize(payload, brief, code, Instant.now()));
                }).onErrorResume(error -> Mono.just(status("provider_unavailable", "amap_weather_request_failed")));
    }

    private Mono<Map<String, Object>> request(String path, Map<String, String> query) {
        var parameters = new java.util.TreeMap<>(query);
        parameters.put("key", apiKey);
        if (!apiSecret.isBlank()) parameters.put("sig", signature(parameters, apiSecret));
        return http.get().uri(builder -> {
                    builder.path(path);
                    parameters.forEach(builder::queryParam);
                    return builder.build();
                }).retrieve().bodyToMono(new org.springframework.core.ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(Duration.ofSeconds(12));
    }

    private static String signature(Map<String, String> parameters, String secret) {
        String text = parameters.entrySet().stream().map(entry -> entry.getKey() + "=" + entry.getValue())
                .collect(java.util.stream.Collectors.joining("&")) + secret;
        try { return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("MD5").digest(text.getBytes(java.nio.charset.StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    static Map<String, Object> normalize(Map<String, Object> payload, Map<String, Object> brief, String expectedCode, Instant checkedAt) {
        var failure = failure(payload);
        if (failure != null) return failure;
        var forecasts = objects(payload.get("forecasts"));
        if (forecasts.isEmpty()) return status("empty_verified", "forecast_not_returned");
        var forecast = forecasts.get(0);
        if (!expectedCode.equals(string(forecast.get("adcode")))) return status("provider_unavailable", "forecast_location_mismatch");
        List<Map<String, Object>> days = new ArrayList<>();
        Set<LocalDate> seen = new LinkedHashSet<>();
        for (var cast : objects(forecast.get("casts"))) {
            if (days.size() >= 8) return status("provider_unavailable", "unexpected_forecast_size");
            LocalDate date;
            try { date = LocalDate.parse(string(cast.get("date"))); } catch (DateTimeParseException invalid) { return status("provider_unavailable", "invalid_forecast_date"); }
            if (!seen.add(date)) return status("provider_unavailable", "duplicate_forecast_date");
            var day = new LinkedHashMap<String, Object>();
            day.put("date", date.toString());
            day.put("dayCondition", boundedText(cast.get("dayweather"), 80));
            day.put("nightCondition", boundedText(cast.get("nightweather"), 80));
            day.put("highC", temperature(cast.getOrDefault("daytemp_float", cast.get("daytemp"))));
            day.put("lowC", temperature(cast.getOrDefault("nighttemp_float", cast.get("nighttemp"))));
            days.add(day);
        }
        if (days.isEmpty()) return status("empty_verified", "forecast_days_not_returned");
        List<LocalDate> requested = dates(string(brief.get("dates")));
        long covered = requested.stream().filter(seen::contains).count();
        String coverage = requested.isEmpty() ? "dates_unknown" : covered == 0 ? "outside_forecast_window" : covered == requested.size() ? "covered" : "partial";
        var result = new LinkedHashMap<String, Object>();
        result.put("status", "completed");
        result.put("provider", "amap_weather");
        result.put("destination", string(brief.get("destination")));
        result.put("city", boundedText(forecast.get("city"), 120));
        result.put("adcode", expectedCode);
        result.put("reportTime", boundedText(forecast.get("reporttime"), 40));
        result.put("checkedAt", checkedAt.toString());
        result.put("freshUntil", checkedAt.plus(Duration.ofHours(3)).toString());
        result.put("timeZone", "Asia/Shanghai");
        result.put("coverage", coverage);
        result.put("requestedDates", requested.stream().map(LocalDate::toString).toList());
        result.put("forecastDays", days);
        result.put("sourceDocumentation", "https://lbs.amap.com/api/webservice/guide/api/weatherinfo");
        return result;
    }

    private static List<LocalDate> dates(String value) {
        var matcher = DATE.matcher(value);
        var found = new ArrayList<LocalDate>();
        try {
            while (matcher.find()) { if (found.size() == 2) return List.of(); found.add(LocalDate.parse(matcher.group(1))); }
            if (found.isEmpty()) return List.of();
            var start = found.get(0);
            var end = found.size() == 2 ? found.get(1) : start;
            if (end.isBefore(start) || end.isAfter(start.plusDays(59))) return List.of();
            var dates = new ArrayList<LocalDate>();
            for (var day = start; !day.isAfter(end); day = day.plusDays(1)) dates.add(day);
            return dates;
        } catch (DateTimeParseException invalid) { return List.of(); }
    }

    private static Map<String, Object> failure(Map<String, Object> payload) {
        if ("1".equals(string(payload.get("status")))) return null;
        String code = string(payload.get("infocode"));
        if (Set.of("10003", "10004", "10010").contains(code)) return status("rate_limited", "amap_quota_limited");
        if (Set.of("10001", "10002", "10005", "10006", "10007", "10009").contains(code)) return status("authorization_required", "amap_access_not_authorized");
        return status("provider_unavailable", "amap_request_rejected");
    }

    private static Map<String, Object> status(String status, String reason) { return Map.of("status", status, "reason", reason, "provider", "amap_weather"); }
    private static String string(Object value) { return value instanceof String text ? text : ""; }
    private static String boundedText(Object value, int max) { String text = string(value); return text.isBlank() || text.length() > max ? null : text; }
    private static BigDecimal temperature(Object value) {
        try { var result = new BigDecimal(String.valueOf(value)); return result.abs().compareTo(new BigDecimal("100")) <= 0 ? result : null; }
        catch (NumberFormatException invalid) { return null; }
    }
    private static List<Map<String, Object>> objects(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        var result = new ArrayList<Map<String, Object>>();
        for (Object item : list) if (item instanceof Map<?, ?> map) {
            var copy = new LinkedHashMap<String, Object>();
            for (var entry : map.entrySet()) if (entry.getKey() instanceof String key) copy.put(key, entry.getValue());
            result.add(copy);
        }
        return result;
    }
}
