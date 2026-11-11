package app.travelagent.provider;

import app.travelagent.core.TravelError;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import reactor.core.publisher.Mono;

/** Optional read-only status lookup. Results are candidates, not proof of a user's booking. */
@Component
public final class CiriumFlightStatusClient {
    private static final String SOURCE = "cirium_flight_status";
    private static final Map<String, String> STATUSES = Map.of("A", "active", "C", "cancelled", "D", "diverted", "DN", "data_source_needed",
            "L", "landed", "NO", "not_operational", "R", "redirected", "S", "scheduled", "U", "unknown");
    private static final List<String> TIMES = List.of("publishedDeparture", "scheduledGateDeparture", "estimatedGateDeparture", "actualGateDeparture",
            "publishedArrival", "scheduledGateArrival", "estimatedGateArrival", "actualGateArrival");
    private final String appId;
    private final String appKey;
    private final boolean enabled;
    private final WebClient http;

    public CiriumFlightStatusClient(Environment environment, WebClient.Builder builder) {
        appId = environment.getProperty("TRAVEL_CIRIUM_APP_ID", "");
        appKey = environment.getProperty("TRAVEL_CIRIUM_APP_KEY", "");
        enabled = environment.getProperty("TRAVEL_CIRIUM_STATUS_ENABLED", Boolean.class, false);
        http = builder.baseUrl("https://api.flightstats.com").build();
    }

    public Mono<Map<String, Object>> lookup(String carrier, String flight, String airport, String date) {
        if (carrier == null || !carrier.matches("[A-Z0-9]{2}") || flight == null || !flight.matches("[0-9]{1,4}[A-Z]?")
                || airport == null || !airport.matches("[A-Z]{3}") || date == null || !date.matches("20\\d{2}-\\d{2}-\\d{2}"))
            throw new TravelError("invalid_flight_status_query");
        LocalDate departure;
        try { departure = LocalDate.parse(date); }
        catch (java.time.format.DateTimeParseException invalid) { throw new TravelError("invalid_flight_status_query"); }
        if (!enabled || appId.isBlank() || appKey.isBlank()) return Mono.just(status("provider_unavailable", "cirium_status_not_configured"));
        return http.get().uri(builder -> builder.path("/flex/flightstatus/rest/v2/json/flight/status/{carrier}/{flight}/dep/{year}/{month}/{day}")
                        .queryParam("appId", appId).queryParam("appKey", appKey).queryParam("utc", "false")
                        .queryParam("airport", airport).queryParam("codeType", "IATA")
                        .build(carrier, flight, departure.getYear(), departure.getMonthValue(), departure.getDayOfMonth()))
                .retrieve().bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(Duration.ofSeconds(12))
                .map(payload -> normalize(payload, carrier, flight, airport, date, Instant.now()))
                .onErrorResume(error -> {
                    if (error instanceof WebClientResponseException response && response.getStatusCode().value() == 403)
                        return Mono.just(status("provider_unavailable", "cirium_access_or_quota"));
                    if (error instanceof WebClientResponseException response && response.getStatusCode().value() == 429)
                        return Mono.just(status("rate_limited", "cirium_quota_limited"));
                    return Mono.just(status("provider_unavailable", "cirium_status_request_failed"));
                });
    }

    static Map<String, Object> normalize(Map<String, Object> payload, String carrier, String flight, String airport, String date, Instant now) {
        // The upstream response may echo its request, including credentials. Never return or store it.
        if (payload.containsKey("error") && payload.get("error") != null) return status("provider_unavailable", "cirium_request_rejected");
        if (!(payload.get("flightStatuses") instanceof List<?> flights) || flights.size() > 64)
            return status("provider_unavailable", "invalid_flight_status_response");
        var candidates = new ArrayList<Map<String, Object>>();
        var unusable = new ArrayList<Map<String, Object>>();
        for (int index = 0; index < flights.size(); index++) {
            if (!(flights.get(index) instanceof Map<?, ?> raw)) { unusable.add(Map.of("index", index, "reason", "invalid_flight_record")); continue; }
            String id = value(raw.get("flightId"), "[0-9]{1,20}"), sourceNumber = value(raw.get("flightNumber"), "[A-Za-z0-9]{1,10}");
            String sourceStatus = value(raw.get("status"), "[A-Z]{1,4}");
            if (id == null || sourceNumber == null || sourceStatus == null) {
                unusable.add(Map.of("index", index, "reason", "flight_identity_or_status_missing")); continue;
            }
            var item = new LinkedHashMap<String, Object>();
            item.put("sourceFlightId", id); item.put("flightNumber", sourceNumber); item.put("statusCode", sourceStatus);
            item.put("statusMeaning", STATUSES.getOrDefault(sourceStatus, "unrecognized"));
            item.put("carrierFsCode", value(raw.get("carrierFsCode"), "[A-Za-z0-9]{2,4}"));
            item.put("departureAirportFsCode", value(raw.get("departureAirportFsCode"), "[A-Za-z0-9]{3,4}"));
            item.put("arrivalAirportFsCode", value(raw.get("arrivalAirportFsCode"), "[A-Za-z0-9]{3,4}"));
            var times = new LinkedHashMap<String, Object>();
            var invalidTimes = new ArrayList<String>();
            if (raw.get("operationalTimes") instanceof Map<?, ?> operational) for (String key : TIMES) {
                Object observed = operational.get(key);
                if (observed == null) continue;
                if (!(observed instanceof Map<?, ?> details) || !(details.get("dateUtc") instanceof String text)) { invalidTimes.add(key); continue; }
                try { times.put(key, Instant.parse(text).toString()); }
                catch (RuntimeException invalid) { invalidTimes.add(key); }
            }
            else if (raw.get("operationalTimes") != null) invalidTimes.add("operationalTimes");
            item.put("timesUtc", times); item.put("unusableTimeFields", invalidTimes);
            item.put("bookingMatchConfirmed", false); candidates.add(item);
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("status", "completed"); result.put("provider", SOURCE);
        result.put("query", Map.of("carrier", carrier, "flight", flight, "departureAirportIata", airport, "departureDateLocal", date));
        boolean partialTimes = candidates.stream().anyMatch(item -> !((List<?>) item.get("unusableTimeFields")).isEmpty());
        result.put("coverage", unusable.isEmpty() && !partialTimes ? "query" : "partial"); result.put("returnedCount", flights.size());
        result.put("candidates", candidates); result.put("unusable", unusable);
        result.put("checkedAt", now.toString()); result.put("freshUntil", now.plus(Duration.ofMinutes(15)).toString());
        result.put("sourceWindow", "approximately_three_days_before_departure_to_seven_days_after_arrival");
        result.put("sourceDocumentation", "https://developer.flightstats.com/api-docs/flightstatus/v2/flight");
        return result;
    }

    private static String value(Object raw, String pattern) {
        String text = raw instanceof String string ? string : raw instanceof Number ? raw.toString() : null;
        return text != null && text.matches(pattern) ? text : null;
    }
    private static Map<String, Object> status(String state, String reason) { return Map.of("status", state, "reason", reason, "provider", SOURCE); }
}
