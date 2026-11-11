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

/** Provider fixtures exercise parsing and request construction, not live authorization. */
class AmapPlaceClientTest {
    private static final String RESPONSE = """
            {"status":"1","infocode":"10000","count":"2","pois":[
              {"id":"POI123","name":"测试地点","address":"测试路","cityname":"上海市","location":"121.5,31.2",
               "business":{"rating":"4.5","cost":"90","opentime_week":"周一至周日 9:00-18:00","tel":"13800138000"}},
              {"id":"POI456","address":"缺少名称"}]}
            """;

    @Test
    void searchPreservesTheSourcePageAndReportsAnUnusableCandidate() {
        var request = new AtomicReference<java.net.URI>();
        var client = client(req -> { request.set(req.url()); return response(RESPONSE); });
        var result = client.search(Map.of("destination", "上海市", "countryCode", "CN"), "play", "博物馆", 1, 2).block();
        assertEquals("completed", result.get("status"));
        assertEquals("partial", result.get("coverage"));
        assertEquals(2, result.get("returnedCount"));
        assertEquals(2, result.get("nextPage"));
        assertEquals("place_name_missing", ((Map<?, ?>) ((List<?>) result.get("unusable")).get(0)).get("reason"));
        var candidate = (Map<?, ?>) ((List<?>) result.get("candidates")).get(0);
        assertEquals("测试地点", candidate.get("name"));
        assertEquals("GCJ-02", ((Map<?, ?>) candidate.get("coordinates")).get("coordinateSystem"));
        assertEquals(false, candidate.get("inventoryVerified"));
        assertEquals(false, candidate.get("openingVerified"));
        assertFalse(result.toString().contains("13800138000"));
        assertFalse(result.toString().contains("test-key"));
        assertEquals("/v5/place/text", request.get().getPath());
        assertTrue(request.get().getRawQuery().contains("city_limit=true"));
        assertTrue(request.get().getRawQuery().contains("page_size=2"));
    }

    @Test
    void missingConfigurationBadSourceAndOutOfCoverageAreNotEmptySuccesses() {
        var disabled = new AmapPlaceClient(new MockEnvironment(), WebClient.builder());
        assertEquals("amap_places_not_configured", disabled.search(Map.of("destination", "上海市", "countryCode", "CN"), "food", "", 1, 10).block().get("reason"));
        assertEquals("source_not_covered", disabled.search(Map.of("destination", "东京", "countryCode", "JP"), "food", "", 1, 10).block().get("status"));
        assertThrows(TravelError.class, () -> disabled.search(Map.of("destination", "上海市", "countryCode", "CN"), "food", "手机号:13800138000", 1, 10));
        assertThrows(TravelError.class, () -> disabled.search(Map.of("destination", "上海市", "countryCode", "CN"), "food", "", 9, 25));
        var failed = client(req -> response("{\"status\":\"0\",\"infocode\":\"10004\"}"));
        assertEquals("rate_limited", failed.search(Map.of("destination", "上海市", "countryCode", "CN"), "food", "", 1, 10).block().get("status"));
        var inconsistent = AmapPlaceClient.normalize(Map.of("status", "1", "count", "2", "pois", List.of()), "上海市", "food", 1, 10, Instant.now());
        assertEquals("inconsistent_places_count", inconsistent.get("reason"));
        var sensitive = AmapPlaceClient.normalize(Map.of("status", "1", "count", "1", "pois", List.of(Map.of("id", "poi", "name", "联系 13800138000"))),
                "上海市", "food", 1, 10, Instant.now());
        assertEquals("partial", sensitive.get("coverage"));
        assertEquals("source_record_cannot_be_shared", ((Map<?, ?>) ((List<?>) sensitive.get("unusable")).get(0)).get("reason"));
        assertFalse(sensitive.toString().contains("13800138000"));
    }

    @Test
    void paginationNeverClaimsFullCoverageBeyondTheProviderLimit() {
        var pois = java.util.stream.IntStream.range(0, 25).mapToObj(i -> Map.of("id", "p" + i, "name", "地点" + i)).toList();
        var result = AmapPlaceClient.normalize(Map.of("status", "1", "count", "25", "pois", pois), "上海市", "food", 8, 25, Instant.now());
        assertNull(result.get("nextPage"));
        assertEquals(true, result.get("providerResultLimitReached"));
        assertEquals(25, ((List<?>) result.get("candidates")).size());
        var finalPartial = AmapPlaceClient.normalize(Map.of("status", "1", "count", "8", "pois", pois.subList(0, 8)), "上海市", "food", 9, 24, Instant.now());
        assertEquals(true, finalPartial.get("providerResultLimitReached"));
        assertNull(finalPartial.get("nextPage"));
    }

    private static AmapPlaceClient client(org.springframework.web.reactive.function.client.ExchangeFunction exchange) {
        var env = new MockEnvironment().withProperty("TRAVEL_AMAP_API_KEY", "test-key").withProperty("TRAVEL_AMAP_PLACES_ENABLED", "true");
        return new AmapPlaceClient(env, WebClient.builder().exchangeFunction(exchange));
    }
    private static Mono<ClientResponse> response(String body) {
        return Mono.just(ClientResponse.create(HttpStatus.OK).header("Content-Type", "application/json").body(body).build());
    }
}
