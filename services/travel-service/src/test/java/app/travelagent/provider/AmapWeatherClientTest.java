package app.travelagent.provider;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** Contract fixtures do not establish real AMap access or source licensing. */
class AmapWeatherClientTest {
    private static final String GEO = "{\"status\":\"1\",\"geocodes\":[{\"adcode\":\"310000\"}]}";
    private static final String WEATHER = """
            {"status":"1","forecasts":[{"city":"上海","adcode":"310000","reporttime":"2026-11-06 11:00:00","casts":[
              {"date":"2026-11-06","dayweather":"晴","nightweather":"多云","daytemp":"23","nighttemp":"15"},
              {"date":"2026-11-07","dayweather":"雨","nightweather":"雨","daytemp":"20","nighttemp":"12"}]}]}
            """;

    @Test
    void sourceReturnsActualForecastCoverageAndDoesNotClaimUncoveredDays() {
        var client = client(request -> response(request.url().getPath().contains("geocode") ? GEO : WEATHER));
        var result = client.forecast(Map.of("destination", "上海", "countryCode", "CN", "dates", "2026-11-06 至 2026-11-08")).block();
        assertEquals("completed", result.get("status"));
        assertEquals("partial", result.get("coverage"));
        assertEquals("Asia/Shanghai", result.get("timeZone"));
        assertEquals(2, ((java.util.List<?>) result.get("forecastDays")).size());
        assertFalse(result.toString().contains("test-key"));
        var outside = AmapWeatherClient.normalize(Map.of("status", "1", "forecasts", java.util.List.of(Map.of("adcode", "310000", "casts", java.util.List.of(Map.of("date", "2026-11-06"))))),
                Map.of("destination", "上海", "dates", "2026-12-01"), "310000", Instant.parse("2026-11-06T00:00:00Z"));
        assertEquals("outside_forecast_window", outside.get("coverage"));
    }

    @Test
    void missingPermissionAmbiguousLocationAndRateLimitsRemainDistinct() {
        var disabled = new AmapWeatherClient(new MockEnvironment(), WebClient.builder());
        assertEquals("provider_unavailable", disabled.forecast(Map.of("destination", "上海", "countryCode", "CN")).block().get("status"));
        assertEquals("source_not_covered", disabled.forecast(Map.of("destination", "东京", "countryCode", "JP")).block().get("status"));
        var ambiguous = client(request -> response("{\"status\":\"1\",\"geocodes\":[{\"adcode\":\"310000\"},{\"adcode\":\"320000\"}]}"));
        assertEquals("destination_ambiguous", ambiguous.forecast(Map.of("destination", "上海", "countryCode", "CN")).block().get("reason"));
        var limited = client(request -> response("{\"status\":\"0\",\"infocode\":\"10004\"}"));
        assertEquals("rate_limited", limited.forecast(Map.of("destination", "上海", "countryCode", "CN")).block().get("status"));
    }

    @Test
    void optionalAmapSignatureUsesTheOriginalSortedRequestValues() {
        var query = new java.util.concurrent.atomic.AtomicReference<String>();
        var env = new MockEnvironment().withProperty("TRAVEL_AMAP_API_KEY", "test-key")
                .withProperty("TRAVEL_AMAP_API_SECRET", "test-secret").withProperty("TRAVEL_AMAP_WEATHER_ENABLED", "true");
        var client = new AmapWeatherClient(env, WebClient.builder().exchangeFunction(request -> {
            if (request.url().getPath().contains("geocode")) query.set(request.url().getRawQuery());
            return response(request.url().getPath().contains("geocode") ? GEO : WEATHER);
        }));
        assertEquals("completed", client.forecast(Map.of("destination", "上海", "countryCode", "CN")).block().get("status"));
        assertTrue(query.get().contains("sig=f730a24b16b07a46b64ca0b445aed570"));
    }

    private static AmapWeatherClient client(org.springframework.web.reactive.function.client.ExchangeFunction exchange) {
        var env = new MockEnvironment().withProperty("TRAVEL_AMAP_API_KEY", "test-key").withProperty("TRAVEL_AMAP_WEATHER_ENABLED", "true");
        return new AmapWeatherClient(env, WebClient.builder().exchangeFunction(exchange));
    }
    private static Mono<ClientResponse> response(String body) {
        return Mono.just(ClientResponse.create(HttpStatus.OK).header("Content-Type", "application/json").body(body).build());
    }
}
