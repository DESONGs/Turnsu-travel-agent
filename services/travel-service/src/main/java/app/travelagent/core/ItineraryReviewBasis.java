package app.travelagent.core;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Bind each human acknowledgment to the facts that condition actually reads, independently of trip/layout revisions. */
final class ItineraryReviewBasis {
    private ItineraryReviewBasis() {}

    static List<Map<String,Object>> bind(List<Map<String,Object>> checks, List<Map<String,Object>> stops,
                                         Map<String,Object> state, Map<String,Map<String,Object>> references) {
        return checks.stream().map(check -> {
            if (!List.of("unverified","needs_review").contains(check.get("status"))) return check;
            String id=(String)check.get("id");
            var bound=new LinkedHashMap<>(check);
            bound.put("basisDigest",TravelItineraryAdoptions.digest(List.of("travel-review-basis-v1",id,check.get("status"),dependencies(id,stops,state,references))));
            return (Map<String,Object>)bound;
        }).toList();
    }

    private static Object dependencies(String id, List<Map<String,Object>> stops, Map<String,Object> state,
                                        Map<String,Map<String,Object>> references) {
        for(String kind:List.of("time_zone_source","opening_and_reservations","inventory_and_prices")) if(id.startsWith(kind+":")) {
            var stop=stops.stream().filter(item -> id.substring(kind.length()+1).equals(item.get("stopId"))).findFirst().orElseThrow();
            var source=sourceFacts(stop,references,kind);
            var time=pick(stop,"startLocal","timeZone","utcOffset");
            if(!kind.equals("time_zone_source")) time.putAll(pick(stop,"durationMinutes","endAt","role"));
            // Inventory can be tied to a particular slot even before a provider has returned a price.
            return List.of(source,time,kind.equals("inventory_and_prices")?party(state):List.of());
        }
        var windows=stops.stream().map(stop -> List.of(sourceFacts(stop,references,"identity"),pick(stop,"startAt","endAt","role","timeZone"))).toList();
        var transport=state.getOrDefault("confirmedTransport",List.of());
        var brief=state.get("brief") instanceof Map<?,?> value?value:Map.of();
        if(id.startsWith("traveler_constraints:")) {
            String person=id.substring("traveler_constraints:".length());
            var travelers=state.get("travelers") instanceof List<?> list?list:List.of();
            Object traveler=travelers.stream().filter(item -> item instanceof Map<?,?> value && person.equals(value.get("travelerId")))
                    .map(item -> pick((Map<?,?>)item,"travelerId","role","language","hardConstraints","careNeeds")).findFirst().orElseThrow();
            return List.of(traveler,windows,transport);
        }
        return switch(id) {
            case "recorded_transport", "transport_connections" -> List.of(windows,transport);
            case "budget" -> List.of(state.getOrDefault("budgetLedger",Map.of()),transport,party(state),
                    stops.stream().map(stop -> List.of(sourceFacts(stop,references,"inventory_and_prices"),pick(stop,"startLocal","timeZone","durationMinutes","role"))).toList());
            case "traveler_constraints" -> List.of(party(state),windows,transport);
            case "complete_trip" -> List.of(pick(brief,"destination","countryCode","dates"),stops.stream().map(stop -> List.of(stop.get("role"),
                    ((String)stop.get("startLocal")).substring(0,10),java.time.Instant.parse((String)stop.get("endAt")).atZone(java.time.ZoneId.of((String)stop.get("timeZone"))).toLocalDate().toString())).toList(),transportScope(transport));
            case "risk_follow_up_coverage" -> List.of("destination-weather-only-v1",pick(brief,"destination","countryCode","dates"),
                    TravelItineraryDrafts.followUpStopTime(state,stops).toString());
            default -> throw new IllegalStateException("Missing dependencies for itinerary review condition: "+id);
        };
    }

    private static Object transportScope(Object raw) {
        return raw instanceof List<?> list?list.stream().map(item -> {
            var fact=(Map<?,?>)item;var scope=pick(fact,"transportId","mode","origin","destination","travelerIds");
            for(String key:List.of("departure","arrival")) if(fact.get(key) instanceof Map<?,?> time && time.get("local") instanceof String local)
                scope.put(key,List.of(local.substring(0,10),time.get("timeZone")));
            return scope;
        }).toList():List.of();
    }

    private static Object party(Map<String,Object> state) {
        return state.get("travelers") instanceof List<?> list ? list.stream().map(item -> item instanceof Map<?,?> traveler
                ?pick(traveler,"travelerId","role"):Map.of()).toList():List.of();
    }
    private static Object sourceFacts(Map<String,Object> stop, Map<String,Map<String,Object>> references, String kind) {
        var reference=references.getOrDefault((String)stop.get("sourceResultId"),Map.of());
        var data=reference.get("data") instanceof Map<?,?> value?value:Map.of();
        var candidates=data.get("candidates") instanceof List<?> list?list:List.of();
        var places=candidates.stream().filter(item -> item instanceof Map<?,?> place && stop.get("sourceId").equals(place.get("sourceId")))
                .map(item -> {
                    var place=(Map<?,?>)item;
                    var facts=pick(place,"sourceId","domain","coordinates","coordinatesStatus","address","city","district");
                    if(kind.equals("time_zone_source")) facts.putAll(pick(place,"timeZone","timeZoneVerified"));
                    if(kind.equals("opening_and_reservations")) facts.putAll(pick(place,"openingHoursReference","openingVerified","reservationRequired","reservationConditions","businessStatus"));
                    if(kind.equals("inventory_and_prices")) facts.putAll(pick(place,"averageCostReference","inventoryVerified","price","currency","unit","availability","includedItems"));
                    return facts;
                }).toList();
        // Reference IDs and check times are observation metadata; identical facts from a fresh query do not erase a human decision.
        return List.of(stop.get("sourceId"),reference.getOrDefault("source","unavailable"),places);
    }
    private static LinkedHashMap<String,Object> pick(Map<?,?> input, String... keys) {
        var result=new LinkedHashMap<String,Object>();
        for(String key:keys) if(input.containsKey(key)) result.put(key,input.get(key));
        return result;
    }
}
