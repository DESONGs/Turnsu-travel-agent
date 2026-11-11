package app.travelagent.core;

import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Builds the existing unified trip contract without inventing source facts. */
public final class TripStateFactory {
    private static final List<String> DOMAINS = List.of("play", "food", "stay", "transport");
    private static final List<String> BUDGET_DOMAINS = List.of("stay", "transport", "food", "play", "other");
    private static final Set<String> FORBIDDEN_KEYS = Set.of("passport", "passportnumber", "idcard", "identitynumber",
            "passportno", "idcardnumber", "identitycard", "phone", "mobile", "phonenumber", "mobilephone",
            "creditcard", "cardnumber", "paymentdetails", "password", "cookie",
            "token", "accesstoken", "refreshtoken", "authorization", "apikey", "clientsecret", "browserprofile",
            "diagnosis", "diagnoses", "medicalhistory", "disease", "medicalrecords");
    private static final Pattern SECRET_TEXT = Pattern.compile("(?i)(?:cookie|token|authorization|password|secret|api[_ -]?key)[\\\"']?\\s*[:=]|(?:passport|证件|身份证)[\\\"']?\\s*(?:号码|号|number)?\\s*[:：]\\s*[\\\"']?[A-Za-z0-9-]{6,}|(?:phone|mobile|手机号|联系电话)[\\\"']?\\s*[:：]\\s*\\+?[0-9 ()-]{7,}|\\b1[3-9]\\d{9}\\b");
    private static final Pattern CARD_CANDIDATE = Pattern.compile("(?<!\\d)(?:\\d[ -]?){13,19}(?!\\d)");
    private static final Pattern GENERATED_REFERENCE = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final Set<String> REFERENCE_FIELDS = Set.of("resultid", "sourceresultid", "weatherresultid", "evidenceids");
    private static final Pattern SENSITIVE_CHINESE_KEY = Pattern.compile("护照|身份证|证件号码|银行卡|信用卡|手机号|手机号码|联系电话|支付信息|浏览器配置|客户端密钥|病史|诊断|病历|证明材料");
    private static final Map<String, Map<String, String>> CARE_FIELDS = Map.of(
            "mobility", Map.of("reduceWalking", "bool", "avoidStairs", "bool", "stepFreeRequired", "bool", "wheelchairSpaceRequired", "bool",
                    "luggageAssistanceRequired", "bool", "maxContinuousWalkMeters", "50:20000", "maxTransfers", "0:8"),
            "stamina", Map.of("needsFrequentRest", "bool", "restEveryMinutes", "10:240", "maxActiveMinutesPerBlock", "20:720"),
            "schedule", Map.of("regularMealTimes", "bool", "earliestStartTime", "time", "latestReturnTime", "time", "latestDinnerTime", "time"),
            "facilities", Map.of("accessibleToiletRequired", "bool", "toiletAccessPriority", "bool", "nursingRoomRequired", "bool", "strollerFriendlyRequired", "bool", "quietRetreatRequired", "bool"),
            "sensory", Map.of("avoidCrowds", "bool", "avoidStrongSensoryStimuli", "bool"), "food", Map.of("exclusions", "strings"));

    private TripStateFactory() {}

    public static boolean isRemovableCareField(String group, String field) {
        var fields = CARE_FIELDS.get(group);
        return fields != null && fields.containsKey(field) && !("food".equals(group) && "exclusions".equals(field));
    }

    /** Reused at other persistence boundaries; sensitive input is rejected, never silently altered. */
    public static Map<String, Object> safeObject(Map<String, Object> value) {
        if (value == null) throw new TravelError("invalid_trip_input");
        return copyObject(value, 0);
    }

    /** Replaces traveler requirements as a whole; unsupported or private fields are rejected, never dropped. */
    public static List<Map<String, Object>> travelers(List<Map<String, Object>> input) {
        if (input == null || input.size() > 12) throw new TravelError("invalid_travelers");
        var safe = (List<?>) safeObject(Map.of("travelers", input)).get("travelers");
        var result = new ArrayList<Map<String, Object>>();
        var ids = new java.util.HashSet<String>();
        for (int index = 0; index < safe.size(); index++) {
            if (!(safe.get(index) instanceof Map<?, ?> traveler) || !Set.of("travelerId", "displayName", "relationship", "role", "language", "hardConstraints", "careNeeds").containsAll(traveler.keySet()))
                throw new TravelError("invalid_travelers");
            String id = bounded(traveler.get("travelerId"), 128, true);
            if (!id.matches("[A-Za-z0-9_.:-]{1,128}") || !ids.add(id)) throw new TravelError("invalid_travelers");
            String name = traveler.containsKey("displayName") ? bounded(traveler.get("displayName"), 40, true) : "同行人 " + (index + 1);
            String relation = traveler.get("relationship") == null ? null : bounded(traveler.get("relationship"), 40, true);
            String role = traveler.containsKey("role") ? bounded(traveler.get("role"), 40, true) : "traveler";
            String language = traveler.containsKey("language") ? bounded(traveler.get("language"), 24, true) : "zh-CN";
            Object hardValue = traveler.containsKey("hardConstraints") ? traveler.get("hardConstraints") : List.of();
            if (!(hardValue instanceof List<?> hard) || hard.size() > 12) throw new TravelError("invalid_traveler_constraints");
            for (Object constraint : hard) if (!(constraint instanceof Map<?, ?> item) || !item.keySet().equals(Set.of("type")) || !"foreign_guest_required".equals(item.get("type")))
                throw new TravelError("unsupported_traveler_constraint");
            Object careValue = traveler.containsKey("careNeeds") ? traveler.get("careNeeds") : Map.of();
            if (!(careValue instanceof Map<?, ?> care) || !CARE_FIELDS.keySet().containsAll(care.keySet())) throw new TravelError("invalid_traveler_constraints");
            for (var group : care.entrySet()) {
                var fields = CARE_FIELDS.get(group.getKey());
                if (!(group.getValue() instanceof Map<?, ?> values) || !fields.keySet().containsAll(values.keySet())) throw new TravelError("invalid_traveler_constraints");
                for (var field : values.entrySet()) validateCareValue(fields.get(field.getKey()), field.getValue());
            }
            var record = new LinkedHashMap<String, Object>();
            record.put("travelerId", id); record.put("displayName", name); record.put("relationship", relation); record.put("role", role);
            record.put("language", language); record.put("hardConstraints", hard); record.put("softPreferences", List.of()); record.put("careNeeds", care); record.put("operability", Map.of());
            result.add(record);
        }
        return result;
    }

    private static void validateCareValue(String kind, Object value) {
        if ("bool".equals(kind)) { if (!(value instanceof Boolean)) throw new TravelError("invalid_traveler_constraints"); return; }
        if ("time".equals(kind)) { if (!(value instanceof String text) || !text.matches("(?:[01]\\d|2[0-3]):[0-5]\\d")) throw new TravelError("invalid_traveler_constraints"); return; }
        if ("strings".equals(kind)) {
            if (!(value instanceof List<?> items) || items.size() > 12 || items.stream().anyMatch(item -> !(item instanceof String text) || text.isBlank() || text.length() > 80)) throw new TravelError("invalid_traveler_constraints");
            return;
        }
        if (kind == null || !(value instanceof Number number) || number.doubleValue() != number.intValue()) throw new TravelError("invalid_traveler_constraints");
        var range = kind.split(":"); int actual = number.intValue();
        if (actual < Integer.parseInt(range[0]) || actual > Integer.parseInt(range[1])) throw new TravelError("invalid_traveler_constraints");
    }
    private static String bounded(Object value, int maximum, boolean nonblank) {
        if (!(value instanceof String text) || text.length() > maximum || (nonblank && text.isBlank())) throw new TravelError("invalid_travelers");
        return text.trim();
    }

    public static Map<String, Object> create(String tripId, Map<String, Object> brief, Instant timestamp) {
        if (tripId == null || !tripId.matches("[A-Za-z0-9_.:-]{1,128}") || timestamp == null) {
            throw new TravelError("invalid_trip_input");
        }
        var safeBrief = brief == null ? new LinkedHashMap<String, Object>() : copyObject(brief, 0);
        validateBrief(safeBrief);
        var at = timestamp.toString();
        var queues = new LinkedHashMap<String, Object>();
        var decisions = new ArrayList<Map<String, Object>>();
        for (var domain : DOMAINS) {
            queues.put(domain, new ArrayList<>());
            decisions.add(Map.of("decisionId", "decision_" + domain, "domain", domain, "status", "open",
                    "candidateNodeIds", List.of(), "selectedNodeIds", List.of()));
        }
        var budgetDomains = new LinkedHashMap<String, Object>();
        for (var domain : BUDGET_DOMAINS) {
            budgetDomains.put(domain, Map.of("committed", 0, "estimated", 0, "quality", "unknown", "basis", List.of(), "unknownCount", 0));
        }
        var budget = new LinkedHashMap<String, Object>();
        var country = safeBrief.get("countryCode");
        budget.put("currency", safeBrief.getOrDefault("currency", "CN".equals(country) ? "CNY" : "XXX"));
        budget.put("totalBudget", safeBrief.get("totalBudget"));
        budget.put("domains", budgetDomains);
        budget.put("committed", 0);
        budget.put("estimated", 0);
        budget.put("exceedsBudget", false);
        var environment = new LinkedHashMap<String, Object>();
        environment.put("weather", null);
        environment.put("mobility", null);
        environment.put("updatedAt", null);
        var readiness = new LinkedHashMap<String, Object>();
        readiness.put("schemaVersion", "trip-readiness-state-v1");
        readiness.put("version", 0);
        readiness.put("signals", Map.of("travel_documents", "unknown", "mobile_access", "unknown",
                "cashless_access", "unknown", "china_account_continuity", "unknown"));
        readiness.put("updatedAt", null);
        var state = new LinkedHashMap<String, Object>();
        state.put("schemaVersion", "trip-control-state-v1");
        state.put("tripId", tripId);
        state.put("revision", 0);
        state.put("storageVersion", 0);
        state.put("activeBranchId", "main");
        state.put("brief", safeBrief);
        state.put("travelers", List.of());
        state.put("confirmedTransport", List.of());
        state.put("transportOverlaps", List.of());
        state.put("nodes", List.of());
        state.put("edges", List.of());
        state.put("taskQueues", queues);
        state.put("openDecisions", decisions);
        state.put("dirtySet", List.of());
        state.put("budgetLedger", budget);
        state.put("environment", environment);
        state.put("readiness", readiness);
        state.put("fulfillmentLedger", List.of());
        state.put("evidence", Map.of("contentItems", List.of(), "claims", List.of(), "entities", List.of()));
        for (var key : List.of("pendingProposals", "proposalHistory", "feedbackLedger", "fulfillmentEvents", "changeJournal")) state.put(key, List.of());
        state.put("createdAt", at);
        state.put("updatedAt", at);
        return state;
    }

    private static void validateBrief(Map<String, Object> brief) {
        if (brief.containsKey("journeys")) validateJourneys(brief.get("journeys"));
        if (brief.containsKey("countryCode") && !(brief.get("countryCode") instanceof String code && code.matches("[A-Z]{2}"))) throw new TravelError("invalid_country_code");
        if (brief.containsKey("currency") && brief.get("currency") != null
                && !(brief.get("currency") instanceof String currency && currency.matches("[A-Z]{3}"))) throw new TravelError("invalid_currency");
        if (brief.containsKey("timeZone") && brief.get("timeZone") != null) {
            if (!(brief.get("timeZone") instanceof String zone)) throw new TravelError("invalid_time_zone");
            try { ZoneId.of(zone); } catch (Exception error) { throw new TravelError("invalid_time_zone"); }
        }
        if (brief.containsKey("totalBudget") && brief.get("totalBudget") != null) {
            if (!(brief.get("totalBudget") instanceof Number amount) || !Double.isFinite(amount.doubleValue()) || amount.doubleValue() < 0) throw new TravelError("invalid_budget");
        }
        if (brief.containsKey("durationDays")) {
            if (!(brief.get("durationDays") instanceof Number value) || value.doubleValue() != value.intValue() || value.intValue() < 1 || value.intValue() > 60) throw new TravelError("invalid_duration");
        }
    }

    /** Each requested direction is independent: a return is never inferred from an outbound leg. */
    public static void validateJourneys(Object value) {
        if (!(value instanceof List<?> journeys) || journeys.size() > 12) throw new TravelError("invalid_journeys");
        var ids = new java.util.HashSet<String>();
        for (Object raw : journeys) {
            if (!(raw instanceof Map<?, ?> journey)
                    || !Set.of("journeyId", "origin", "destination", "date", "purpose", "scope", "mode", "arriveBy").containsAll(journey.keySet())
                    || !(journey.get("journeyId") instanceof String id) || !id.matches("[A-Za-z0-9_.:-]{1,128}") || !ids.add(id)
                    || !(journey.get("origin") instanceof String origin) || origin.isBlank() || origin.length() > 120
                    || !(journey.get("destination") instanceof String destination) || destination.isBlank() || destination.length() > 120
                    || !(journey.get("date") instanceof String date) || !date.matches("20\\d{2}-\\d{2}-\\d{2}")
                    || !(journey.get("purpose") instanceof String purpose) || !Set.of("outbound", "return", "transfer", "scenic").contains(purpose)
                    || !(journey.get("scope") instanceof String scope) || !Set.of("plan", "self_arranged").contains(scope)
                    || (journey.containsKey("mode") && (!(journey.get("mode") instanceof String mode) || !Set.of("train", "flight", "flexible").contains(mode))))
                throw new TravelError("invalid_journeys");
            try { java.time.LocalDate.parse(date); }
            catch (java.time.format.DateTimeParseException invalid) { throw new TravelError("invalid_journeys"); }
            if (journey.containsKey("arriveBy")) {
                if (!(journey.get("arriveBy") instanceof String deadline) || deadline.length() > 40) throw new TravelError("invalid_journeys");
                try { java.time.OffsetDateTime.parse(deadline); }
                catch (java.time.format.DateTimeParseException invalid) { throw new TravelError("invalid_journeys"); }
            }
        }
    }

    private static LinkedHashMap<String, Object> copyObject(Map<?, ?> source, int depth) {
        if (depth > 12 || source.size() > 128) throw new TravelError("invalid_trip_input");
        var result = new LinkedHashMap<String, Object>();
        for (var entry : source.entrySet()) {
            if (!(entry.getKey() instanceof String key) || key.length() > 128) throw new TravelError("invalid_trip_input");
            var normalized = key.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
            if (FORBIDDEN_KEYS.contains(normalized) || SENSITIVE_CHINESE_KEY.matcher(key).find()) throw new TravelError("sensitive_trip_input_blocked");
            result.put(key, copyValue(entry.getValue(), depth + 1, REFERENCE_FIELDS.contains(normalized)));
        }
        return result;
    }

    private static Object copyValue(Object value, int depth, boolean referenceField) {
        if (depth > 12) throw new TravelError("invalid_trip_input");
        if (value == null || value instanceof Boolean) return value;
        if (value instanceof Number number) {
            if (!Double.isFinite(number.doubleValue())) throw new TravelError("invalid_trip_input");
            return number;
        }
        if (value instanceof String text) {
            if (text.length() > 12_000) throw new TravelError("invalid_trip_input");
            // Typed result references are generated UUIDs, not card numbers; callers still check their existence and access.
            boolean generatedReference = referenceField && GENERATED_REFERENCE.matcher(text).matches();
            if (SECRET_TEXT.matcher(text).find() || (!generatedReference && containsCardNumber(text))) throw new TravelError("sensitive_trip_input_blocked");
            return text;
        }
        if (value instanceof Map<?, ?> map) return copyObject(map, depth);
        if (value instanceof List<?> list) {
            if (list.size() > 128) throw new TravelError("invalid_trip_input");
            return list.stream().map(item -> copyValue(item, depth + 1, referenceField)).toList();
        }
        throw new TravelError("invalid_trip_input");
    }

    private static boolean containsCardNumber(String text) {
        var matcher = CARD_CANDIDATE.matcher(text);
        while (matcher.find()) {
            var digits = matcher.group().replaceAll("\\D", "");
            if (digits.length() < 13 || digits.length() > 19) continue;
            int total = 0;
            boolean doubled = false;
            for (int i = digits.length() - 1; i >= 0; i--) {
                int digit = digits.charAt(i) - '0';
                if (doubled && (digit *= 2) > 9) digit -= 9;
                total += digit;
                doubled = !doubled;
            }
            if (total % 10 == 0) return true;
        }
        return false;
    }
}
