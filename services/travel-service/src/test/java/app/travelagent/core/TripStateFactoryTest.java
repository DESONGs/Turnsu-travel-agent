package app.travelagent.core;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TripStateFactoryTest {
    @Test
    void overseasTripBeginsWithOneStateAndNoInventedCurrencyOrEvidence() {
        var state = TripStateFactory.create("trip-1", Map.of("countryCode", "JP", "destination", "Tokyo", "timeZone", "Asia/Tokyo"), Instant.parse("2026-11-06T00:00:00Z"));
        assertEquals("trip-control-state-v1", state.get("schemaVersion"));
        assertEquals(0, state.get("revision"));
        assertEquals("XXX", ((Map<?, ?>) state.get("budgetLedger")).get("currency"));
        assertEquals(List.of(), state.get("nodes"));
        assertEquals(4, ((List<?>) state.get("openDecisions")).size());
        assertEquals(java.util.Set.of("food", "stay", "transport", "play"), ((Map<?, ?>) state.get("taskQueues")).keySet());
        assertNull(((Map<?, ?>) state.get("environment")).get("weather"));
    }

    @Test
    void invalidConstraintsAndSensitiveInputAreRejectedBeforeTheyCanBeStored() {
        assertEquals("invalid_budget", assertThrows(TravelError.class, () -> TripStateFactory.create("id", Map.of("totalBudget", -1), Instant.now())).code());
        assertEquals("invalid_time_zone", assertThrows(TravelError.class, () -> TripStateFactory.create("id", Map.of("timeZone", "Not/AZone"), Instant.now())).code());
        assertEquals("sensitive_trip_input_blocked", assertThrows(TravelError.class, () -> TripStateFactory.create("id", Map.of("traveler", Map.of("passportNumber", "E12345678")), Instant.now())).code());
        assertEquals("sensitive_trip_input_blocked", assertThrows(TravelError.class, () -> TripStateFactory.create("id", Map.of("note", "token: private-value"), Instant.now())).code());
    }

    @Test
    void generatedReferenceUuidIsNotTreatedAsACardButFreeTextStillIs() {
        String id = "b64f930d-3698-4308-8977-2e1cfa5d5c73";
        assertEquals(id, TripStateFactory.safeObject(Map.of("weatherResultId", id)).get("weatherResultId"));
        assertEquals(List.of(id), TripStateFactory.safeObject(Map.of("evidenceIds", List.of(id))).get("evidenceIds"));
        assertEquals("sensitive_trip_input_blocked", assertThrows(TravelError.class, () -> TripStateFactory.safeObject(Map.of("note", id))).code());
        assertEquals("sensitive_trip_input_blocked", assertThrows(TravelError.class, () -> TripStateFactory.safeObject(Map.of("resultId", "4111111111111111"))).code());
    }
}
