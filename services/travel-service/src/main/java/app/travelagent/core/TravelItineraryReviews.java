package app.travelagent.core;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** Private, per-account review progress shared by every authenticated workbench for the same trip. */
@Service
public class TravelItineraryReviews {
    private static final TypeReference<Map<String,Object>> OBJECT=new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final TravelItineraryDrafts drafts;
    private final JsonMapper json=JsonMapper.builder().build();
    public TravelItineraryReviews(JdbcTemplate jdbc, TransactionTemplate transactions, TravelItineraryDrafts drafts) {
        this.jdbc=jdbc;this.transactions=transactions;this.drafts=drafts;
    }

    public Map<String,Object> read(UUID actor, UUID trip, UUID draft, long expectedRevision, long expectedDraftRevision) {
        return transactions.execute(status -> {
            var report=new LinkedHashMap<>(drafts.verify(actor,trip,draft,expectedRevision,expectedDraftRevision));
            report.put("reviewState",progress(actor,trip,report));
            return report;
        });
    }

    public Map<String,Object> saveCondition(UUID actor, UUID trip, UUID draft, long expectedRevision, long expectedDraftRevision,
                                            long expectedReviewRevision, String checkId, String basisDigest, boolean acknowledged, String requestId) {
        if(actor==null || trip==null || draft==null || expectedRevision<0 || expectedDraftRevision<0 || expectedReviewRevision<0
                || checkId==null || !checkId.matches("[A-Za-z0-9_.:-]{1,300}") || basisDigest==null || !basisDigest.matches("[0-9a-f]{64}"))
            throw new TravelError("invalid_review_condition");
        if(requestId==null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String fingerprint=TravelItineraryAdoptions.digest(List.of(trip.toString(),draft.toString(),expectedRevision,expectedDraftRevision,
                expectedReviewRevision,checkId,basisDigest,acknowledged));
        return transactions.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?,0))",rs -> {},actor+":"+requestId);
            lockEditor(actor,trip);
            var receipts=jdbc.query("SELECT command_type,input_hash FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs,n)->List.of(rs.getString(1),rs.getString(2)),actor,requestId);
            if(!receipts.isEmpty()) {
                if(!List.of("save_itinerary_review_condition",fingerprint).equals(receipts.get(0))) throw new TravelError("request_id_conflict");
                return read(actor,trip,draft,expectedRevision,expectedDraftRevision);
            }
            var report=drafts.verify(actor,trip,draft,expectedRevision,expectedDraftRevision);
            var check=checks(report).stream().filter(item -> checkId.equals(item.get("id")) && item.containsKey("basisDigest")).findFirst()
                    .orElseThrow(() -> new TravelError("review_condition_not_required"));
            if(!basisDigest.equals(check.get("basisDigest"))) throw new TravelError("review_condition_changed");
            var saved=stored(actor,trip);
            if(((Number)saved.get("revision")).longValue()!=expectedReviewRevision) throw new TravelError("review_revision_conflict");
            @SuppressWarnings("unchecked") var prior=(Map<String,Object>)saved.get("acknowledgments");
            var next=new LinkedHashMap<>(prior);
            var currentIds=new HashSet<>(checks(report).stream().filter(item -> item.containsKey("basisDigest")).map(item -> item.get("id")).toList());
            next.keySet().removeIf(id -> !currentIds.contains(id));
            if(acknowledged) {
                if(!(next.get(checkId) instanceof Map<?,?> value) || !basisDigest.equals(value.get("basisDigest")))
                    next.put(checkId,Map.of("basisDigest",basisDigest,"acknowledgedAt",Instant.now().toString()));
            } else next.remove(checkId);
            if(!next.equals(prior)) jdbc.update("""
                    INSERT INTO travel_itinerary_reviews(trip_id,account_id,revision,acknowledgments) VALUES (?,?,?,CAST(? AS jsonb))
                    ON CONFLICT(trip_id,account_id) DO UPDATE SET revision=EXCLUDED.revision,acknowledgments=EXCLUDED.acknowledgments,updated_at=CURRENT_TIMESTAMP
                    """,trip,actor,expectedReviewRevision+1,json.writeValueAsString(next));
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?,?,CAST(? AS jsonb))",
                    actor,requestId,"save_itinerary_review_condition",fingerprint,json.writeValueAsString(Map.of("tripId",trip.toString(),"draftId",draft.toString())));
            return read(actor,trip,draft,expectedRevision,expectedDraftRevision);
        });
    }

    /** Called under the adoption transaction's trip lock; another account's decisions cannot authorize this adoption. */
    List<Map<String,Object>> requireComplete(UUID actor, UUID trip, Map<String,Object> report) {
        var progress=progress(actor,trip,report);
        if(!((List<?>)progress.get("pendingCheckIds")).isEmpty()) throw new TravelError("adoption_acknowledgments_not_saved");
        @SuppressWarnings("unchecked") var saved=(Map<String,Object>)stored(actor,trip).get("acknowledgments");
        var records=new ArrayList<Map<String,Object>>();
        for(Object id:(List<?>)report.get("requiredAcknowledgments")) {
            @SuppressWarnings("unchecked") var record=new LinkedHashMap<>((Map<String,Object>)saved.get(id));
            record.put("checkId",id);records.add(record);
        }
        return records;
    }

    private Map<String,Object> progress(UUID actor, UUID trip, Map<String,Object> report) {
        var saved=stored(actor,trip);
        @SuppressWarnings("unchecked") var records=(Map<String,Object>)saved.get("acknowledgments");
        var acknowledged=new ArrayList<String>();var pending=new ArrayList<String>();var changed=new ArrayList<String>();
        for(var check:checks(report)) if(check.get("basisDigest") instanceof String basis) {
            String id=(String)check.get("id");Object record=records.get(id);
            if(record instanceof Map<?,?> value && basis.equals(value.get("basisDigest"))) acknowledged.add(id);
            else {pending.add(id);if(record!=null)changed.add(id);}
        }
        return Map.of("revision",saved.get("revision"),"acknowledgedCheckIds",acknowledged,"pendingCheckIds",pending,"changedCheckIds",changed);
    }
    private Map<String,Object> stored(UUID actor, UUID trip) {
        var rows=jdbc.query("SELECT revision,acknowledgments::text FROM travel_itinerary_reviews WHERE trip_id=? AND account_id=?",
                (rs,n)->Map.<String,Object>of("revision",rs.getLong(1),"acknowledgments",json.readValue(rs.getString(2),OBJECT)),trip,actor);
        return rows.isEmpty()?Map.of("revision",0L,"acknowledgments",Map.of()):rows.get(0);
    }
    @SuppressWarnings("unchecked") private static List<Map<String,Object>> checks(Map<String,Object> report) {return (List<Map<String,Object>>)report.get("checks");}
    private void lockEditor(UUID actor, UUID trip) {
        var trips=jdbc.query("SELECT trip_id FROM travel_trips WHERE trip_id=? FOR UPDATE",(rs,n)->rs.getObject(1),trip);
        var roles=jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?",(rs,n)->rs.getString(1),trip,actor);
        if(trips.isEmpty() || roles.isEmpty() || !List.of("owner","editor").contains(roles.get(0))) throw new TravelError("trip_not_found");
    }
}
