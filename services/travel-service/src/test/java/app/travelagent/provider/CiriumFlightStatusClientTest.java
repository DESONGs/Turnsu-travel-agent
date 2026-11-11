package app.travelagent.provider;

import static org.junit.jupiter.api.Assertions.*;

import app.travelagent.core.TravelError;
import java.net.URI;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** Fixture requests do not prove access to Cirium or permission to use its data. */
class CiriumFlightStatusClientTest {
    @Test
    void returnsEveryUsableCandidateAndNeverEchoesTheUpstreamRequest() {
        var request = new AtomicReference<URI>();
        var client = client(req -> { request.set(req.url()); return response(HttpStatus.OK, """
                {"request":{"appId":"test-id","appKey":"test-key"},"flightStatuses":[
                  {"flightId":123456,"carrierFsCode":"AA","flightNumber":"100","departureAirportFsCode":"JFK","arrivalAirportFsCode":"LHR","status":"C",
                   "operationalTimes":{"scheduledGateDeparture":{"dateUtc":"2026-11-20T20:00:00.000Z"},"estimatedGateArrival":{"dateUtc":"bad"}}},
                  {"flightId":123457,"flightNumber":"100","status":"S"},
                  {"status":"U"}]}
                """); });
        var result = client.lookup("AA", "100", "JFK", "2026-11-20").block();
        assertEquals("completed", result.get("status"));
        assertEquals("partial", result.get("coverage"));
        assertEquals(3, result.get("returnedCount"));
        assertEquals(2, ((List<?>) result.get("candidates")).size());
        var first = (Map<?, ?>) ((List<?>) result.get("candidates")).get(0);
        assertEquals("C", first.get("statusCode"));
        assertEquals("cancelled", first.get("statusMeaning"));
        assertEquals("2026-11-20T20:00:00Z", ((Map<?, ?>) first.get("timesUtc")).get("scheduledGateDeparture"));
        assertEquals(List.of("estimatedGateArrival"), first.get("unusableTimeFields"));
        assertEquals(false, first.get("bookingMatchConfirmed"));
        assertEquals("flight_identity_or_status_missing", ((Map<?, ?>) ((List<?>) result.get("unusable")).get(0)).get("reason"));
        assertFalse(result.toString().contains("test-key"));
        assertFalse(result.toString().contains("test-id"));
        assertEquals("/flex/flightstatus/rest/v2/json/flight/status/AA/100/dep/2026/11/20", request.get().getPath());
        assertTrue(request.get().getRawQuery().contains("airport=JFK"));
        assertTrue(request.get().getRawQuery().contains("codeType=IATA"));
    }

    @Test
    void emptyUnavailableAndInvalidResponsesRemainDistinct() {
        var disabled = new CiriumFlightStatusClient(new MockEnvironment(), WebClient.builder());
        assertEquals("cirium_status_not_configured", disabled.lookup("AA", "100", "JFK", "2026-11-20").block().get("reason"));
        assertEquals("invalid_flight_status_query", assertThrows(TravelError.class, () -> disabled.lookup("AA", "100", "JFK", "2026-02-30")).code());
        assertEquals("invalid_flight_status_query", assertThrows(TravelError.class, () -> disabled.lookup("AA", "100", "上海", "2026-11-20")).code());
        var empty = client(req -> response(HttpStatus.OK, "{\"flightStatuses\":[]}"))
                .lookup("AA", "100", "JFK", "2026-11-20").block();
        assertEquals("completed", empty.get("status"));
        assertEquals(0, empty.get("returnedCount"));
        var denied = client(req -> response(HttpStatus.FORBIDDEN, "{\"secret\":\"test-key\"}"))
                .lookup("AA", "100", "JFK", "2026-11-20").block();
        assertEquals("cirium_access_or_quota", denied.get("reason"));
        assertFalse(denied.toString().contains("test-key"));
        var error = client(req -> response(HttpStatus.OK, "{\"error\":{\"message\":\"test-key\"}}"))
                .lookup("AA", "100", "JFK", "2026-11-20").block();
        assertEquals("cirium_request_rejected", error.get("reason"));
        assertFalse(error.toString().contains("test-key"));
    }

    private static CiriumFlightStatusClient client(ExchangeFunction exchange) {
        var env = new MockEnvironment().withProperty("TRAVEL_CIRIUM_APP_ID", "test-id").withProperty("TRAVEL_CIRIUM_APP_KEY", "test-key")
                .withProperty("TRAVEL_CIRIUM_STATUS_ENABLED", "true");
        return new CiriumFlightStatusClient(env, WebClient.builder().exchangeFunction(exchange));
    }
    private static Mono<ClientResponse> response(HttpStatus status, String body) {
        return Mono.just(ClientResponse.create(status).header("Content-Type", "application/json").body(body).build());
    }
}
