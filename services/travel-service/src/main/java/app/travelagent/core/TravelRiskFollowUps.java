package app.travelagent.core;

import app.travelagent.provider.AmapWeatherClient;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** Checks facts independently of planning workers. Unsupported sources remain visible coverage gaps. */
@Service
public class TravelRiskFollowUps {
    private static final TypeReference<Map<String,Object>> OBJECT=new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final TravelResults results;
    private final AmapWeatherClient weather;
    private final boolean scheduled;
    private final JsonMapper json=JsonMapper.builder().build();
    public TravelRiskFollowUps(JdbcTemplate jdbc, TransactionTemplate transactions, TravelResults results, AmapWeatherClient weather,
                              @Value("${TRAVEL_FOLLOW_UP_SCHEDULER_ENABLED:true}") boolean scheduled) {
        this.jdbc=jdbc; this.transactions=transactions; this.results=results; this.weather=weather; this.scheduled=scheduled;
    }
    void enroll(UUID trip, UUID adoption, UUID actor, long revision, Instant stopsAt) {
        jdbc.update("INSERT INTO travel_risk_follow_ups(trip_id,adoption_id,trip_revision,enabled_by,enabled,stops_at,next_check_at) VALUES (?,?,?,?,true,?,CURRENT_TIMESTAMP)",
                trip,adoption,revision,actor,Timestamp.from(stopsAt));
    }
    public Map<String,Object> read(UUID actor, UUID trip, Long beforeEventId) {
        return transactions.execute(status -> {
            authorize(actor,trip,false);
            var rows=jdbc.query("SELECT adoption_id,enabled,revision,stops_at,next_check_at,weather::text FROM travel_risk_follow_ups WHERE trip_id=?",
                    (rs,n)->{
                        var item=new LinkedHashMap<String,Object>(); item.put("adoptionId",rs.getObject(1,UUID.class).toString()); item.put("enabled",rs.getBoolean(2));
                        item.put("revision",rs.getLong(3)); item.put("stopsAt",rs.getTimestamp(4).toInstant().toString());
                        item.put("nextCheckAt",rs.getTimestamp(5)==null ? null : rs.getTimestamp(5).toInstant().toString());
                        var coverage=json.readValue(rs.getString(6),OBJECT); coverage.remove("baselineHash"); coverage.remove("baselineUntil");
                        item.put("weather",coverage); return item;
                    },trip);
            if(rows.isEmpty()) throw new TravelError("follow_up_not_found");
            var item=rows.get(0);
            if (!Instant.parse((String)item.get("stopsAt")).isAfter(Instant.now())) { item.put("enabled",false); item.put("nextCheckAt",null); item.put("ended",true); }
            item.put("coverageGaps",List.of("weather_destination_only","flight_status","transport_connections","opening_and_reservations"));
            var events=jdbc.query("SELECT event_id,kind,result_id,created_at FROM travel_risk_changes WHERE trip_id=? AND (CAST(? AS bigint) IS NULL OR event_id < ?) ORDER BY event_id DESC LIMIT 21",
                    (rs,n)->Map.<String,Object>of("eventId",rs.getLong(1),"kind",rs.getString(2),"resultId",rs.getObject(3,UUID.class).toString(),"createdAt",rs.getTimestamp(4).toInstant().toString()),
                    trip,beforeEventId,beforeEventId);
            item.put("events",events.size()>20 ? events.subList(0,20) : events);
            item.put("nextEventCursor",events.size()>20 ? events.get(19).get("eventId") : null);
            return item;
        });
    }
    public Map<String,Object> setEnabled(UUID actor, UUID trip, long expectedTripRevision, long expectedFollowUpRevision, boolean enabled, String requestId) {
        if(requestId==null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String fingerprint=TravelItineraryAdoptions.digest(List.of(trip.toString(),expectedTripRevision,expectedFollowUpRevision,enabled));
        return transactions.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",rs->{},actor+":"+requestId);
            long revision=authorize(actor,trip,true);
            var receipts=jdbc.query("SELECT command_type,input_hash FROM travel_command_receipts WHERE account_id=? AND request_id=?",(rs,n)->List.of(rs.getString(1),rs.getString(2)),actor,requestId);
            if(!receipts.isEmpty()) {
                if(!receipts.get(0).equals(List.of("set_trip_follow_up",fingerprint))) throw new TravelError("request_id_conflict");
                return read(actor,trip,null);
            }
            if(revision!=expectedTripRevision) throw new TravelError("revision_conflict");
            var rows=jdbc.query("SELECT revision,stops_at FROM travel_risk_follow_ups WHERE trip_id=? FOR UPDATE",(rs,n)->Map.of("revision",rs.getLong(1),"stopsAt",rs.getTimestamp(2).toInstant()),trip);
            if(rows.isEmpty()) throw new TravelError("follow_up_not_found");
            if(((Number)rows.get(0).get("revision")).longValue()!=expectedFollowUpRevision) throw new TravelError("follow_up_revision_conflict");
            if(enabled && !((Instant)rows.get(0).get("stopsAt")).isAfter(Instant.now())) throw new TravelError("trip_already_ended");
            jdbc.update("UPDATE travel_risk_follow_ups SET enabled=?,enabled_by=?,revision=revision+1,lease_id=NULL,lease_until=NULL,next_check_at=?,updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                    enabled,actor,enabled ? Timestamp.from(Instant.now()) : null,trip);
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?,?,'{}'::jsonb)",actor,requestId,"set_trip_follow_up",fingerprint);
            return read(actor,trip,null);
        });
    }
    @Scheduled(initialDelay=5000,fixedDelay=5000)
    public void schedule() { if(scheduled) checkDue(); }

    public void checkDue() {
        var due=jdbc.query("SELECT trip_id FROM travel_risk_follow_ups WHERE enabled AND (next_check_at<=CURRENT_TIMESTAMP OR stops_at<=CURRENT_TIMESTAMP) AND (lease_until IS NULL OR lease_until<=CURRENT_TIMESTAMP) ORDER BY next_check_at LIMIT 4",
                (rs,n)->rs.getObject(1,UUID.class));
        for(UUID trip:due) {
            var claim=transactions.execute(status -> claim(trip));
            if(claim==null) continue;
            Map<String,Object> response;
            try { response=weather.forecast(claim.brief()).block(Duration.ofSeconds(30)); }
            catch(RuntimeException failure) { response=Map.of("status","provider_unavailable","reason","weather_check_failed"); }
            var value=response==null ? Map.<String,Object>of("status","provider_unavailable","reason","weather_check_failed") : response;
            if("completed".equals(value.get("status"))) {
                try { if(!Instant.parse((String)value.get("freshUntil")).isAfter(Instant.now())) value=Map.of("status","provider_unavailable","reason","weather_source_expired"); }
                catch(RuntimeException invalid) { value=Map.of("status","provider_unavailable","reason","weather_source_invalid"); }
            }
            var checked=value;
            try { transactions.executeWithoutResult(status -> finish(claim,checked)); }
            catch(TravelError invalid) { transactions.executeWithoutResult(status -> finish(claim,Map.of("status","provider_unavailable","reason","weather_source_invalid"))); }
        }
    }
    private record Claim(UUID trip,UUID actor,UUID adoption,long revision,UUID lease,Map<String,Object> brief) {}
    private Claim claim(UUID trip) {
        var trips=jdbc.query("SELECT revision,state::text FROM travel_trips WHERE trip_id=? FOR UPDATE",(rs,n)->Map.<String,Object>of("revision",rs.getLong(1),"state",json.readValue(rs.getString(2),OBJECT)),trip);
        if(trips.isEmpty()) return null;
        var rows=jdbc.query("SELECT enabled_by,adoption_id,trip_revision,stops_at FROM travel_risk_follow_ups WHERE trip_id=? AND enabled AND (next_check_at<=CURRENT_TIMESTAMP OR stops_at<=CURRENT_TIMESTAMP) AND (lease_until IS NULL OR lease_until<=CURRENT_TIMESTAMP) FOR UPDATE",
                (rs,n)->Map.<String,Object>of("actor",rs.getObject(1,UUID.class),"adoption",rs.getObject(2,UUID.class),"revision",rs.getLong(3),"stopsAt",rs.getTimestamp(4).toInstant()),trip);
        if(rows.isEmpty()) return null;
        var plan=rows.get(0); UUID actor=(UUID)plan.get("actor");
        String stop=null;
        if(!((Instant)plan.get("stopsAt")).isAfter(Instant.now())) stop="ended";
        else if(!canEdit(actor,trip)) stop="authorization_lost";
        else if(!plan.get("revision").equals(trips.get(0).get("revision"))) stop="trip_changed";
        @SuppressWarnings("unchecked") var state=(Map<String,Object>)trips.get(0).get("state");
        if("cancelled".equals(state.get("status"))) stop="cancelled";
        if(stop!=null) { stop(trip,stop); return null; }
        UUID lease=UUID.randomUUID();
        jdbc.update("UPDATE travel_risk_follow_ups SET lease_id=?,lease_until=CURRENT_TIMESTAMP+INTERVAL '90 seconds' WHERE trip_id=?",lease,trip);
        @SuppressWarnings("unchecked") var brief=(Map<String,Object>)state.get("brief");
        return new Claim(trip,actor,(UUID)plan.get("adoption"),((Number)plan.get("revision")).longValue(),lease,brief);
    }
    private void finish(Claim claim,Map<String,Object> result) {
        var revisions=jdbc.query("SELECT revision FROM travel_trips WHERE trip_id=? FOR UPDATE",(rs,n)->rs.getLong(1),claim.trip());
        var rows=jdbc.query("SELECT weather::text,stops_at FROM travel_risk_follow_ups WHERE trip_id=? AND enabled AND adoption_id=? AND lease_id=? AND lease_until>CURRENT_TIMESTAMP FOR UPDATE",
                (rs,n)->Map.<String,Object>of("weather",json.readValue(rs.getString(1),OBJECT),"stopsAt",rs.getTimestamp(2).toInstant()),claim.trip(),claim.adoption(),claim.lease());
        if(rows.isEmpty()) return;
        if(revisions.isEmpty() || revisions.get(0)!=claim.revision() || !canEdit(claim.actor(),claim.trip())) { stop(claim.trip(),"authorization_lost_or_trip_changed"); return; }
        Instant now=Instant.now(),end=(Instant)rows.get(0).get("stopsAt");
        if(!end.isAfter(now)) { stop(claim.trip(),"ended"); return; }
        @SuppressWarnings("unchecked") var previous=(Map<String,Object>)rows.get(0).get("weather");
        var view=new LinkedHashMap<>(previous); view.put("lastAttemptAt",now.toString());
        String status=String.valueOf(result.get("status"));
        if("completed".equals(status)) {
            String coverage=String.valueOf(result.get("coverage"));
            var saved=results.saveWeather(claim.actor(),claim.trip(),claim.revision(),result);
            view.put("resultId",saved.get("resultId")); view.put("coverage",coverage);
            if(List.of("covered","partial").contains(coverage) && result.get("forecastDays") instanceof List<?> days && result.get("requestedDates") instanceof List<?> requested && !requested.isEmpty()) {
                var relevant=days.stream().filter(value -> value instanceof Map<?,?> day && requested.contains(day.get("date"))).sorted(java.util.Comparator.comparing(value -> String.valueOf(((Map<?,?>)value).get("date")))).toList();
                if(relevant.isEmpty()) status="outside_forecast_window";
                else {
                    String signature=TravelItineraryAdoptions.digest(Map.of("requestedDates",requested,"days",relevant));
                    boolean continuous=previous.get("baselineUntil") instanceof String until && Instant.parse(until).isAfter(now);
                    boolean changed=continuous && previous.get("baselineHash") instanceof String old && !old.equals(signature);
                    status=changed ? "changed" : continuous ? "no_change" : "baseline_saved";
                    if(changed) jdbc.update("INSERT INTO travel_risk_changes(trip_id,adoption_id,kind,result_id) VALUES (?,?,'weather_changed',?)",claim.trip(),claim.adoption(),UUID.fromString((String)saved.get("resultId")));
                    view.put("baselineHash",signature); view.put("baselineUntil",saved.get("freshUntil")); view.put("lastSuccessAt",now.toString());
                }
            } else status=coverage;
        }
        view.put("status",status);
        if(!"completed".equals(result.get("status"))) view.put("reason",result.getOrDefault("reason",status)); else view.remove("reason");
        Instant next=now.plusSeconds(3600); if(next.isAfter(end)) next=end;
        jdbc.update("UPDATE travel_risk_follow_ups SET weather=CAST(? AS jsonb),next_check_at=?,lease_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND lease_id=?",
                json.writeValueAsString(view),Timestamp.from(next),claim.trip(),claim.lease());
    }
    private void stop(UUID trip,String reason) {
        jdbc.update("UPDATE travel_risk_follow_ups SET enabled=false,revision=revision+1,next_check_at=NULL,lease_id=NULL,lease_until=NULL,weather=weather || CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",
                json.writeValueAsString(Map.of("status",reason)),trip);
    }
    private long authorize(UUID actor,UUID trip,boolean write) {
        var revision=jdbc.query("SELECT revision FROM travel_trips WHERE trip_id=? FOR UPDATE",(rs,n)->rs.getLong(1),trip);
        var access=jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?",(rs,n)->rs.getString(1),trip,actor);
        if(revision.isEmpty() || access.isEmpty() || write && !List.of("owner","editor").contains(access.get(0))) throw new TravelError("trip_not_found");
        return revision.get(0);
    }
    private boolean canEdit(UUID actor,UUID trip) {
        return Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM travel_trip_access WHERE trip_id=? AND account_id=? AND role IN ('owner','editor'))",Boolean.class,trip,actor));
    }
}
