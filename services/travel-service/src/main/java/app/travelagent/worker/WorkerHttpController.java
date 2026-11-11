package app.travelagent.worker;

import app.travelagent.core.TravelError;
import app.travelagent.core.TravelResults;
import app.travelagent.core.TravelTasks;
import app.travelagent.core.TravelWalkingRoutes;
import app.travelagent.core.TripStateFactory;
import app.travelagent.provider.AmapWeatherClient;
import app.travelagent.provider.AmapPlaceClient;
import app.travelagent.provider.CiriumFlightStatusClient;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.support.TransactionTemplate;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** Restricted executor transport; it has no endpoint that commits a travel plan. */
@RestController
public class WorkerHttpController {
    private final TravelTasks tasks;
    private final TravelResults results;
    private final AmapWeatherClient weather;
    private final AmapPlaceClient places;
    private final CiriumFlightStatusClient flightStatus;
    private final TravelWalkingRoutes walkingRoutes;
    private final TransactionTemplate transactions;
    public WorkerHttpController(TravelTasks tasks, TravelResults results, AmapWeatherClient weather, AmapPlaceClient places,
                                CiriumFlightStatusClient flightStatus, TravelWalkingRoutes walkingRoutes, TransactionTemplate transactions) {
        this.tasks = tasks; this.results = results; this.weather = weather; this.places = places;
        this.flightStatus = flightStatus; this.walkingRoutes = walkingRoutes; this.transactions = transactions;
    }

    @PostMapping("/internal/worker/claim")
    public Mono<ResponseEntity<?>> claim() { return call(tasks::claim); }

    @PostMapping("/internal/worker/context")
    public Mono<ResponseEntity<?>> context(@RequestBody Map<String, Object> request) {
        return call(() -> {
            keys(request, Set.of("taskId", "generation", "leaseId"));
            var context = tasks.workerContext(id(request, "taskId"), generation(request), id(request, "leaseId"));
            return Map.of("tripId", context.tripId().toString(), "revision", context.revision(), "state", context.state());
        });
    }

    @PostMapping("/internal/worker/heartbeat")
    public Mono<ResponseEntity<?>> heartbeat(@RequestBody Map<String, Object> request) {
        return call(() -> { keys(request, Set.of("taskId", "generation", "leaseId")); return tasks.heartbeat(id(request, "taskId"), generation(request), id(request, "leaseId")); });
    }

    @PostMapping("/internal/worker/checkpoint")
    public Mono<ResponseEntity<?>> checkpoint(@RequestBody Map<String, Object> request) {
        return call(() -> { keys(request, Set.of("taskId", "generation", "leaseId", "checkpoint"));
            return tasks.checkpoint(id(request, "taskId"), generation(request), id(request, "leaseId"), object(request, "checkpoint")); });
    }

    @PostMapping("/internal/worker/finish")
    public Mono<ResponseEntity<?>> finish(@RequestBody Map<String, Object> request) {
        return call(() -> { keys(request, Set.of("taskId", "generation", "leaseId", "output"));
            return tasks.finish(id(request, "taskId"), generation(request), id(request, "leaseId"), object(request, "output")); });
    }

    @PostMapping("/internal/worker/fail")
    public Mono<ResponseEntity<?>> fail(@RequestBody Map<String, Object> request) {
        return call(() -> { keys(request, Set.of("taskId", "generation", "leaseId", "code"));
            if (!(request.get("code") instanceof String code)) throw new TravelError("invalid_task_input");
            return tasks.fail(id(request, "taskId"), generation(request), id(request, "leaseId"), code); });
    }

    @PostMapping("/internal/worker/result")
    public Mono<ResponseEntity<?>> result(@RequestBody Map<String, Object> request) {
        return call(() -> { keys(request, Set.of("taskId", "generation", "leaseId", "resultId"));
            var context = tasks.workerContext(id(request, "taskId"), generation(request), id(request, "leaseId"));
            var result = results.read(context.accountId(), id(request, "resultId"));
            if (!context.tripId().toString().equals(result.get("tripId"))) throw new TravelError("result_not_found");
            return TravelResults.modelSummary(result);
        });
    }

    @PostMapping("/internal/worker/weather")
    public Mono<ResponseEntity<?>> weather(@RequestBody Map<String, Object> request) {
        return call(() -> {
            keys(request, Set.of("taskId", "generation", "leaseId"));
            UUID task = id(request, "taskId"), lease = id(request, "leaseId");
            long generation = generation(request);
            var context = tasks.workerContext(task, generation, lease);
            var result = weather.forecast(object(context.state(), "brief")).block(java.time.Duration.ofSeconds(30));
            if (result == null) throw new TravelError("provider_unavailable");
            return transactions.execute(status -> {
                tasks.workerContext(task, generation, lease);
                if (!"completed".equals(result.get("status"))) return result;
                var reference = results.saveWeather(context.accountId(), context.tripId(), context.revision(), result);
                var previous = tasks.get(context.accountId(), task).get("checkpoint");
                var checkpoint = previous instanceof Map<?, ?> ? new java.util.LinkedHashMap<>(object(Map.of("value", previous), "value"))
                        : new java.util.LinkedHashMap<String, Object>();
                checkpoint.put("weatherResultId", reference.get("resultId"));
                tasks.checkpoint(task, generation, lease, checkpoint);
                return reference;
            });
        });
    }

    @PostMapping("/internal/worker/places")
    public Mono<ResponseEntity<?>> places(@RequestBody Map<String, Object> request) {
        return call(() -> {
            keys(request, Set.of("taskId", "generation", "leaseId", "domain", "keyword", "page", "pageSize"));
            UUID task = id(request, "taskId"), lease = id(request, "leaseId");
            long generation = generation(request);
            if (!(request.get("domain") instanceof String domain) || !(request.get("keyword") instanceof String rawKeyword)) throw new TravelError("invalid_task_input");
            String keyword = rawKeyword.trim();
            int page = positiveInt(request, "page"), pageSize = positiveInt(request, "pageSize");
            if (!List.of("food", "stay", "play", "transport").contains(domain) || keyword.length() > 80 || pageSize > 25
                    || (long) (page - 1) * pageSize >= 200) throw new TravelError("invalid_place_search");
            TripStateFactory.safeObject(Map.of("keyword", keyword));
            var context = tasks.workerContext(task, generation, lease);
            var cached = transactions.execute(status -> {
                tasks.workerContext(task, generation, lease);
                return cachedPlaces(context, task, domain, keyword, page, pageSize);
            });
            if (cached != null) return TravelResults.modelSummary(cached);
            var source = places.search(object(context.state(), "brief"), domain, keyword, page, pageSize).block(java.time.Duration.ofSeconds(30));
            if (source == null) throw new TravelError("provider_unavailable");
            return transactions.execute(status -> {
                tasks.workerContext(task, generation, lease);
                var repeated = cachedPlaces(context, task, domain, keyword, page, pageSize);
                if (repeated != null) return TravelResults.modelSummary(repeated);
                if (!"completed".equals(source.get("status"))) return source;
                var checkpoint = checkpoint(context.accountId(), task);
                var prior = placeSearches(checkpoint);
                var searches = new ArrayList<Map<String, Object>>();
                for (var entry : prior) if (!matches(entry, domain, keyword, page, pageSize)) searches.add(entry);
                if (searches.size() >= 100) throw new TravelError("research_limit_reached");
                var reference = results.savePlaces(context.accountId(), context.tripId(), context.revision(), source);
                searches.add(Map.of("domain", domain, "keyword", keyword, "page", page, "pageSize", pageSize, "resultId", reference.get("resultId")));
                checkpoint.put("placeSearches", searches);
                tasks.checkpoint(task, generation, lease, checkpoint);
                return TravelResults.modelSummary(reference);
            });
        });
    }

    @PostMapping("/internal/worker/flightstatus")
    public Mono<ResponseEntity<?>> flightStatus(@RequestBody Map<String, Object> request) {
        return call(() -> {
            keys(request, Set.of("taskId", "generation", "leaseId", "carrier", "flight", "departureAirportIata", "departureDateLocal"));
            UUID task = id(request, "taskId"), lease = id(request, "leaseId");
            long generation = generation(request);
            var query = Map.of("carrier", string(request, "carrier"), "flight", string(request, "flight"),
                    "departureAirportIata", string(request, "departureAirportIata"), "departureDateLocal", string(request, "departureDateLocal"));
            var context = tasks.workerContext(task, generation, lease);
            var cached = transactions.execute(status -> {
                tasks.workerContext(task, generation, lease);
                return cachedFlight(context, task, query);
            });
            if (cached != null) return TravelResults.modelSummary(cached);
            var source = flightStatus.lookup(query.get("carrier"), query.get("flight"), query.get("departureAirportIata"), query.get("departureDateLocal"))
                    .block(java.time.Duration.ofSeconds(30));
            if (source == null) throw new TravelError("provider_unavailable");
            return transactions.execute(status -> {
                tasks.workerContext(task, generation, lease);
                var repeated = cachedFlight(context, task, query);
                if (repeated != null) return TravelResults.modelSummary(repeated);
                if (!"completed".equals(source.get("status"))) return source;
                if (!query.equals(source.get("query"))) throw new TravelError("invalid_source_result");
                var checkpoint = checkpoint(context.accountId(), task);
                var searches = new ArrayList<Map<String, Object>>();
                for (var entry : flightSearches(checkpoint)) if (!query.equals(entry.get("query"))) searches.add(entry);
                if (searches.size() >= 100) throw new TravelError("research_limit_reached");
                var reference = results.saveFlightStatus(context.accountId(), context.tripId(), context.revision(), source);
                searches.add(Map.of("query", query, "resultId", reference.get("resultId")));
                checkpoint.put("flightSearches", searches);
                tasks.checkpoint(task, generation, lease, checkpoint);
                return TravelResults.modelSummary(reference);
            });
        });
    }

    @PostMapping("/internal/worker/walking")
    public Mono<ResponseEntity<?>> walking(@RequestBody Map<String, Object> request) {
        return call(() -> {
            keys(request, Set.of("taskId", "generation", "leaseId", "origin", "destination"));
            UUID task = id(request, "taskId"), lease = id(request, "leaseId"); long generation = generation(request);
            var from = object(request, "origin"); var to = object(request, "destination");
            keys(from, Set.of("resultId", "sourceId")); keys(to, Set.of("resultId", "sourceId"));
            UUID originResult = id(from, "resultId"), destinationResult = id(to, "resultId");
            String originId = string(from, "sourceId"), destinationId = string(to, "sourceId");
            var endpoints = Map.<String, Object>of("origin", Map.of("resultId", originResult.toString(), "sourceId", originId),
                    "destination", Map.of("resultId", destinationResult.toString(), "sourceId", destinationId));
            var context = tasks.workerContext(task, generation, lease);
            var cached = transactions.execute(status -> {
                tasks.workerContext(task, generation, lease);
                walkingRoutes.requireCurrentEndpoints(context.accountId(), context.tripId(), context.revision(), originResult, originId, destinationResult, destinationId);
                return cachedWalking(context, task, endpoints);
            });
            if (cached != null) return TravelResults.modelSummary(cached);
            var result = walkingRoutes.queryFenced(context.accountId(), context.tripId(), originResult, originId, destinationResult, destinationId,
                    () -> tasks.workerContext(task, generation, lease), save -> {
                        var repeated = cachedWalking(context, task, endpoints);
                        if (repeated != null) return repeated;
                        var checkpoint = checkpoint(context.accountId(), task);
                        var searches = new ArrayList<Map<String, Object>>();
                        for (var entry : savedSearches(checkpoint, "walkingSearches")) if (!endpoints.equals(entry.get("endpoints"))) searches.add(entry);
                        if (searches.size() >= 100) throw new TravelError("research_limit_reached");
                        var reference = save.get();
                        searches.add(Map.of("endpoints", endpoints, "resultId", reference.get("resultId")));
                        checkpoint.put("walkingSearches", searches);
                        tasks.checkpoint(task, generation, lease, checkpoint);
                        return reference;
                    });
            return result.containsKey("resultId") ? TravelResults.modelSummary(result) : result;
        });
    }

    private Map<String, Object> cachedWalking(TravelTasks.WorkerContext context, UUID task, Map<String, Object> endpoints) {
        for (var entry : savedSearches(checkpoint(context.accountId(), task), "walkingSearches")) {
            if (!endpoints.equals(entry.get("endpoints"))) continue;
            try {
                var result = results.read(context.accountId(), UUID.fromString((String) entry.get("resultId")));
                if (context.tripId().toString().equals(result.get("tripId")) && "walking_route".equals(result.get("kind"))
                        && Boolean.FALSE.equals(result.get("stale")) && Boolean.FALSE.equals(result.get("expired"))
                        && result.get("data") instanceof Map<?, ?> data && endpoints.equals(data.get("endpoints"))) return result;
            } catch (IllegalArgumentException | ClassCastException | TravelError ignored) { /* The old reference cannot be reused. */ }
        }
        return null;
    }

    private Map<String, Object> cachedFlight(TravelTasks.WorkerContext context, UUID task, Map<String, String> query) {
        for (var entry : flightSearches(checkpoint(context.accountId(), task))) {
            if (!query.equals(entry.get("query"))) continue;
            try {
                var result = results.read(context.accountId(), UUID.fromString((String) entry.get("resultId")));
                if (context.tripId().toString().equals(result.get("tripId")) && "flight_status".equals(result.get("kind"))
                        && Boolean.FALSE.equals(result.get("stale")) && Boolean.FALSE.equals(result.get("expired"))
                        && result.get("data") instanceof Map<?, ?> data && query.equals(data.get("query"))) return result;
            } catch (IllegalArgumentException | ClassCastException | TravelError ignored) { /* The old reference cannot be reused. */ }
        }
        return null;
    }

    private Map<String, Object> cachedPlaces(TravelTasks.WorkerContext context, UUID task, String domain, String keyword, int page, int pageSize) {
        for (var entry : placeSearches(checkpoint(context.accountId(), task))) {
            if (!matches(entry, domain, keyword, page, pageSize)) continue;
            try {
                var result = results.read(context.accountId(), UUID.fromString((String) entry.get("resultId")));
                if (context.tripId().toString().equals(result.get("tripId")) && "places".equals(result.get("kind"))
                        && Boolean.FALSE.equals(result.get("stale")) && Boolean.FALSE.equals(result.get("expired"))
                        && result.get("data") instanceof Map<?, ?> data && matchesSource(data, domain, keyword, page, pageSize)) return result;
            } catch (IllegalArgumentException | ClassCastException | TravelError ignored) { /* The old reference cannot be reused. */ }
        }
        return null;
    }

    private Map<String, Object> checkpoint(UUID account, UUID task) {
        Object previous = tasks.get(account, task).get("checkpoint");
        return previous instanceof Map<?, ?> ? new LinkedHashMap<>(object(Map.of("value", previous), "value")) : new LinkedHashMap<>();
    }
    private static List<Map<String, Object>> placeSearches(Map<String, Object> checkpoint) {
        return savedSearches(checkpoint, "placeSearches");
    }
    private static List<Map<String, Object>> savedSearches(Map<String, Object> checkpoint, String key) {
        Object value = checkpoint.get(key);
        if (value == null) return List.of();
        if (!(value instanceof List<?> entries) || entries.size() > 100) throw new TravelError("invalid_task_input");
        var result = new ArrayList<Map<String, Object>>();
        for (Object entry : entries) {
            if (!(entry instanceof Map<?, ?>)) throw new TravelError("invalid_task_input");
            result.add(object(Map.of("value", entry), "value"));
        }
        return result;
    }
    private static List<Map<String, Object>> flightSearches(Map<String, Object> checkpoint) {
        return savedSearches(checkpoint, "flightSearches");
    }
    private static boolean matches(Map<String, Object> entry, String domain, String keyword, int page, int pageSize) {
        return domain.equals(entry.get("domain")) && keyword.equals(entry.get("keyword"))
                && entry.get("page") instanceof Number p && p.intValue() == page && p.doubleValue() == page
                && entry.get("pageSize") instanceof Number n && n.intValue() == pageSize && n.doubleValue() == pageSize;
    }
    private static boolean matchesSource(Map<?, ?> source, String domain, String keyword, int page, int pageSize) {
        return domain.equals(source.get("domain")) && keyword.equals(source.get("keyword"))
                && source.get("page") instanceof Number p && p.intValue() == page && p.doubleValue() == page
                && source.get("pageSize") instanceof Number n && n.intValue() == pageSize && n.doubleValue() == pageSize;
    }

    private static Mono<ResponseEntity<?>> call(Callable<Map<String, Object>> action) {
        return Mono.fromCallable(action).subscribeOn(Schedulers.boundedElastic())
                .<ResponseEntity<?>>map(value -> ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value))
                .onErrorResume(TravelError.class, error -> Mono.<ResponseEntity<?>>just(ResponseEntity.status(switch (error.code()) {
                    case "stale_execution", "revision_conflict" -> HttpStatus.CONFLICT;
                    case "permission_revoked", "task_not_found" -> HttpStatus.FORBIDDEN;
                    case "background_executor_not_configured" -> HttpStatus.SERVICE_UNAVAILABLE;
                    default -> HttpStatus.BAD_REQUEST;
                }).cacheControl(CacheControl.noStore()).body(Map.of("error", error.code()))))
                .onErrorResume(error -> Mono.<ResponseEntity<?>>just(ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).cacheControl(CacheControl.noStore()).body(Map.of("error", "worker_operation_unavailable"))));
    }
    private static void keys(Map<String, Object> input, Set<String> allowed) {
        if (input == null || !allowed.equals(input.keySet())) throw new TravelError("invalid_task_input");
    }
    private static UUID id(Map<String, Object> input, String key) {
        try { return UUID.fromString((String) input.get(key)); } catch (RuntimeException invalid) { throw new TravelError("invalid_task_input"); }
    }
    private static String string(Map<String, Object> input, String key) {
        if (!(input.get(key) instanceof String value)) throw new TravelError("invalid_task_input");
        return value;
    }
    private static long generation(Map<String, Object> input) {
        if (!(input.get("generation") instanceof Number number) || number.longValue() < 1 || number.doubleValue() != number.longValue()) throw new TravelError("invalid_task_input");
        return number.longValue();
    }
    private static int positiveInt(Map<String, Object> input, String key) {
        if (!(input.get(key) instanceof Number number) || number.doubleValue() != number.intValue() || number.intValue() < 1) throw new TravelError("invalid_task_input");
        return number.intValue();
    }
    @SuppressWarnings("unchecked") private static Map<String, Object> object(Map<String, Object> input, String key) {
        if (!(input.get(key) instanceof Map<?, ?>)) throw new TravelError("invalid_task_input");
        return (Map<String, Object>) input.get(key);
    }
}
