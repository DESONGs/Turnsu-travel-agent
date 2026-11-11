package app.travelagent.core;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;

/** Resolve an explicitly supplied local time without guessing a time zone or DST offset. */
final class TripTime {
    private TripTime() {}

    static Map<String, Object> resolve(Object localValue, Object zoneValue, Object offsetValue) {
        if (!(zoneValue instanceof String zoneText) || !ZoneId.getAvailableZoneIds().contains(zoneText)) throw new TravelError("invalid_time_zone");
        LocalDateTime local;
        try {
            if (!(localValue instanceof String text)) throw new IllegalArgumentException();
            local = LocalDateTime.parse(text);
        } catch (RuntimeException invalid) { throw new TravelError("invalid_local_time"); }
        var offsets = ZoneId.of(zoneText).getRules().getValidOffsets(local);
        if (offsets.isEmpty()) throw new TravelError("nonexistent_local_time");
        ZoneOffset offset;
        if (offsetValue == null) {
            if (offsets.size() != 1) throw new TravelError("ambiguous_local_time");
            offset = offsets.get(0);
        } else {
            try {
                if (!(offsetValue instanceof String text)) throw new IllegalArgumentException();
                offset = ZoneOffset.of(text);
            } catch (RuntimeException invalid) { throw new TravelError("invalid_utc_offset"); }
            if (!offsets.contains(offset)) throw new TravelError("invalid_utc_offset");
        }
        return Map.of("local", local.toString(), "timeZone", zoneText, "utcOffset", offset.toString(), "instant", local.toInstant(offset).toString());
    }
}
