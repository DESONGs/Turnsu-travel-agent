package app.travelagent.core;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.*;

import app.travelagent.provider.AmapWeatherClient;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import reactor.core.publisher.Mono;

/** Real PostgreSQL and domain writes; only the external weather source is deliberately simulated. */
class TravelTentativeItineraryPostgresTest {
    static EmbeddedPostgres postgres;
    static JdbcTemplate jdbc;
    TravelAccounts accounts;
    TravelTrips trips;
    TravelResults results;
    TravelItineraryDrafts drafts;
    TravelRiskFollowUps followUps;
    TravelItineraryAdoptions adoptions;
    TravelItineraryReviews reviews;
    AmapWeatherClient weather;
    String date;
    record Seed(UUID actor,UUID trip,UUID draft,UUID source,long revision,Map<String,Object> report) {}
    @BeforeAll static void database() throws Exception {
        postgres=EmbeddedPostgres.builder().setPort(0).start(); jdbc=new JdbcTemplate(postgres.getPostgresDatabase());
        Flyway.configure().dataSource(jdbc.getDataSource()).locations("classpath:db/migration").load().migrate();
    }
    @AfterAll static void close() throws Exception { postgres.close(); }
    @BeforeEach void setup() {
        jdbc.execute("TRUNCATE travel_accounts CASCADE");
        var tx=new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        accounts=new TravelAccounts(jdbc); trips=new TravelTrips(jdbc,tx); results=new TravelResults(jdbc,tx); drafts=new TravelItineraryDrafts(jdbc,tx,results);
        weather=mock(AmapWeatherClient.class); when(weather.forecast(anyMap())).thenReturn(Mono.just(Map.of("status","provider_unavailable","reason","test_source_disabled")));
        followUps=new TravelRiskFollowUps(jdbc,tx,results,weather,false); reviews=new TravelItineraryReviews(jdbc,tx,drafts); adoptions=new TravelItineraryAdoptions(jdbc,tx,drafts,trips,followUps,reviews);
        date=LocalDate.now(ZoneId.of("Asia/Shanghai")).plusDays(1).toString();
    }
    Seed seed(boolean conflictingVisits,boolean overBudget) {
        UUID actor=accounts.fromVerifiedGoogleSubject("owner","Owner");
        UUID trip=UUID.fromString((String)trips.create(actor,"new",Map.of("destination","上海市","countryCode","CN","dates",date,"totalBudget",overBudget ? 50 : 1000,"currency","CNY")).get("tripId"));
        trips.upsertEmptyTripTraveler(actor,trip,0,"person",Map.of("travelerId","person","displayName","同行人","careNeeds",Map.of("mobility",Map.of("reduceWalking",true))));
        trips.saveConfirmedTransport(actor,trip,1,"booked",Map.of("transportId","booked","mode","train","origin","杭州","destination","上海","travelerIds",List.of("person"),
                "departure",Map.of("local",date+"T07:00","timeZone","Asia/Shanghai"),"arrival",Map.of("local",date+"T08:00","timeZone","Asia/Shanghai"),
                "price",Map.of("amount","100.00","currency","CNY","unit","total","taxes","included","coverage","segment")));
        Instant now=Instant.now();
        UUID source=UUID.fromString((String)results.savePlaces(actor,trip,2,Map.of("status","completed","provider","amap_places","coverage","page","domain","play",
                "checkedAt",now.toString(),"freshUntil",now.plusSeconds(1200).toString(),"candidates",List.of(Map.of("sourceId","museum","domain","play","name","测试地点")))).get("resultId"));
        var stops=new ArrayList<Map<String,Object>>();
        stops.add(Map.of("stopId","visit-1","sourceResultId",source.toString(),"sourceId","museum","role","activity","startLocal",date+"T10:00","timeZone","Asia/Shanghai","durationMinutes",60));
        if(conflictingVisits) stops.add(Map.of("stopId","visit-2","sourceResultId",source.toString(),"sourceId","museum","role","activity","startLocal",date+"T10:30","timeZone","Asia/Shanghai","durationMinutes",60));
        UUID draft=UUID.fromString((String)drafts.stage(actor,trip,2,"draft",stops).get("draftId"));
        return new Seed(actor,trip,draft,source,2,drafts.verify(actor,trip,draft,2,0));
    }
    @SuppressWarnings("unchecked") List<String> acknowledgments(Seed seed) { return (List<String>)seed.report().get("requiredAcknowledgments"); }
    @SuppressWarnings("unchecked") void acknowledgeAll(UUID actor, Seed seed) {
        var current=reviews.read(actor,seed.trip(),seed.draft(),seed.revision(),0);
        for(var check:(List<Map<String,Object>>)current.get("checks")) if(check.containsKey("basisDigest")) {
            long version=((Number)((Map<?,?>)current.get("reviewState")).get("revision")).longValue();
            current=reviews.saveCondition(actor,seed.trip(),seed.draft(),seed.revision(),0,version,(String)check.get("id"),(String)check.get("basisDigest"),true,"ack-"+UUID.randomUUID());
        }
    }
    Map<String,Object> adopt(Seed seed,String request) { if(((Number)trips.get(seed.actor(),seed.trip()).get("revision")).longValue()==seed.revision()) acknowledgeAll(seed.actor(),seed); return adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),seed.revision(),0,(String)seed.report().get("reviewDigest"),acknowledgments(seed),true,request); }
    @SuppressWarnings("unchecked") Map<String,Object> state(Map<String,Object> trip) { return (Map<String,Object>)trip.get("state"); }
    @SuppressWarnings("unchecked") List<String> savedIds(Map<String,Object> report) { return (List<String>)((Map<?,?>)report.get("reviewState")).get("acknowledgedCheckIds"); }
    @SuppressWarnings("unchecked") String basis(Map<String,Object> report,String id) { return (String)((List<Map<String,Object>>)report.get("checks")).stream().filter(check -> id.equals(check.get("id"))).findFirst().orElseThrow().get("basisDigest"); }
    Map<String,Object> saveCheck(UUID actor,Seed seed,Map<String,Object> report,String id,boolean value,String request) {
        return reviews.saveCondition(actor,seed.trip(),seed.draft(),((Number)report.get("tripRevision")).longValue(),((Number)report.get("draftRevision")).longValue(),
                ((Number)((Map<?,?>)report.get("reviewState")).get("revision")).longValue(),id,basis(report,id),value,request);
    }
    Map<String,Object> stop(String id,UUID source,String place,String local) {return Map.of("stopId",id,"sourceResultId",source.toString(),"sourceId",place,"role","activity","startLocal",date+local,"timeZone","Asia/Shanghai","durationMinutes",60);}
    UUID source(Seed seed,long revision,List<Map<String,Object>> candidates) {
        Instant now=Instant.now();return UUID.fromString((String)results.savePlaces(seed.actor(),seed.trip(),revision,Map.of("status","completed","provider","amap_places","coverage","page","domain","play",
                "checkedAt",now.toString(),"freshUntil",now.plusSeconds(1800).toString(),"candidates",candidates)).get("resultId"));
    }
    void due(Seed seed) { jdbc.update("UPDATE travel_risk_follow_ups SET next_check_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE trip_id=?",seed.trip()); }
    Map<String,Object> forecast(String condition) {
        Instant now=Instant.now();
        return Map.of("status","completed","provider","amap_weather","coverage","covered","checkedAt",now.toString(),"freshUntil",now.plusSeconds(7200).toString(),
                "requestedDates",List.of(date),"forecastDays",List.of(Map.of("date",date,"dayCondition",condition,"nightCondition",condition,"highC",20,"lowC",10)));
    }
    @Test void everyUnknownMustBeAcknowledgedAndTentativeStateSurvivesReopenWithoutAlteringFacts() {
        var seed=seed(false,false); var before=state(trips.get(seed.actor(),seed.trip()));
        assertEquals(true,seed.report().get("canAdoptTentatively")); assertEquals(false,seed.report().get("canAdopt"));
        assertEquals("adoption_acknowledgments_required",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),2,0,
                (String)seed.report().get("reviewDigest"),List.of(),true,"incomplete")).code());
        assertEquals("risk_follow_up_consent_required",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),2,0,
                (String)seed.report().get("reviewDigest"),acknowledgments(seed),false,"no-risk-consent")).code());
        var duplicate=new ArrayList<>(acknowledgments(seed)); duplicate.add(duplicate.get(0));
        assertEquals("invalid_adoption_review",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),2,0,
                (String)seed.report().get("reviewDigest"),duplicate,true,"duplicate-condition")).code());
        var extra=new ArrayList<>(acknowledgments(seed)); extra.add("invented-condition");
        assertEquals("adoption_acknowledgments_required",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),2,0,
                (String)seed.report().get("reviewDigest"),extra,true,"extra-condition")).code());
        UUID viewer=accounts.fromVerifiedGoogleSubject("viewer","Viewer"); trips.grant(seed.actor(),seed.trip(),viewer,"viewer",0,"viewer-share");
        assertEquals("trip_not_found",assertThrows(TravelError.class,()->adoptions.adoptTentative(viewer,seed.trip(),seed.draft(),2,0,
                (String)seed.report().get("reviewDigest"),acknowledgments(seed),true,"viewer-adopt")).code());
        assertEquals(2L,trips.get(seed.actor(),seed.trip()).get("revision"));
        var adopted=adopt(seed,"adopt"); assertEquals(3L,adopted.get("revision"));
        var reopened=state(trips.get(seed.actor(),seed.trip()));
        for(String key:List.of("brief","travelers","budgetLedger","confirmedTransport")) assertEquals(before.get(key),reopened.get(key),key);
        var plan=(Map<?,?>)((Map<?,?>)reopened.get("planning")).get("adopted");
        assertEquals("tentative",plan.get("status")); assertEquals(acknowledgments(seed),plan.get("acknowledgedCheckIds"));
        assertEquals(seed.report().get("checks"),plan.get("checks"));
        assertEquals("adopted",drafts.get(seed.actor(),seed.trip(),seed.draft()).get("status"));
        assertTrue(((List<?>)drafts.list(seed.actor(),seed.trip(),20,null,null).get("items")).isEmpty());
        assertEquals(3L,adopt(seed,"adopt").get("revision"));
        assertEquals(1,((List<?>)state(adopted).get("changeJournal")).size());
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM travel_risk_follow_ups",Integer.class));
        var tracking=followUps.read(seed.actor(),seed.trip(),null); assertEquals(true,tracking.get("enabled"));
        assertTrue(((List<?>)tracking.get("coverageGaps")).contains("opening_and_reservations"));
        assertEquals("adoption_needs_impact_review",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),3,0,
                (String)seed.report().get("reviewDigest"),acknowledgments(seed),true,"replace")).code());
    }
    @Test void aChangedReviewAndExpiredSourceCannotReuseEarlierAcknowledgment() {
        var seed=seed(false,false);
        drafts.editVisit(seed.actor(),seed.trip(),seed.draft(),2,0,"edit","visit-1",Map.of("startLocal",date+"T11:00","timeZone","Asia/Shanghai","durationMinutes",60));
        assertEquals("adoption_review_changed",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),2,1,
                (String)seed.report().get("reviewDigest"),acknowledgments(seed),true,"old-review")).code());
        var current=drafts.verify(seed.actor(),seed.trip(),seed.draft(),2,1);
        jdbc.update("UPDATE travel_result_references SET fresh_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE result_id=?",seed.source());
        assertEquals("adoption_blocked",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),seed.draft(),2,1,
                (String)current.get("reviewDigest"),acknowledgments(seed),true,"expired")).code());
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM travel_risk_follow_ups",Integer.class));
        assertEquals(2L,trips.get(seed.actor(),seed.trip()).get("revision"));
    }
    @Test void cloudReviewReopensAndEditingOneVisitRetainsUnrelatedAcknowledgments() {
        var initial=seed(false,false);
        UUID draft=UUID.fromString((String)drafts.stage(initial.actor(),initial.trip(),2,"two-visits",List.of(stop("visit-1",initial.source(),"museum","T10:00"),stop("visit-2",initial.source(),"museum","T14:00"))).get("draftId"));
        var seed=new Seed(initial.actor(),initial.trip(),draft,initial.source(),2,drafts.verify(initial.actor(),initial.trip(),draft,2,0));
        acknowledgeAll(seed.actor(),seed);
        var reopened=new TravelItineraryReviews(jdbc,new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource())),drafts).read(seed.actor(),seed.trip(),draft,2,0);
        assertEquals(new java.util.HashSet<>(acknowledgments(seed)),new java.util.HashSet<>(savedIds(reopened)));
        drafts.editVisit(seed.actor(),seed.trip(),draft,2,0,"shift-first","visit-1",Map.of("startLocal",date+"T11:00","timeZone","Asia/Shanghai","durationMinutes",60));
        var changed=reviews.read(seed.actor(),seed.trip(),draft,2,1);
        for(String kind:List.of("time_zone_source","opening_and_reservations","inventory_and_prices")) {
            assertTrue(savedIds(changed).contains(kind+":visit-2"),"An unchanged second visit must keep its decision");
            assertFalse(savedIds(changed).contains(kind+":visit-1"),"The edited time slot needs a current decision");
        }
        assertTrue(savedIds(changed).containsAll(List.of("complete_trip","risk_follow_up_coverage")),"The same trip scope and unchanged follow-up end remain acknowledged");
        assertEquals("draft_revision_conflict",assertThrows(TravelError.class,()->saveCheck(seed.actor(),seed,reopened,"opening_and_reservations:visit-1",true,"late-old-screen")).code());
        assertEquals("review_condition_changed",assertThrows(TravelError.class,()->reviews.saveCondition(seed.actor(),seed.trip(),draft,2,1,
                ((Number)((Map<?,?>)changed.get("reviewState")).get("revision")).longValue(),"opening_and_reservations:visit-1",basis(reopened,"opening_and_reservations:visit-1"),true,"old-basis")).code());
        @SuppressWarnings("unchecked") var required=(List<String>)changed.get("requiredAcknowledgments");
        assertEquals("adoption_acknowledgments_not_saved",assertThrows(TravelError.class,()->adoptions.adoptTentative(seed.actor(),seed.trip(),draft,2,1,(String)changed.get("reviewDigest"),required,true,"skip-reconfirm")).code());
    }
    @Test void freshIdenticalFactsRetainDecisionsAndAChangedPriceOnlyInvalidatesItsReaders() {
        var seed=seed(false,false);acknowledgeAll(seed.actor(),seed);
        UUID fresh=source(seed,2,List.of(Map.of("sourceId","museum","domain","play","name","测试地点的新显示名称"),Map.of("sourceId","unused","domain","play","name","未选地点")));
        UUID next=UUID.fromString((String)drafts.stage(seed.actor(),seed.trip(),2,"fresh-query",List.of(stop("visit-1",fresh,"museum","T10:00"))).get("draftId"));
        var report=reviews.read(seed.actor(),seed.trip(),next,2,0);
        assertEquals(new java.util.HashSet<>(acknowledgments(seed)),new java.util.HashSet<>(savedIds(report)),"Fresh observation metadata and unused candidates do not change the selected conditions");
        UUID priced=source(seed,2,List.of(Map.of("sourceId","museum","domain","play","name","测试地点","averageCostReference","25")));
        UUID changed=UUID.fromString((String)drafts.stage(seed.actor(),seed.trip(),2,"price-query",List.of(stop("visit-1",priced,"museum","T10:00"))).get("draftId"));
        var current=reviews.read(seed.actor(),seed.trip(),changed,2,0);
        var missing=new java.util.HashSet<>(acknowledgments(seed));missing.removeAll(savedIds(current));
        assertEquals(java.util.Set.of("inventory_and_prices:visit-1","budget"),missing);
        assertFalse((Boolean)current.get("canAdopt"),"A new cost reference still does not verify inventory or the trip");
    }
    @Test void changingOnlyBudgetRetainsEveryOtherConditionAcrossTheNewTripRevision() {
        var seed=seed(false,false);acknowledgeAll(seed.actor(),seed);
        trips.updateEmptyTripScope(seed.actor(),seed.trip(),2,"budget-only",Map.of("totalBudget",1500));
        UUID fresh=source(seed,3,List.of(Map.of("sourceId","museum","domain","play","name","测试地点")));
        UUID next=UUID.fromString((String)drafts.stage(seed.actor(),seed.trip(),3,"after-budget",List.of(stop("visit-1",fresh,"museum","T10:00"))).get("draftId"));
        var current=reviews.read(seed.actor(),seed.trip(),next,3,0);
        var missing=new java.util.HashSet<>(acknowledgments(seed));missing.removeAll(savedIds(current));
        assertEquals(java.util.Set.of("budget"),missing,"A trip revision alone must not erase unrelated human review");
    }
    @Test void reviewProgressIsPrivateAndRevocationAlsoBlocksIdempotentWriteRecovery() {
        var seed=seed(false,false);acknowledgeAll(seed.actor(),seed);
        UUID editor=accounts.fromVerifiedGoogleSubject("review-editor","Editor"),viewer=accounts.fromVerifiedGoogleSubject("review-viewer","Viewer");
        trips.grant(seed.actor(),seed.trip(),editor,"editor",0,"share-editor");trips.grant(seed.actor(),seed.trip(),viewer,"viewer",1,"share-viewer");
        var empty=reviews.read(editor,seed.trip(),seed.draft(),2,0);assertTrue(savedIds(empty).isEmpty());
        assertTrue(savedIds(reviews.read(viewer,seed.trip(),seed.draft(),2,0)).isEmpty());
        assertEquals("trip_not_found",assertThrows(TravelError.class,()->saveCheck(viewer,seed,empty,"time_zone_source:visit-1",true,"viewer-check")).code());
        var saved=saveCheck(editor,seed,empty,"time_zone_source:visit-1",true,"editor-check");
        assertEquals(List.of("time_zone_source:visit-1"),savedIds(saved));
        assertEquals(acknowledgments(seed).size(),savedIds(reviews.read(seed.actor(),seed.trip(),seed.draft(),2,0)).size());
        trips.revoke(seed.actor(),seed.trip(),editor,2,"revoke-editor");
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM travel_itinerary_reviews WHERE trip_id=? AND account_id=?",Integer.class,seed.trip(),editor));
        assertEquals("trip_not_found",assertThrows(TravelError.class,()->saveCheck(editor,seed,empty,"time_zone_source:visit-1",true,"editor-check")).code());
    }
    @Test void twoScreensCannotLoseAReviewUpdateAndAnOldReceiptCannotRecheckAnUncheckedItem() throws Exception {
        var seed=seed(false,false);var initial=reviews.read(seed.actor(),seed.trip(),seed.draft(),2,0);
        var start=new CountDownLatch(1);var executor=Executors.newFixedThreadPool(2);
        try {
            var calls=new ArrayList<java.util.concurrent.Future<String>>();
            var ids=List.of("time_zone_source:visit-1","opening_and_reservations:visit-1");
            for(String id:ids) calls.add(executor.submit(()->{start.await();try {saveCheck(seed.actor(),seed,initial,id,true,"parallel-"+id);return id;}catch(TravelError error){return error.code();}}));
            start.countDown();var outcomes=List.of(calls.get(0).get(10,TimeUnit.SECONDS),calls.get(1).get(10,TimeUnit.SECONDS));
            assertEquals(1,outcomes.stream().filter("review_revision_conflict"::equals).count());
            var current=reviews.read(seed.actor(),seed.trip(),seed.draft(),2,0);assertEquals(1,savedIds(current).size());
            String winner=savedIds(current).get(0),loser=ids.stream().filter(id -> !winner.equals(id)).findFirst().orElseThrow();
            current=saveCheck(seed.actor(),seed,current,loser,true,"retry-current");assertEquals(2,savedIds(current).size());
            current=saveCheck(seed.actor(),seed,current,winner,false,"uncheck");assertEquals(List.of(loser),savedIds(current));
            var replay=saveCheck(seed.actor(),seed,initial,winner,true,"parallel-"+winner);
            assertEquals(List.of(loser),savedIds(replay),"Receipt recovery reads current progress and never replays the old checkbox mutation");
            assertEquals(3L,((Map<?,?>)replay.get("reviewState")).get("revision"));
        } finally {executor.shutdownNow();}
    }
    @Test void knownTimeConflictsAndKnownOverBudgetAmountsCannotBeAcknowledgedAway() {
        var seed=seed(true,false); assertEquals(false,seed.report().get("canAdoptTentatively"));
        assertEquals("adoption_blocked",assertThrows(TravelError.class,()->adopt(seed,"conflict")).code());
        setup(); var expensive=seed(false,true); assertEquals(false,expensive.report().get("canAdoptTentatively"));
        assertTrue(((List<?>)expensive.report().get("checks")).stream().anyMatch(value -> value instanceof Map<?,?> item && "budget".equals(item.get("id")) && "blocked".equals(item.get("status"))));
        assertEquals("adoption_blocked",assertThrows(TravelError.class,()->adopt(expensive,"expensive")).code());
    }
    @Test void concurrentAdoptionsCommitOnceAndRevocationAlsoBlocksAnIdempotentReplay() throws Exception {
        var seed=seed(false,false); UUID editor=accounts.fromVerifiedGoogleSubject("editor","Editor");
        trips.grant(seed.actor(),seed.trip(),editor,"editor",0,"share");
        acknowledgeAll(editor,seed);
        var start=new CountDownLatch(1); var executor=Executors.newFixedThreadPool(2);
        try {
            var calls=new ArrayList<java.util.concurrent.Future<String>>();
            for(int i=0;i<2;i++) { final int attempt=i; calls.add(executor.submit(()->{ start.await(); try { adoptions.adoptTentative(editor,seed.trip(),seed.draft(),2,0,(String)seed.report().get("reviewDigest"),acknowledgments(seed),true,"race-"+attempt); return "adopted"; } catch(TravelError error) { return error.code(); } })); }
            start.countDown(); var outcomes=List.of(calls.get(0).get(10,TimeUnit.SECONDS),calls.get(1).get(10,TimeUnit.SECONDS));
            assertEquals(1,outcomes.stream().filter("adopted"::equals).count()); assertTrue(outcomes.contains("revision_conflict"));
            trips.revoke(seed.actor(),seed.trip(),editor,1,"revoke");
            assertEquals(false,followUps.read(seed.actor(),seed.trip(),null).get("enabled"));
            assertEquals("trip_not_found",assertThrows(TravelError.class,()->adoptions.adoptTentative(editor,seed.trip(),seed.draft(),2,0,(String)seed.report().get("reviewDigest"),acknowledgments(seed),true,"race-0")).code());
        } finally { executor.shutdownNow(); }
    }
    @Test void weatherNoChangeCreatesNoAlertAndUnavailableIsDifferentFromNoChange() {
        var seed=seed(false,false); adopt(seed,"adopt");
        when(weather.forecast(anyMap())).thenReturn(Mono.just(forecast("晴"))); followUps.checkDue();
        assertEquals("baseline_saved",((Map<?,?>)followUps.read(seed.actor(),seed.trip(),null).get("weather")).get("status"));
        due(seed); followUps.checkDue(); assertTrue(((List<?>)followUps.read(seed.actor(),seed.trip(),null).get("events")).isEmpty());
        when(weather.forecast(anyMap())).thenReturn(Mono.just(forecast("雨"))); due(seed); followUps.checkDue();
        assertEquals(1,((List<?>)followUps.read(seed.actor(),seed.trip(),null).get("events")).size());
        due(seed); followUps.checkDue(); assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM travel_risk_changes",Integer.class));
        var prior=(Map<?,?>)followUps.read(seed.actor(),seed.trip(),null).get("weather");
        when(weather.forecast(anyMap())).thenReturn(Mono.just(Map.of("status","provider_unavailable","reason","test_outage"))); due(seed); followUps.checkDue();
        var unavailable=(Map<?,?>)followUps.read(seed.actor(),seed.trip(),null).get("weather");
        assertEquals("provider_unavailable",unavailable.get("status")); assertEquals(prior.get("lastSuccessAt"),unavailable.get("lastSuccessAt"));
        var outside=new java.util.LinkedHashMap<>(forecast("晴")); outside.put("coverage","outside_forecast_window");
        outside.put("forecastDays",List.of(Map.of("date",LocalDate.parse(date).minusDays(1).toString(),"dayCondition","晴","nightCondition","晴","highC",20,"lowC",10)));
        when(weather.forecast(anyMap())).thenReturn(Mono.just(outside)); due(seed); followUps.checkDue();
        var window=(Map<?,?>)followUps.read(seed.actor(),seed.trip(),null).get("weather");
        assertEquals("outside_forecast_window",window.get("status")); assertEquals(prior.get("lastSuccessAt"),window.get("lastSuccessAt"));
        assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM travel_risk_changes",Integer.class));
        assertEquals("tentative",((Map<?,?>)((Map<?,?>)state(trips.get(seed.actor(),seed.trip())).get("planning")).get("adopted")).get("status"));
    }
    @Test void pausingDuringAWeatherRequestFencesTheLateResultAndEndTimeStopsChecks() throws Exception {
        var seed=seed(false,false); adopt(seed,"adopt");
        var entered=new CountDownLatch(1); var release=new CountDownLatch(1); var executor=Executors.newFixedThreadPool(2);
        when(weather.forecast(anyMap())).thenReturn(Mono.fromCallable(()->{ entered.countDown(); assertTrue(release.await(10,TimeUnit.SECONDS)); return forecast("雨"); }));
        var running=executor.submit(followUps::checkDue);
        try {
            assertTrue(entered.await(10,TimeUnit.SECONDS));
            executor.submit(followUps::checkDue).get(2,TimeUnit.SECONDS);
            followUps.setEnabled(seed.actor(),seed.trip(),3,0,false,"pause"); release.countDown(); running.get(10,TimeUnit.SECONDS);
            assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM travel_result_references WHERE kind='weather'",Integer.class));
            assertEquals(false,followUps.read(seed.actor(),seed.trip(),null).get("enabled"));
            jdbc.update("UPDATE travel_risk_follow_ups SET stops_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE trip_id=?",seed.trip());
            assertEquals("trip_already_ended",assertThrows(TravelError.class,()->followUps.setEnabled(seed.actor(),seed.trip(),3,1,true,"resume-ended")).code());
        } finally { release.countDown(); executor.shutdownNow(); }
    }
    @Test void anActiveFollowUpEndsBeforeRequestingTheSourceAfterItsDeadline() {
        var seed=seed(false,false); adopt(seed,"adopt");
        jdbc.update("UPDATE travel_risk_follow_ups SET stops_at=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE trip_id=?",seed.trip());
        when(weather.forecast(anyMap())).thenAnswer(call->{throw new AssertionError("An ended trip queried a source");});
        followUps.checkDue();
        var tracking=followUps.read(seed.actor(),seed.trip(),null);
        assertEquals(false,tracking.get("enabled")); assertEquals("ended",((Map<?,?>)tracking.get("weather")).get("status"));
        assertEquals(0,jdbc.queryForObject("SELECT count(*) FROM travel_result_references WHERE kind='weather'",Integer.class));
    }
}
