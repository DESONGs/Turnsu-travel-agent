package app.travelagent.core;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** Human acknowledgment accepts uncertainty; it never changes a failed check into a verified fact. */
@Service
public class TravelItineraryAdoptions {
    private static final TypeReference<Map<String,Object>> OBJECT = new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final TravelItineraryDrafts drafts;
    private final TravelTrips trips;
    private final TravelRiskFollowUps followUps;
    private final TravelItineraryReviews reviews;
    private final JsonMapper json = JsonMapper.builder().build();
    public TravelItineraryAdoptions(JdbcTemplate jdbc, TransactionTemplate transactions, TravelItineraryDrafts drafts, TravelTrips trips, TravelRiskFollowUps followUps, TravelItineraryReviews reviews) {
        this.jdbc=jdbc; this.transactions=transactions; this.drafts=drafts; this.trips=trips; this.followUps=followUps; this.reviews=reviews;
    }
    public Map<String,Object> adoptTentative(UUID actor, UUID trip, UUID draft, long expectedRevision, long expectedDraftRevision,
                                            String reviewDigest, List<String> acknowledgments, boolean riskConsent, String requestId) {
        if (actor==null || trip==null || draft==null || expectedRevision<0 || expectedDraftRevision<0 || reviewDigest==null || !reviewDigest.matches("[0-9a-f]{64}")
                || acknowledgments==null || acknowledgments.size()>1024 || acknowledgments.stream().anyMatch(id -> id==null || id.length()>300)
                || new HashSet<>(acknowledgments).size()!=acknowledgments.size()) throw new TravelError("invalid_adoption_review");
        if (requestId==null || !requestId.matches("[A-Za-z0-9_.:-]{1,128}")) throw new TravelError("invalid_request_id");
        String fingerprint = digest(Map.of("trip",trip.toString(),"draft",draft.toString(),"revision",expectedRevision,"draftRevision",expectedDraftRevision,
                "review",reviewDigest,"acknowledgments",acknowledgments.stream().sorted().toList(),"riskConsent",riskConsent));
        return transactions.execute(status -> {
            jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", rs -> {},actor+":"+requestId);
            var current = lockEditor(actor,trip);
            var receipts=jdbc.query("SELECT command_type,input_hash FROM travel_command_receipts WHERE account_id=? AND request_id=?",
                    (rs,n)->List.of(rs.getString(1),rs.getString(2)),actor,requestId);
            if (!receipts.isEmpty()) {
                if (!List.of("adopt_tentative_itinerary",fingerprint).equals(receipts.get(0))) throw new TravelError("request_id_conflict");
                return trips.get(actor,trip);
            }
            if (((Number)current.get("revision")).longValue()!=expectedRevision) throw new TravelError("revision_conflict");
            @SuppressWarnings("unchecked") var state = (Map<String,Object>)current.get("state");
            if (state.get("planning")!=null || nonempty(state.get("nodes")) || nonempty(state.get("pendingProposals"))) throw new TravelError("adoption_needs_impact_review");
            var report=drafts.verify(actor,trip,draft,expectedRevision,expectedDraftRevision);
            if (!Boolean.TRUE.equals(report.get("canAdoptTentatively"))) throw new TravelError("adoption_blocked");
            if (!reviewDigest.equals(report.get("reviewDigest"))) throw new TravelError("adoption_review_changed");
            var required=(List<?>)report.get("requiredAcknowledgments");
            if (!new HashSet<>(required).equals(new HashSet<>(acknowledgments))) throw new TravelError("adoption_acknowledgments_required");
            if (!riskConsent) throw new TravelError("risk_follow_up_consent_required");
            var savedAcknowledgments=reviews.requireComplete(actor,trip,report);
            var saved=drafts.get(actor,trip,draft);
            @SuppressWarnings("unchecked") var stops=(List<Map<String,Object>>)((Map<?,?>)saved.get("draft")).get("stops");
            Instant now=Instant.now(), stopsAt=TravelItineraryDrafts.followUpStopTime(state,stops);
            if (!stopsAt.isAfter(now)) throw new TravelError("trip_already_ended");
            UUID adoption=UUID.randomUUID(); long next=expectedRevision+1;
            var adopted=new LinkedHashMap<String,Object>();
            adopted.put("adoptionId",adoption.toString()); adopted.put("status","tentative"); adopted.put("draftId",draft.toString());
            adopted.put("draftRevision",expectedDraftRevision); adopted.put("sourceTripRevision",expectedRevision); adopted.put("adoptedAt",now.toString());
            adopted.put("adoptedBy",actor.toString()); adopted.put("stops",stops); adopted.put("checks",report.get("checks"));
            adopted.put("acknowledgedCheckIds",acknowledgments); adopted.put("reviewDigest",reviewDigest); adopted.put("readSet",report.get("readSet"));
            adopted.put("acknowledgmentRecords",savedAcknowledgments);
            adopted.put("riskFollowUpStopsAt",stopsAt.toString());
            state.put("planning",Map.of("adopted",adopted)); state.put("revision",next); state.put("storageVersion",next); state.put("updatedAt",now.toString());
            var journal=new ArrayList<Object>(state.get("changeJournal") instanceof List<?> items ? items : List.of());
            journal.add(Map.of("kind","tentative_itinerary_adopted","adoptionId",adoption.toString(),"at",now.toString(),"revision",next)); state.put("changeJournal",journal);
            jdbc.update("UPDATE travel_trips SET revision=?,state=CAST(? AS jsonb),updated_at=CURRENT_TIMESTAMP WHERE trip_id=?",next,json.writeValueAsString(state),trip);
            jdbc.update("UPDATE travel_itinerary_drafts SET status='adopted',updated_at=CURRENT_TIMESTAMP WHERE draft_id=?",draft);
            jdbc.update("UPDATE travel_workbench_requests SET work_status='superseded',updated_at=CURRENT_TIMESTAMP WHERE trip_id=? AND work_status<>'superseded'",trip);
            followUps.enroll(trip,adoption,actor,next,stopsAt);
            var response=trips.get(actor,trip);
            jdbc.update("INSERT INTO travel_command_receipts(account_id,request_id,command_type,input_hash,response) VALUES (?,?,?,?,CAST(? AS jsonb))",
                    actor,requestId,"adopt_tentative_itinerary",fingerprint,json.writeValueAsString(Map.of("tripId",trip.toString(),"adoptionId",adoption.toString())));
            return response;
        });
    }
    private Map<String,Object> lockEditor(UUID actor, UUID trip) {
        var locked=jdbc.query("SELECT revision,state::text FROM travel_trips WHERE trip_id=? FOR UPDATE",(rs,n)->Map.<String,Object>of("revision",rs.getLong(1),"state",json.readValue(rs.getString(2),OBJECT)),trip);
        var roles=jdbc.query("SELECT role FROM travel_trip_access WHERE trip_id=? AND account_id=?",(rs,n)->rs.getString(1),trip,actor);
        if (locked.isEmpty() || roles.isEmpty() || !List.of("owner","editor").contains(roles.get(0))) throw new TravelError("trip_not_found");
        return locked.get(0);
    }
    private static boolean nonempty(Object value) { return value instanceof List<?> items && !items.isEmpty(); }
    static String digest(Object value) {
        try { return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(JsonMapper.builder().build().writeValueAsBytes(canonical(value)))); }
        catch(java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static Object canonical(Object value) {
        if(value instanceof Map<?,?> map) { var sorted=new TreeMap<String,Object>(); map.forEach((k,v)->sorted.put((String)k,canonical(v))); return sorted; }
        if(value instanceof List<?> list) return list.stream().map(TravelItineraryAdoptions::canonical).toList();
        return value;
    }
}
