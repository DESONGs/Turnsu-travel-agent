package app.travelagent.provider;

import static org.junit.jupiter.api.Assertions.*;

import app.travelagent.core.TravelError;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** These fixtures verify the contract, not a live provider or its data license. */
class AmapWalkingRouteClientTest {
    private static final Map<String, Object> START = Map.of("longitude", 121.4700014, "latitude", 31.2300014, "coordinateSystem", "GCJ-02");
    private static final Map<String, Object> END = Map.of("longitude", 121.48, "latitude", 31.24, "coordinateSystem", "GCJ-02");
    private static final String RESPONSE = """
            {"status":"1","count":"3","route":{"paths":[
              {"distance":"1200","cost":{"duration":"900"},"steps":[{"instruction":"沿路前行","step_distance":"1200","navi":{"walk_type":"20"},"polyline":"121.47,31.23;121.48,31.24"}]},
              {"distance":"1300","cost":{"duration":"1000"},"steps":[{"instruction":"步行"}]},
              {"distance":"1400","steps":[]}
            ]}}
            """;

    @Test
    void allAlternativesAndMissingDetailsAreReportedWithoutClaimingStepFreeAccess() {
        var request = new AtomicReference<java.net.URI>();
        var client = client(req -> { request.set(req.url()); return response(RESPONSE); });
        var result = client.lookup(Map.of("countryCode", "CN"), START, END).block();
        assertEquals("completed", result.get("status"));
        assertEquals("partial", result.get("coverage"));
        assertEquals(3, result.get("returnedCount"));
        var alternatives = (List<?>) result.get("alternatives");
        assertEquals(2, alternatives.size());
        assertEquals(1, ((List<?>) result.get("unusable")).size());
        var first = (Map<?, ?>) alternatives.get(0); var second = (Map<?, ?>) alternatives.get(1);
        assertEquals(1200L, first.get("distanceMeters"));
        assertEquals(true, first.get("stairsReported"));
        assertNull(second.get("stairsReported"));
        assertEquals("not_verified", first.get("stepFreeStatus"));
        assertTrue(((List<?>) ((Map<?, ?>) ((List<?>) second.get("steps")).get(0)).get("missing")).contains("walk_type"));
        assertFalse(result.toString().contains("test-key"));
        assertEquals("/v5/direction/walking", request.get().getPath());
        assertTrue(request.get().getRawQuery().contains("origin=121.470001%2C31.230001") || request.get().getRawQuery().contains("origin=121.470001,31.230001"));
    }

    @Test
    void disabledInvalidAndInconsistentSourcesStayDistinct() {
        var disabled = new AmapWalkingRouteClient(new MockEnvironment(), WebClient.builder());
        assertEquals("amap_walking_not_configured", disabled.lookup(Map.of("countryCode", "CN"), START, END).block().get("reason"));
        assertEquals("needs_context", disabled.lookup(Map.of(), START, END).block().get("status"));
        assertEquals("source_not_covered", disabled.lookup(Map.of("countryCode", "JP"), START, END).block().get("status"));
        assertEquals("route_coordinates_unavailable", assertThrows(TravelError.class, () -> disabled.lookup(Map.of("countryCode", "CN"), Map.of("longitude", 1, "latitude", 1, "coordinateSystem", "WGS-84"), END)).code());
        assertEquals("inconsistent_walking_count", AmapWalkingRouteClient.normalize(Map.of("status", "1", "count", "2", "route", Map.of("paths", List.of())), Instant.now()).get("reason"));
        assertEquals("rate_limited", AmapWalkingRouteClient.normalize(Map.of("status", "0", "infocode", "10004"), Instant.now()).get("status"));
    }

    private static AmapWalkingRouteClient client(org.springframework.web.reactive.function.client.ExchangeFunction exchange) {
        var env = new MockEnvironment().withProperty("TRAVEL_AMAP_API_KEY", "test-key").withProperty("TRAVEL_AMAP_WALKING_ENABLED", "true");
        return new AmapWalkingRouteClient(env, WebClient.builder().exchangeFunction(exchange));
    }
    private static Mono<ClientResponse> response(String body) {
        return Mono.just(ClientResponse.create(HttpStatus.OK).header("Content-Type", "application/json").body(body).build());
    }
}
