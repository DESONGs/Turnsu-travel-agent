package app.travelagent.core;

import app.travelagent.provider.AmapWalkingRouteClient;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Supplier;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/** Resolve coordinates only from authorized, fresh place references for this trip. */
@Service
public class TravelWalkingRoutes {
    private final TravelTrips trips;
    private final TravelResults results;
    private final AmapWalkingRouteClient client;
    private final TransactionTemplate transactions;

    public TravelWalkingRoutes(TravelTrips trips, TravelResults results, AmapWalkingRouteClient client, TransactionTemplate transactions) {
        this.trips = trips; this.results = results; this.client = client; this.transactions = transactions;
    }

    public Map<String, Object> query(UUID actor, UUID tripId, UUID originResult, String originId, UUID destinationResult, String destinationId) {
        return queryFenced(actor, tripId, originResult, originId, destinationResult, destinationId, () -> {}, Supplier::get);
    }

    public void requireCurrentEndpoints(UUID actor, UUID tripId, long revision, UUID originResult, String originId, UUID destinationResult, String destinationId) {
        endpoint(actor, tripId, revision, originResult, originId);
        endpoint(actor, tripId, revision, destinationResult, destinationId);
    }

    /** The worker's fence and checkpoint run in the same transaction as the source reference save. */
    public Map<String, Object> queryFenced(UUID actor, UUID tripId, UUID originResult, String originId, UUID destinationResult, String destinationId,
                                           Runnable fence, Function<Supplier<Map<String, Object>>, Map<String, Object>> persist) {
        if (actor == null || tripId == null || originResult == null || destinationResult == null || !identifier(originId) || !identifier(destinationId))
            throw new TravelError("invalid_route_input");
        fence.run();
        var trip = trips.get(actor, tripId);
        long revision = ((Number) trip.get("revision")).longValue();
        var origin = endpoint(actor, tripId, revision, originResult, originId);
        var destination = endpoint(actor, tripId, revision, destinationResult, destinationId);
        var state = object(trip.get("state"));
        var source = client.lookup(object(state.get("brief")), origin.coordinates(), destination.coordinates()).block(Duration.ofSeconds(30));
        if (source == null) throw new TravelError("provider_unavailable");
        fence.run();
        if (!"completed".equals(source.get("status"))) return source;
        return transactions.execute(status -> {
            fence.run();
            var currentOrigin = endpoint(actor, tripId, revision, originResult, originId);
            var currentDestination = endpoint(actor, tripId, revision, destinationResult, destinationId);
            Instant expiry;
            try {
                expiry = Instant.parse((String) source.get("freshUntil"));
                if (currentOrigin.freshUntil().isBefore(expiry)) expiry = currentOrigin.freshUntil();
                if (currentDestination.freshUntil().isBefore(expiry)) expiry = currentDestination.freshUntil();
                if (!expiry.isAfter(Instant.parse((String) source.get("checkedAt"))) || !expiry.isAfter(Instant.now())) throw new TravelError("result_expired");
            } catch (ClassCastException | java.time.format.DateTimeParseException invalid) { throw new TravelError("invalid_source_result"); }
            var complete = new LinkedHashMap<>(source);
            complete.put("freshUntil", expiry.toString());
            complete.put("endpoints", Map.of("origin", Map.of("resultId", originResult.toString(), "sourceId", originId),
                    "destination", Map.of("resultId", destinationResult.toString(), "sourceId", destinationId)));
            return persist.apply(() -> results.saveWalkingRoute(actor, tripId, revision, complete));
        });
    }

    private Endpoint endpoint(UUID actor, UUID trip, long revision, UUID resultId, String sourceId) {
        var reference = results.read(actor, resultId);
        if (!trip.toString().equals(reference.get("tripId")) || !"places".equals(reference.get("kind")) || !"amap_places".equals(reference.get("source")))
            throw new TravelError("result_not_found");
        if (Boolean.TRUE.equals(reference.get("expired"))) throw new TravelError("result_expired");
        if (Boolean.TRUE.equals(reference.get("stale")) || ((Number) reference.get("tripRevision")).longValue() != revision) throw new TravelError("result_stale");
        var data = object(reference.get("data"));
        if (!(data.get("candidates") instanceof List<?> candidates)) throw new TravelError("invalid_source_result");
        var matched = candidates.stream().filter(candidate -> candidate instanceof Map<?, ?> place && sourceId.equals(place.get("sourceId"))).toList();
        if (matched.size() != 1) throw new TravelError(matched.isEmpty() ? "candidate_not_found" : "ambiguous_route_place");
        Object coordinates = ((Map<?, ?>) matched.get(0)).get("coordinates");
        if (!(coordinates instanceof Map<?, ?> point)) throw new TravelError("route_coordinates_unavailable");
        return new Endpoint(point, Instant.parse((String) reference.get("freshUntil")));
    }
    private static boolean identifier(String value) { return value != null && value.matches("[A-Za-z0-9_.:-]{1,128}"); }
    @SuppressWarnings("unchecked") private static Map<String, Object> object(Object value) {
        if (!(value instanceof Map<?, ?>)) throw new TravelError("invalid_source_result");
        return (Map<String, Object>) value;
    }
    private record Endpoint(Map<?, ?> coordinates, Instant freshUntil) {}
}
