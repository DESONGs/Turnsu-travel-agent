package app.travelagent.core;

import static org.junit.jupiter.api.Assertions.*;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import app.travelagent.auth.OAuthGrants;
import app.travelagent.auth.OAuthSettings;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class TravelTripsPostgresTest {
    private static EmbeddedPostgres postgres;
    private static JdbcTemplate jdbc;
    private TravelAccounts accounts;
    private TravelTrips trips;
    private TravelSharing sharing;

    @BeforeAll
    static void startDatabase() throws Exception {
        postgres = EmbeddedPostgres.builder().setPort(0).start();
        DataSource source = postgres.getPostgresDatabase();
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
    }

    @AfterAll
    static void stopDatabase() throws Exception { if (postgres != null) postgres.close(); }

    @BeforeEach
    void initializeServices() {
        jdbc.execute("TRUNCATE travel_accounts CASCADE");
        accounts = new TravelAccounts(jdbc);
        trips = new TravelTrips(jdbc, new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource())),
                Clock.fixed(Instant.parse("2026-11-06T00:00:00Z"), ZoneOffset.UTC));
        sharing = new TravelSharing(jdbc, new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource())), trips);
    }

    @Test
    void workerItineraryProposalCreatesAnUnadoptedDraftAtomicallyAndRejectsInventedSources() {
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var results = new TravelResults(jdbc, tx);
        UUID owner = accounts.fromVerifiedGoogleSubject("proposal-owner", "Owner");
        UUID trip = UUID.fromString((String) trips.create(owner, "proposal-trip", Map.of("destination", "Shanghai", "countryCode", "CN")).get("tripId"));
        var now = Instant.now();
        var source = results.savePlaces(owner, trip, 0, Map.of("status", "completed", "provider", "amap_places", "coverage", "partial",
                "checkedAt", now.toString(), "freshUntil", now.plusSeconds(1200).toString(), "domain", "play",
                "candidates", List.of(Map.of("sourceId", "museum", "name", "Source museum", "domain", "play"))));
        var tasks = new TravelTasks(jdbc, tx, true, 2, 1, 10, new TravelItineraryDrafts(jdbc, tx, new TravelResults(jdbc, tx)));
        tasks.submit(owner, trip, 0, "typed-task", "安排已选地点");
        var claim = tasks.claim();
        UUID task = UUID.fromString((String) claim.get("taskId")), lease = UUID.fromString((String) claim.get("leaseId"));
        long generation = ((Number) claim.get("generation")).longValue();
        var stop = Map.<String, Object>of("stopId", "visit-1", "sourceResultId", source.get("resultId"), "sourceId", "museum", "role", "activity",
                "startLocal", "2026-12-01T10:00", "timeZone", "Asia/Shanghai", "durationMinutes", 60);
        var output = Map.<String, Object>of("kind", "itinerary_proposal", "summary", "待核验的单次到访", "evidenceIds", List.of(source.get("resultId")),
                "unknowns", List.of("营业与预约尚未核实"), "stops", List.of(stop));
        var completed = tasks.finish(task, generation, lease, output);
        assertEquals("completed", completed.get("status"));
        var suggestion = (Map<?, ?>) completed.get("suggestion");
        assertNotNull(suggestion.get("draftId"));
        var saved = new TravelItineraryDrafts(jdbc, tx, results).get(owner, trip, UUID.fromString((String) suggestion.get("draftId")));
        assertEquals(false, ((Map<?, ?>) saved.get("draft")).get("canAdopt"));
        var checked = new TravelItineraryDrafts(jdbc, tx, results).verify(owner, trip, UUID.fromString((String) suggestion.get("draftId")), 0, 0);
        assertEquals(false, checked.get("canAdopt"));
        assertEquals(true, checked.get("canAdoptTentatively"));
        assertNotNull(checked.get("reviewDigest"));
        assertTrue(((List<?>) checked.get("checks")).stream().anyMatch(value -> value instanceof Map<?, ?> check
                && "sources".equals(check.get("id")) && "passed".equals(check.get("status"))));
        assertTrue(((List<?>) checked.get("checks")).stream().anyMatch(value -> value instanceof Map<?, ?> check
                && String.valueOf(check.get("id")).startsWith("opening_and_reservations:") && "unverified".equals(check.get("status"))));
        assertEquals(0L, trips.get(owner, trip).get("revision"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM travel_itinerary_drafts WHERE trip_id=?", Integer.class, trip));
        tasks.submit(owner, trip, 0, "bad-typed-task", "再次安排");
        var badClaim = tasks.claim();
        var badStop = new java.util.LinkedHashMap<>(stop); badStop.put("sourceId", "invented-place");
        var badOutput = new java.util.LinkedHashMap<>(output); badOutput.put("stops", List.of(badStop));
        assertThrows(TravelError.class, () -> tasks.finish(UUID.fromString((String) badClaim.get("taskId")), ((Number) badClaim.get("generation")).longValue(),
                UUID.fromString((String) badClaim.get("leaseId")), badOutput));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM travel_itinerary_drafts WHERE trip_id=?", Integer.class, trip));
        jdbc.update("UPDATE travel_result_references SET fresh_until=CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE result_id=?", UUID.fromString((String) source.get("resultId")));
        var expired = new TravelItineraryDrafts(jdbc, tx, results).verify(owner, trip, UUID.fromString((String) suggestion.get("draftId")), 0, 0);
        assertTrue(((List<?>) expired.get("checks")).stream().anyMatch(value -> value instanceof Map<?, ?> check
                && "sources".equals(check.get("id")) && "blocked".equals(check.get("status"))));
    }

    @Test
    void oauthCodesAndRefreshTokensAreBoundToClientResourceAndSingleUse() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        var settings = new OAuthSettings("https://travel.example.com", "https://chatgpt.com/connector_platform_oauth_redirect", false);
        var oauth = new OAuthGrants(jdbc, new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource())), settings);
        String redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
        String client = (String) oauth.registerClient("ChatGPT", List.of(redirect)).get("client_id");
        assertEquals("invalid_client_metadata", assertThrows(TravelError.class,
                () -> oauth.registerClient("bad", List.of("https://attacker.example/callback"))).code());
        String verifier = "a".repeat(43);
        String challenge = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                java.security.MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(java.nio.charset.StandardCharsets.US_ASCII)));
        assertEquals("invalid_authorization_request", assertThrows(TravelError.class,
                () -> oauth.beginAuthorization(client, redirect, "state", challenge, "plain", "travel:read", settings.resource())).code());
        String pending = oauth.beginAuthorization(client, redirect, "state", challenge, "S256", "travel:read travel:write", settings.resource());
        var code = oauth.completeVerifiedGoogle(pending, alice);
        assertEquals("state", code.state());
        assertFalse(code.toString().contains(code.code()));
        assertEquals("invalid_grant", assertThrows(TravelError.class,
                () -> oauth.exchangeCode(client, code.code(), "b".repeat(43), redirect, settings.resource())).code());
        var issued = oauth.exchangeCode(client, code.code(), verifier, redirect, settings.resource());
        assertEquals(alice, oauth.authenticate(issued.accessToken(), "travel:write").accountId());
        assertFalse(issued.toString().contains(issued.accessToken()));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM travel_oauth_access WHERE token_hash=?", Integer.class, issued.accessToken()));
        assertEquals("invalid_grant", assertThrows(TravelError.class,
                () -> oauth.exchangeCode(client, code.code(), verifier, redirect, settings.resource())).code());
        var renewed = oauth.refresh(client, issued.refreshToken(), settings.resource());
        assertEquals("authentication_required", assertThrows(TravelError.class, () -> oauth.authenticate(issued.accessToken(), "travel:read")).code());
        assertEquals(alice, oauth.authenticate(renewed.accessToken(), "travel:read").accountId());
        assertEquals("invalid_grant", assertThrows(TravelError.class, () -> oauth.refresh(client, issued.refreshToken(), settings.resource())).code());
        assertEquals("authentication_required", assertThrows(TravelError.class, () -> oauth.authenticate(renewed.accessToken(), "travel:read")).code());
    }

    @Test
    void retryReturnsTheOriginalTripAndRejectsReusingTheKeyForDifferentInput() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        assertEquals(alice, accounts.fromVerifiedGoogleSubject("alice-subject", "Alice"));
        var first = trips.create(alice, "request-1", Map.of("destination", "Tokyo", "countryCode", "JP"));
        var retry = trips.create(alice, "request-1", Map.of("countryCode", "JP", "destination", "Tokyo"));
        assertEquals(first.get("tripId"), retry.get("tripId"));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM travel_trips", Integer.class));
        assertEquals("request_id_conflict", assertThrows(TravelError.class,
                () -> trips.create(alice, "request-1", Map.of("destination", "Osaka"))).code());
        assertEquals(first.get("state"), trips.get(alice, UUID.fromString((String) first.get("tripId"))).get("state"));
    }

    @Test
    void profileNeverReturnsAnEmailStoredAsADisplayName() {
        UUID account = accounts.fromVerifiedGoogleSubject("profile-subject", "name@example.com", "name@example.com", false);
        assertFalse(accounts.profile(account).containsKey("name"));
        // Older records may already have an email in the display-name column.
        jdbc.update("UPDATE travel_accounts SET display_name=? WHERE account_id=?", "legacy@example.com", account);
        assertFalse(accounts.profile(account).toString().contains("@"));
    }

    @Test
    void concurrentIdenticalRequestsCreateOnlyOneDurableTrip() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(8);
        try {
            var futures = new ArrayList<java.util.concurrent.Future<Map<String, Object>>>();
            for (int i = 0; i < 8; i++) futures.add(executor.submit(() -> {
                start.await();
                return trips.create(alice, "same-request", Map.of("destination", "Shanghai", "countryCode", "CN"));
            }));
            start.countDown();
            var ids = new java.util.HashSet<Object>();
            for (var future : futures) ids.add(future.get(20, TimeUnit.SECONDS).get("tripId"));
            assertEquals(1, ids.size());
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM travel_trips", Integer.class));
            assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM travel_command_receipts", Integer.class));
        } finally { executor.shutdownNow(); }
    }

    @Test
    void sharingUsesVerifiedEmailOnlyToFindAStableGoogleAccountAndRespectsRevocation() {
        UUID alice = accounts.fromVerifiedGoogleSubject("share-owner", "Owner", "owner@gmail.com", true);
        UUID bob = accounts.fromVerifiedGoogleSubject("share-bob", "Bob", "Bob@Gmail.com", true);
        UUID intruder = accounts.fromVerifiedGoogleSubject("share-intruder", "Intruder", "other@gmail.com", true);
        UUID trip = UUID.fromString((String) trips.create(alice, "share-trip", Map.of("destination", "Tokyo")).get("tripId"));
        String hash = TravelAccounts.emailDigest(TravelAccounts.normalizeEmail(" bob@gmail.com "));
        assertEquals("539e5c2f3b81aac3c44fbf3e673ca72ff1cb00a039b918bd1c6bacadc9c30cad", TravelAccounts.emailDigest(TravelAccounts.normalizeEmail(" Alice@Example.Com ")));
        assertEquals("8f5f36be822b28d9490150187df73c3b4f5e908006a1ffe25066a33e4b1a415e", TravelAccounts.emailDigest(TravelAccounts.normalizeEmail("Alice@Gmail.Com")));
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> sharing.resolve(intruder, trip, hash)).code());
        var found = sharing.resolve(alice, trip, hash);
        assertEquals(bob.toString(), found.get("accountId"));
        assertFalse(found.toString().contains("bob@gmail.com"));
        sharing.grantByEmailHash(alice, trip, bob, hash, "viewer", 0, "email-grant");
        assertEquals("viewer", trips.get(bob, trip).get("role"));
        var listed = sharing.list(alice, trip, 1, null, null);
        assertEquals("bob@gmail.com", ((Map<?, ?>) ((List<?>) listed.get("items")).get(0)).get("email"));
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> sharing.list(bob, trip, 10, null, null)).code());
        trips.grant(alice, trip, bob, "editor", 1, "email-role");
        trips.revoke(alice, trip, bob, 2, "email-revoke");
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.get(bob, trip)).code());
        var replay = sharing.grantByEmailHash(alice, trip, bob, hash, "viewer", 0, "email-grant");
        assertEquals("not_shared", replay.get("status"));
        assertEquals(3L, ((Number) replay.get("accessRevision")).longValue());
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.get(bob, trip)).code());
        accounts.fromVerifiedGoogleSubject("share-bob", "Bob", "new@gmail.com", true);
        assertEquals("share_account_changed", assertThrows(TravelError.class,
                () -> sharing.grantByEmailHash(alice, trip, bob, hash, "viewer", 3, "changed-email")).code());
        assertEquals("share_account_unavailable", assertThrows(TravelError.class, () -> sharing.resolve(alice, trip, hash)).code());
        assertEquals(bob, accounts.fromVerifiedGoogleSubject("share-bob", "Bob", "new@gmail.com", true));
    }

    @Test
    void aVerifiedThirdPartyEmailCanBeSharedAfterOwnerConfirmation() {
        UUID alice = accounts.fromVerifiedGoogleSubject("external-owner", "Owner", "owner@gmail.com", true);
        UUID bob = accounts.fromVerifiedGoogleSubject("external-bob", "Bob", "Bob@Example.com", false);
        UUID trip = UUID.fromString((String) trips.create(alice, "external-trip", Map.of("destination", "Tokyo")).get("tripId"));
        String wrongCase = TravelAccounts.emailDigest(TravelAccounts.normalizeEmail("bob@example.com"));
        assertEquals("share_account_unavailable", assertThrows(TravelError.class, () -> sharing.resolve(alice, trip, wrongCase)).code());
        String hash = TravelAccounts.emailDigest(TravelAccounts.normalizeEmail("Bob@example.com"));
        var found = sharing.resolve(alice, trip, hash);
        assertEquals(false, found.get("emailAuthoritative"));
        assertEquals(bob.toString(), found.get("accountId"));
        sharing.grantByEmailHash(alice, trip, bob, hash, "viewer", 0, "external-grant");
        assertEquals("viewer", trips.get(bob, trip).get("role"));
        assertNotEquals(TravelAccounts.normalizeEmail("é@example.com"), TravelAccounts.normalizeEmail("e\u0301@example.com"));
    }

    @Test
    void sharingFailsClosedForAmbiguousUnverifiedAccountsAndLimitsFailedLookups() {
        UUID alice = accounts.fromVerifiedGoogleSubject("lookup-owner", "Owner", "owner@gmail.com", true);
        accounts.fromVerifiedGoogleSubject("lookup-one", "One", "same@gmail.com", true);
        accounts.fromVerifiedGoogleSubject("lookup-two", "Two", "same@gmail.com", true);
        accounts.fromVerifiedGoogleSubject("lookup-unverified", "Unverified");
        UUID trip = UUID.fromString((String) trips.create(alice, "lookup-trip", Map.of("destination", "Tokyo")).get("tripId"));
        new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource())).executeWithoutResult(status -> {
            String duplicate = TravelAccounts.emailDigest(TravelAccounts.normalizeEmail("same@gmail.com"));
            assertEquals("share_account_unavailable", assertThrows(TravelError.class, () -> sharing.resolve(alice, trip, duplicate)).code());
            String missing = TravelAccounts.emailDigest(TravelAccounts.normalizeEmail("missing@gmail.com"));
            for (int i = 0; i < 19; i++) assertEquals("share_account_unavailable", assertThrows(TravelError.class, () -> sharing.resolve(alice, trip, missing)).code());
            assertEquals("share_lookup_rate_limited", assertThrows(TravelError.class, () -> sharing.resolve(alice, trip, missing)).code());
        });
        assertEquals(21, jdbc.queryForObject("SELECT attempts FROM travel_share_lookup_windows WHERE account_id=?", Integer.class, alice));
    }

    @Test
    void upgradingShareDirectoryRequiresFreshGoogleIdentityForPreviouslyLowercasedThirdPartyAddresses() {
        String schema = "share_upgrade_" + UUID.randomUUID().toString().replace("-", "");
        var source = jdbc.getDataSource();
        try {
            Flyway.configure().dataSource(source).schemas(schema).defaultSchema(schema).locations("classpath:db/migration").target("11").load().migrate();
            UUID external = UUID.randomUUID(), gmail = UUID.randomUUID(), trip = UUID.randomUUID();
            jdbc.update("INSERT INTO " + schema + ".travel_accounts(account_id,google_subject,verified_email,verified_email_hash,email_authoritative,email_verified_at) VALUES (?,?,?, ?,false,CURRENT_TIMESTAMP)",
                    external, "external", "bob@example.com", "a".repeat(64));
            jdbc.update("INSERT INTO " + schema + ".travel_accounts(account_id,google_subject,verified_email,verified_email_hash,email_authoritative,email_verified_at) VALUES (?,?,?, ?,true,CURRENT_TIMESTAMP)",
                    gmail, "gmail", "alice@gmail.com", "b".repeat(64));
            jdbc.update("INSERT INTO " + schema + ".travel_trips(trip_id,owner_id,state) VALUES (?,?,CAST('{}' AS jsonb))", trip, gmail);
            jdbc.update("INSERT INTO " + schema + ".travel_trip_access(trip_id,account_id,role) VALUES (?,?,'viewer')", trip, external);
            Flyway.configure().dataSource(source).schemas(schema).defaultSchema(schema).locations("classpath:db/migration").load().migrate();
            assertNull(jdbc.queryForObject("SELECT verified_email FROM " + schema + ".travel_accounts WHERE account_id=?", String.class, external));
            assertNull(jdbc.queryForObject("SELECT verified_email_hash FROM " + schema + ".travel_accounts WHERE account_id=?", String.class, external));
            assertEquals("alice@gmail.com", jdbc.queryForObject("SELECT verified_email FROM " + schema + ".travel_accounts WHERE account_id=?", String.class, gmail));
            assertEquals("viewer", jdbc.queryForObject("SELECT role FROM " + schema + ".travel_trip_access WHERE trip_id=? AND account_id=?", String.class, trip, external));
        } finally { jdbc.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE"); }
    }

    @Test
    void sharingPagesFailWhenPermissionsChangeBetweenPages() {
        UUID alice = accounts.fromVerifiedGoogleSubject("pages-owner", "Owner", "owner@gmail.com", true);
        UUID bob = accounts.fromVerifiedGoogleSubject("pages-bob", "Bob", "bob@gmail.com", true);
        UUID carol = accounts.fromVerifiedGoogleSubject("pages-carol", "Carol", "carol@gmail.com", true);
        UUID trip = UUID.fromString((String) trips.create(alice, "pages-trip", Map.of("destination", "Tokyo")).get("tripId"));
        trips.grant(alice, trip, bob, "viewer", 0, "page-bob");
        trips.grant(alice, trip, carol, "viewer", 1, "page-carol");
        var page = sharing.list(alice, trip, 1, null, null);
        var cursor = (Map<?, ?>) page.get("nextCursor");
        assertNotNull(cursor);
        assertEquals(1, ((List<?>) sharing.list(alice, trip, 1, UUID.fromString((String) cursor.get("accountId")), ((Number) cursor.get("accessRevision")).longValue()).get("items")).size());
        trips.revoke(alice, trip, carol, 2, "page-revoke");
        assertEquals("access_revision_conflict", assertThrows(TravelError.class,
                () -> sharing.list(alice, trip, 1, UUID.fromString((String) cursor.get("accountId")), ((Number) cursor.get("accessRevision")).longValue())).code());
    }

    @Test
    void sharingIsPrivateByDefaultAndRevocationRemovesAccessImmediately() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("bob-subject", "Bob");
        UUID third = accounts.fromVerifiedGoogleSubject("third-subject", "Third");
        UUID trip = UUID.fromString((String) trips.create(alice, "new", Map.of("destination", "Tokyo")).get("tripId"));
        assertTrue(((List<?>) trips.list(bob, 50, null, null).get("items")).isEmpty());
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.get(bob, trip)).code());
        trips.grant(alice, trip, bob, "viewer", 0, "share-view");
        assertEquals("viewer", trips.get(bob, trip).get("role"));
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.grant(bob, trip, third, "editor", 1, "bad-share")).code());
        trips.grant(alice, trip, bob, "editor", 1, "share-edit");
        assertEquals("editor", trips.get(bob, trip).get("role"));
        assertEquals(true, trips.revoke(alice, trip, bob, 2, "unshare").get("revoked"));
        assertEquals("access_revision_conflict", assertThrows(TravelError.class,
                () -> trips.grant(alice, trip, bob, "viewer", 2, "stale-share")).code());
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.get(bob, trip)).code());
        assertEquals("owner", trips.get(alice, trip).get("role"));
    }

    @Test
    void editingRequirementsUsesRevisionChecksAndPreservesExistingPlans() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("bob-subject", "Bob");
        UUID trip = UUID.fromString((String) trips.create(alice, "new", Map.of("destination", "Tokyo")).get("tripId"));
        trips.grant(alice, trip, bob, "viewer", 0, "view");
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.updateEmptyTripScope(bob, trip, 0, "viewer-update", Map.of("totalBudget", 3000))).code());
        trips.grant(alice, trip, bob, "editor", 1, "edit");
        var updated = trips.updateEmptyTripScope(bob, trip, 0, "budget", Map.of("totalBudget", 3000, "currency", "JPY"));
        assertEquals(1L, updated.get("revision"));
        assertEquals(1L, ((Number) trips.updateEmptyTripScope(bob, trip, 0, "budget", Map.of("currency", "JPY", "totalBudget", 3000)).get("revision")).longValue());
        assertEquals("revision_conflict", assertThrows(TravelError.class,
                () -> trips.updateEmptyTripScope(alice, trip, 0, "stale", Map.of("destination", "Osaka"))).code());
        trips.revoke(alice, trip, bob, 2, "remove-editor");
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.updateEmptyTripScope(bob, trip, 0, "budget",
                Map.of("currency", "JPY", "totalBudget", 3000))).code());
        var state = (Map<?, ?>) trips.get(alice, trip).get("state");
        assertEquals(3000, ((Map<?, ?>) state.get("budgetLedger")).get("totalBudget"));
        jdbc.update("UPDATE travel_trips SET state=jsonb_set(state,'{nodes}', '[{\"nodeId\":\"keep-me\"}]'::jsonb) WHERE trip_id=?", trip);
        assertEquals("scope_change_needs_planning_rules", assertThrows(TravelError.class,
                () -> trips.updateEmptyTripScope(alice, trip, 1, "after-plan", Map.of("destination", "Osaka"))).code());
        assertTrue(trips.get(alice, trip).toString().contains("keep-me"));
    }

    @Test
    void recordedTransportKeepsEachSegmentAndRejectsUnsafeOrAmbiguousChanges() {
        UUID alice = accounts.fromVerifiedGoogleSubject("transport-owner", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("transport-viewer", "Bob");
        UUID trip = UUID.fromString((String) trips.create(alice, "transport-trip", Map.of("destination", "London")).get("tripId"));
        trips.upsertEmptyTripTraveler(alice, trip, 0, "transport-person", Map.of("travelerId", "a", "displayName", "同行人甲"));
        trips.grant(alice, trip, bob, "viewer", 0, "transport-share");
        var flight = Map.<String, Object>of("transportId", "outbound", "mode", "flight", "number", "AB123", "origin", "New York", "destination", "London",
                "departure", Map.of("local", "2026-11-01T01:30", "timeZone", "America/New_York", "utcOffset", "-04:00"),
                "arrival", Map.of("local", "2026-11-01T12:00", "timeZone", "Europe/London"), "travelerIds", List.of("a"),
                "price", Map.of("amount", "123.450", "currency", "USD", "unit", "per_person", "taxes", "unknown", "coverage", "segment"));
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> trips.saveConfirmedTransport(bob, trip, 1, "viewer-flight", flight)).code());
        var first = trips.saveConfirmedTransport(alice, trip, 1, "flight-one", flight);
        assertEquals(2L, first.get("revision"));
        var fact = (Map<?, ?>) ((List<?>) ((Map<?, ?>) first.get("state")).get("confirmedTransport")).get(0);
        assertEquals("2026-11-01T05:30:00Z", ((Map<?, ?>) fact.get("departure")).get("instant"));
        assertEquals(false, fact.get("verified"));
        assertEquals(Map.of("amount", "123.450", "currency", "USD", "unit", "per_person", "taxes", "unknown", "coverage", "segment"), fact.get("price"));
        assertEquals(2L, trips.saveConfirmedTransport(alice, trip, 2, "flight-no-change", flight).get("revision"));
        assertEquals("scope_change_needs_planning_rules", assertThrows(TravelError.class,
                () -> trips.updateEmptyTripScope(alice, trip, 2, "destination-after-booking", Map.of("destination", "Osaka"))).code());
        var inbound = Map.<String, Object>of("transportId", "inbound", "mode", "flight", "origin", "London", "destination", "New York",
                "departure", Map.of("local", "2026-11-10T12:00", "timeZone", "Europe/London"),
                "arrival", Map.of("local", "2026-11-10T16:00", "timeZone", "America/New_York"));
        assertEquals(3L, trips.saveConfirmedTransport(alice, trip, 2, "flight-two", inbound).get("revision"));
        assertEquals(3L, ((Number) trips.saveConfirmedTransport(alice, trip, 1, "flight-one", flight).get("revision")).longValue());
        var editedFlight = new java.util.LinkedHashMap<>(flight); editedFlight.put("number", "AB124");
        var edited = trips.saveConfirmedTransport(alice, trip, 3, "edit-flight", editedFlight);
        assertEquals(4L, edited.get("revision"));
        var afterEdit = (List<?>) ((Map<?, ?>) edited.get("state")).get("confirmedTransport");
        assertEquals("AB124", ((Map<?, ?>) afterEdit.get(0)).get("number"));
        assertEquals("123.450", ((Map<?, ?>) ((Map<?, ?>) afterEdit.get(0)).get("price")).get("amount"));
        assertEquals("inbound", ((Map<?, ?>) afterEdit.get(1)).get("transportId"));
        var ambiguous = new java.util.LinkedHashMap<>(flight);
        ambiguous.put("transportId", "ambiguous");
        ambiguous.put("departure", Map.of("local", "2026-11-01T01:30", "timeZone", "America/New_York"));
        assertEquals("ambiguous_local_time", assertThrows(TravelError.class, () -> trips.saveConfirmedTransport(alice, trip, 4, "ambiguous", ambiguous)).code());
        var backwards = new java.util.LinkedHashMap<>(inbound);
        backwards.put("arrival", Map.of("local", "2026-11-10T07:00", "timeZone", "America/New_York"));
        assertEquals("invalid_transport_times", assertThrows(TravelError.class, () -> trips.saveConfirmedTransport(alice, trip, 4, "backwards", backwards)).code());
        var privateData = new java.util.LinkedHashMap<>(inbound); privateData.put("passport", "private");
        assertEquals("sensitive_trip_input_blocked", assertThrows(TravelError.class, () -> trips.saveConfirmedTransport(alice, trip, 4, "private", privateData)).code());
        var invalidPrice = new java.util.LinkedHashMap<>(inbound);
        invalidPrice.put("price", Map.of("amount", "1.1234567", "currency", "USD", "unit", "per_person", "taxes", "unknown", "coverage", "segment"));
        assertEquals("invalid_transport_price", assertThrows(TravelError.class, () -> trips.saveConfirmedTransport(alice, trip, 4, "invalid-price", invalidPrice)).code());
        assertEquals("revision_conflict", assertThrows(TravelError.class, () -> trips.removeConfirmedTransport(alice, trip, 3, "stale-flight", "outbound")).code());
        var removed = trips.removeConfirmedTransport(alice, trip, 4, "remove-outbound", "outbound");
        var remaining = (List<?>) ((Map<?, ?>) removed.get("state")).get("confirmedTransport");
        assertEquals(1, remaining.size());
        assertEquals("inbound", ((Map<?, ?>) remaining.get(0)).get("transportId"));
        assertEquals(5L, ((Number) trips.removeConfirmedTransport(alice, trip, 4, "remove-outbound", "outbound").get("revision")).longValue());
        jdbc.update("UPDATE travel_trips SET state=jsonb_set(state,'{nodes}', '[{\"nodeId\":\"keep-me\"}]'::jsonb) WHERE trip_id=?", trip);
        assertEquals("transport_change_needs_planning_rules", assertThrows(TravelError.class,
                () -> trips.removeConfirmedTransport(alice, trip, 5, "planned-flight-removal", "inbound")).code());
    }

    @Test
    void partialTransportBudgetPreservesCurrenciesUnitsAndUnknownCosts() {
        UUID alice = accounts.fromVerifiedGoogleSubject("partial-budget-owner", "Alice");
        UUID trip = UUID.fromString((String) trips.create(alice, "partial-budget-trip", Map.of("destination", "上海", "totalBudget", 300, "currency", "CNY")).get("tripId"));
        trips.upsertEmptyTripTraveler(alice, trip, 0, "partial-a", Map.of("travelerId", "a"));
        trips.upsertEmptyTripTraveler(alice, trip, 1, "partial-b", Map.of("travelerId", "b"));
        var first = Map.<String, Object>of("transportId", "first", "mode", "flight", "origin", "上海", "destination", "东京",
                "departure", Map.of("local", "2026-11-10T10:00", "timeZone", "Asia/Shanghai"), "arrival", Map.of("local", "2026-11-10T15:00", "timeZone", "Asia/Tokyo"),
                "travelerIds", List.of("a", "b"), "price", Map.of("amount", "123.450", "currency", "USD", "unit", "per_person", "taxes", "included", "coverage", "segment"));
        trips.saveConfirmedTransport(alice, trip, 2, "partial-first", first);
        var second = new java.util.LinkedHashMap<>(first); second.put("transportId", "second");
        second.put("price", Map.of("amount", "400.00", "currency", "CNY", "unit", "total", "taxes", "unknown", "coverage", "segment"));
        trips.saveConfirmedTransport(alice, trip, 3, "partial-second", second);
        var third = new java.util.LinkedHashMap<>(first); third.put("transportId", "third"); third.remove("price");
        var result = trips.saveConfirmedTransport(alice, trip, 4, "partial-third", third);
        var ledger = (Map<?, ?>) ((Map<?, ?>) result.get("state")).get("budgetLedger");
        var summary = (Map<?, ?>) ledger.get("recordedTransport");
        assertEquals(List.of(Map.of("currency", "CNY", "amount", "400"), Map.of("currency", "USD", "amount", "246.9")), summary.get("currencyTotals"));
        assertEquals(1, summary.get("missingPriceOrPassengers"));
        assertEquals(1, summary.get("uncertainTaxes"));
        assertEquals(List.of("USD"), summary.get("unconvertedCurrencies"));
        assertEquals("recorded_transport_exceeds_budget", summary.get("comparison"));
        var raised = trips.updateEmptyTripScope(alice, trip, 5, "partial-raise-budget", Map.of("totalBudget", 500));
        var updated = (Map<?, ?>) ((Map<?, ?>) ((Map<?, ?>) raised.get("state")).get("budgetLedger")).get("recordedTransport");
        assertEquals("incomplete", updated.get("comparison"));
        assertEquals(summary.get("currencyTotals"), updated.get("currencyTotals"));
        var noPassengers = new java.util.LinkedHashMap<>(first); noPassengers.put("transportId", "third"); noPassengers.put("travelerIds", List.of());
        var unknown = trips.saveConfirmedTransport(alice, trip, 6, "partial-no-passengers", noPassengers);
        var finalSummary = (Map<?, ?>) ((Map<?, ?>) ((Map<?, ?>) unknown.get("state")).get("budgetLedger")).get("recordedTransport");
        assertEquals(1, finalSummary.get("missingPriceOrPassengers"));
        assertEquals(summary.get("currencyTotals"), finalSummary.get("currencyTotals"));
        var shared = new java.util.LinkedHashMap<>(first); shared.put("transportId", "third");
        shared.put("price", Map.of("amount", "900.00", "currency", "CNY", "unit", "total", "taxes", "included", "coverage", "shared_or_unknown"));
        var sharedResult = trips.saveConfirmedTransport(alice, trip, 7, "partial-shared-price", shared);
        var sharedSummary = (Map<?, ?>) ((Map<?, ?>) ((Map<?, ?>) sharedResult.get("state")).get("budgetLedger")).get("recordedTransport");
        assertEquals(1, sharedSummary.get("sharedPrices"));
        assertEquals(summary.get("currencyTotals"), sharedSummary.get("currencyTotals"));
        assertEquals("incomplete", sharedSummary.get("comparison"));
    }

    @Test
    void overlappingTransportDistinguishesDifferentKnownPassengersFromUnknownOnes() {
        UUID alice = accounts.fromVerifiedGoogleSubject("overlap-owner", "Alice");
        UUID trip = UUID.fromString((String) trips.create(alice, "overlap-trip", Map.of("destination", "上海")).get("tripId"));
        trips.upsertEmptyTripTraveler(alice, trip, 0, "overlap-a", Map.of("travelerId", "a"));
        trips.upsertEmptyTripTraveler(alice, trip, 1, "overlap-b", Map.of("travelerId", "b"));
        var first = Map.<String, Object>of("transportId", "first", "mode", "train", "origin", "上海", "destination", "南京",
                "departure", Map.of("local", "2026-11-10T10:00", "timeZone", "Asia/Shanghai"),
                "arrival", Map.of("local", "2026-11-10T13:00", "timeZone", "Asia/Shanghai"), "travelerIds", List.of("a"));
        var second = Map.<String, Object>of("transportId", "second", "mode", "train", "origin", "上海", "destination", "杭州",
                "departure", Map.of("local", "2026-11-10T11:00", "timeZone", "Asia/Shanghai"),
                "arrival", Map.of("local", "2026-11-10T12:00", "timeZone", "Asia/Shanghai"), "travelerIds", List.of("b"));
        trips.saveConfirmedTransport(alice, trip, 2, "first-ride", first);
        var separate = trips.saveConfirmedTransport(alice, trip, 3, "second-ride", second);
        assertTrue(((List<?>) ((Map<?, ?>) separate.get("state")).get("transportOverlaps")).isEmpty());
        var samePassenger = new java.util.LinkedHashMap<>(second); samePassenger.put("travelerIds", List.of("a"));
        var conflicting = trips.saveConfirmedTransport(alice, trip, 4, "same-passenger", samePassenger);
        var issues = (List<?>) ((Map<?, ?>) conflicting.get("state")).get("transportOverlaps");
        assertEquals("transport_overlap", ((Map<?, ?>) issues.get(0)).get("code"));
        assertEquals(List.of("a"), ((Map<?, ?>) issues.get(0)).get("travelerIds"));
        var unknownPassenger = new java.util.LinkedHashMap<>(second); unknownPassenger.put("travelerIds", List.of());
        var possible = trips.saveConfirmedTransport(alice, trip, 5, "unknown-passenger", unknownPassenger);
        assertEquals("transport_overlap_passengers_unknown", ((Map<?, ?>) ((List<?>) ((Map<?, ?>) possible.get("state")).get("transportOverlaps")).get(0)).get("code"));
        var removed = trips.removeConfirmedTransport(alice, trip, 6, "remove-overlap", "second");
        assertTrue(((List<?>) ((Map<?, ?>) removed.get("state")).get("transportOverlaps")).isEmpty());
    }

    @Test
    void budgetAndTravelerRequirementsCanChangeWithoutRemovingRecordedBookings() {
        UUID alice = accounts.fromVerifiedGoogleSubject("booking-budget-owner", "Alice");
        UUID trip = UUID.fromString((String) trips.create(alice, "booking-budget-trip", Map.of("destination", "Tokyo")).get("tripId"));
        trips.upsertEmptyTripTraveler(alice, trip, 0, "booking-person", Map.of("travelerId", "a", "displayName", "同行人甲"));
        var transport = Map.<String, Object>of("transportId", "return", "mode", "train", "origin", "Tokyo", "destination", "Osaka",
                "departure", Map.of("local", "2026-11-10T10:00", "timeZone", "Asia/Tokyo"),
                "arrival", Map.of("local", "2026-11-10T13:00", "timeZone", "Asia/Tokyo"), "travelerIds", List.of("a"));
        trips.saveConfirmedTransport(alice, trip, 1, "booking-train", transport);
        var budget = trips.updateEmptyTripScope(alice, trip, 2, "booking-budget", Map.of("totalBudget", 5000, "currency", "JPY"));
        assertEquals(3L, budget.get("revision"));
        var traveler = trips.upsertEmptyTripTraveler(alice, trip, 3, "booking-care", Map.of("travelerId", "a", "careNeeds", Map.of("mobility", Map.of("stepFreeRequired", true))));
        var state = (Map<?, ?>) traveler.get("state");
        assertEquals("return", ((Map<?, ?>) ((List<?>) state.get("confirmedTransport")).get(0)).get("transportId"));
        assertTrue(state.get("travelers").toString().contains("stepFreeRequired=true"));
        assertEquals("traveler_used_by_transport", assertThrows(TravelError.class, () -> trips.removeEmptyTripTravelerRequirement(alice, trip, 4,
                "remove-booked-person", "a", Map.of("type", "traveler"))).code());
        var changedPassengers = new java.util.LinkedHashMap<>(transport); changedPassengers.put("travelerIds", List.of());
        trips.saveConfirmedTransport(alice, trip, 4, "booking-passengers", changedPassengers);
        var removed = trips.removeEmptyTripTravelerRequirement(alice, trip, 5, "remove-unassigned-person", "a", Map.of("type", "traveler"));
        var finalState = (Map<?, ?>) removed.get("state");
        assertTrue(((List<?>) finalState.get("travelers")).isEmpty());
        assertEquals(1, ((List<?>) finalState.get("confirmedTransport")).size());
        assertEquals(5000, ((Map<?, ?>) finalState.get("budgetLedger")).get("totalBudget"));
    }

    @Test
    void emptyTripBudgetCanBeSetAndClearedWithoutErasingOtherRequirements() {
        UUID alice = accounts.fromVerifiedGoogleSubject("budget-owner", "Alice");
        UUID trip = UUID.fromString((String) trips.create(alice, "budget-trip", Map.of("destination", "Tokyo", "origin", "Hong Kong")).get("tripId"));
        trips.upsertEmptyTripTraveler(alice, trip, 0, "budget-person", Map.of("travelerId", "a", "careNeeds", Map.of("food", Map.of("exclusions", List.of("花生")))));
        var budget = trips.updateEmptyTripScope(alice, trip, 1, "set-budget", Map.of("totalBudget", 5000.50, "currency", "JPY"));
        assertEquals(2L, budget.get("revision"));
        assertEquals(2L, ((Number) trips.updateEmptyTripScope(alice, trip, 1, "set-budget", Map.of("currency", "JPY", "totalBudget", 5000.50)).get("revision")).longValue());
        var changes = new java.util.LinkedHashMap<String, Object>(); changes.put("totalBudget", null);
        var cleared = trips.updateEmptyTripScope(alice, trip, 2, "clear-budget", changes);
        var state = (Map<?, ?>) cleared.get("state");
        assertNull(((Map<?, ?>) state.get("budgetLedger")).get("totalBudget"));
        assertEquals("JPY", ((Map<?, ?>) state.get("budgetLedger")).get("currency"));
        assertEquals("Hong Kong", ((Map<?, ?>) state.get("brief")).get("origin"));
        assertTrue(state.get("travelers").toString().contains("花生"));
        assertEquals("revision_conflict", assertThrows(TravelError.class,
                () -> trips.updateEmptyTripScope(alice, trip, 1, "stale-budget", Map.of("totalBudget", 2000))).code());
    }

    @Test
    void removingARequirementCannotAlterAnExistingPlanOrBypassViewerAccess() {
        UUID alice = accounts.fromVerifiedGoogleSubject("care-owner", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("care-viewer", "Bob");
        UUID trip = UUID.fromString((String) trips.create(alice, "care-trip", Map.of("destination", "Tokyo")).get("tripId"));
        trips.upsertEmptyTripTraveler(alice, trip, 0, "care-person", Map.of("travelerId", "a", "careNeeds", Map.of("mobility", Map.of("stepFreeRequired", true))));
        trips.grant(alice, trip, bob, "viewer", 0, "care-share");
        var target = Map.<String, Object>of("type", "care", "group", "mobility", "field", "stepFreeRequired");
        assertEquals("trip_not_found", assertThrows(TravelError.class,
                () -> trips.removeEmptyTripTravelerRequirement(bob, trip, 1, "viewer-remove", "a", target)).code());
        jdbc.update("UPDATE travel_trips SET state=jsonb_set(state,'{nodes}', '[{\"nodeId\":\"keep-me\"}]'::jsonb) WHERE trip_id=?", trip);
        assertEquals("scope_change_needs_planning_rules", assertThrows(TravelError.class,
                () -> trips.removeEmptyTripTravelerRequirement(alice, trip, 1, "planned-remove", "a", target)).code());
        var unchanged = trips.get(alice, trip);
        assertTrue(unchanged.toString().contains("keep-me"));
        assertTrue(unchanged.toString().contains("stepFreeRequired=true"));
    }

    @Test
    void sourceReferencesFollowTripPermissionVersionAndExpiry() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("bob-subject", "Bob");
        UUID trip = UUID.fromString((String) trips.create(alice, "new", Map.of("destination", "上海", "countryCode", "CN")).get("tripId"));
        var references = new TravelResults(jdbc, new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource())));
        Instant checked = Instant.now();
        var source = Map.<String, Object>of("status", "completed", "provider", "amap_weather", "coverage", "covered",
                "checkedAt", checked.toString(), "freshUntil", checked.plusSeconds(3600).toString(), "forecastDays", List.of());
        UUID reference = UUID.fromString((String) references.saveWeather(alice, trip, 0, source).get("resultId"));
        assertEquals("result_not_found", assertThrows(TravelError.class, () -> references.read(bob, reference)).code());
        trips.grant(alice, trip, bob, "viewer", 0, "share");
        assertEquals(false, references.read(bob, reference).get("stale"));
        trips.updateEmptyTripScope(alice, trip, 0, "new-date", Map.of("dates", "2026-11-08"));
        assertEquals(true, references.read(bob, reference).get("stale"));
        assertEquals("revision_conflict", assertThrows(TravelError.class, () -> references.saveWeather(alice, trip, 0, source)).code());
        jdbc.update("UPDATE travel_result_references SET fresh_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE result_id=?", reference);
        var expired = references.read(bob, reference);
        assertEquals(true, expired.get("expired"));
        assertNull(expired.get("data"));
        trips.revoke(alice, trip, bob, 1, "unshare");
        assertEquals("result_not_found", assertThrows(TravelError.class, () -> references.read(bob, reference)).code());
    }

    @Test
    void takeoverFencesTheWorkerAndSupersededRequirementsDoNotRestartOldWork() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        UUID trip = UUID.fromString((String) trips.create(alice, "new", Map.of("destination", "上海")).get("tripId"));
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var tasks = new TravelTasks(jdbc, tx, true, 2, 1, 10, new TravelItineraryDrafts(jdbc, tx, new TravelResults(jdbc, tx)));
        UUID task = UUID.fromString((String) tasks.submit(alice, trip, 0, "task-1", "比较这趟旅行的选择").get("taskId"));
        assertEquals(task.toString(), tasks.submit(alice, trip, 0, "task-1", "比较这趟旅行的选择").get("taskId"));
        assertEquals("request_id_conflict", assertThrows(TravelError.class, () -> tasks.submit(alice, trip, 0, "task-1", "另一个要求")).code());
        var claim = tasks.claim();
        assertEquals("running", claim.get("status"));
        UUID lease = UUID.fromString((String) claim.get("leaseId"));
        long generation = ((Number) claim.get("generation")).longValue();
        tasks.checkpoint(task, generation, lease, Map.of("progress", "已读取旅行"));
        var paused = tasks.takeOver(alice, task, 0, "take-over");
        assertEquals("paused", paused.get("status"));
        assertEquals("stale_execution", assertThrows(TravelError.class, () -> tasks.checkpoint(task, generation, lease, Map.of("progress", "迟到"))).code());
        trips.updateEmptyTripScope(alice, trip, 0, "new-scope", Map.of("totalBudget", 4000));
        assertEquals("superseded", tasks.handBack(alice, task, 1, "hand-back").get("status"));
        assertEquals("empty", tasks.claim().get("status"));
        assertEquals(1L, trips.get(alice, trip).get("revision"));
    }

    @Test
    void queueLimitsAndRevocationProtectWorkerAndTripState() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("bob-subject", "Bob");
        UUID trip = UUID.fromString((String) trips.create(alice, "new", Map.of("destination", "上海")).get("tripId"));
        trips.grant(alice, trip, bob, "editor", 0, "share-edit");
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var disabled = new TravelTasks(jdbc, tx, false, 2, 1, 10, new TravelItineraryDrafts(jdbc, tx, new TravelResults(jdbc, tx)));
        assertEquals("background_executor_not_configured", assertThrows(TravelError.class, () -> disabled.submit(bob, trip, 0, "off", "规划旅行")).code());
        var tasks = new TravelTasks(jdbc, tx, true, 2, 1, 10, new TravelItineraryDrafts(jdbc, tx, new TravelResults(jdbc, tx)));
        tasks.submit(bob, trip, 0, "one", "规划旅行");
        tasks.submit(bob, trip, 0, "two", "比较路线");
        var claimed = tasks.claim();
        UUID first = UUID.fromString((String) claimed.get("taskId"));
        UUID lease = UUID.fromString((String) claimed.get("leaseId"));
        long generation = ((Number) claimed.get("generation")).longValue();
        assertEquals("empty", tasks.claim().get("status"));
        assertEquals("source_evidence_required", assertThrows(TravelError.class,
                () -> tasks.finish(first, generation, lease, Map.of("kind", "suggestion", "summary", "建议", "evidenceIds", List.of(), "unknowns", List.of()))).code());
        trips.revoke(alice, trip, bob, 1, "revoke");
        assertEquals("cancelled", tasks.get(alice, first).get("status"));
        assertEquals("stale_execution", assertThrows(TravelError.class, () -> tasks.checkpoint(first, generation, lease, Map.of("progress", "late"))).code());
        assertEquals("task_not_found", assertThrows(TravelError.class, () -> tasks.get(bob, first)).code());
        assertEquals("task_not_found", assertThrows(TravelError.class, () -> tasks.submit(bob, trip, 0, "one", "规划旅行")).code());
        assertEquals(0L, trips.get(alice, trip).get("revision"));
    }

    @Test
    void expiredLeaseIsReclaimedWithoutAcceptingItsLateResult() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        UUID trip = UUID.fromString((String) trips.create(alice, "new", Map.of("destination", "上海")).get("tripId"));
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var tasks = new TravelTasks(jdbc, tx, true, 2, 2, 10, new TravelItineraryDrafts(jdbc, tx, new TravelResults(jdbc, tx)));
        UUID task = UUID.fromString((String) tasks.submit(alice, trip, 0, "one", "规划旅行").get("taskId"));
        var first = tasks.claim();
        UUID oldLease = UUID.fromString((String) first.get("leaseId"));
        long oldGeneration = ((Number) first.get("generation")).longValue();
        jdbc.update("UPDATE travel_planning_tasks SET lease_until=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE task_id=?", task);
        assertEquals("recovering", tasks.get(alice, task).get("status"));
        var second = tasks.claim();
        UUID newLease = UUID.fromString((String) second.get("leaseId"));
        long newGeneration = ((Number) second.get("generation")).longValue();
        assertTrue(newGeneration > oldGeneration);
        assertEquals("stale_execution", assertThrows(TravelError.class, () -> tasks.checkpoint(task, oldGeneration, oldLease, Map.of("progress", "late"))).code());
        var result = tasks.finish(task, newGeneration, newLease, Map.of("kind", "needs_context", "summary", "需要更多旅行资料", "evidenceIds", List.of(), "unknowns", List.of("日期")));
        assertEquals("needs_context", result.get("status"));
        assertEquals(0L, trips.get(alice, trip).get("revision"));
    }

    @Test
    void simultaneousClaimsRespectClusterCapacity() throws Exception {
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var tasks = new TravelTasks(jdbc, tx, true, 2, 2, 10, new TravelItineraryDrafts(jdbc, tx, new TravelResults(jdbc, tx)));
        for (int i = 0; i < 4; i++) {
            UUID actor = accounts.fromVerifiedGoogleSubject("claim-subject-" + i, "Traveler");
            UUID trip = UUID.fromString((String) trips.create(actor, "trip", Map.of("destination", "上海")).get("tripId"));
            tasks.submit(actor, trip, 0, "task", "规划旅行");
        }
        var start = new CountDownLatch(1);
        var executor = Executors.newFixedThreadPool(8);
        try {
            var calls = new ArrayList<java.util.concurrent.Future<Map<String, Object>>>();
            for (int i = 0; i < 8; i++) calls.add(executor.submit(() -> { start.await(); return tasks.claim(); }));
            start.countDown();
            var statuses = new ArrayList<Object>();
            for (var call : calls) statuses.add(call.get(20, TimeUnit.SECONDS).get("status"));
            assertEquals(2, statuses.stream().filter("running"::equals).count());
            assertEquals(6, statuses.stream().filter("capacity_full"::equals).count());
        } finally { executor.shutdownNow(); }
    }

    @Test
    void workbenchLayoutHasItsOwnVersionAndProtectsUserEditedComponents() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("bob-subject", "Bob");
        UUID trip = UUID.fromString((String) trips.create(alice, "new", Map.of("destination", "上海")).get("tripId"));
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var layouts = new WorkbenchDocuments(jdbc, tx);
        assertEquals(0L, layouts.get(alice, trip).get("layoutRevision"));
        trips.grant(alice, trip, bob, "viewer", 0, "share");
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> layouts.compose(bob, trip, 0, 0, "viewer-layout", List.of("itinerary", "map"))).code());
        var changed = layouts.compose(alice, trip, 0, 0, "layout", List.of("itinerary", "map"));
        assertEquals(1L, changed.get("layoutRevision"));
        assertEquals(1L, ((Number) layouts.compose(alice, trip, 0, 0, "layout", List.of("itinerary", "map")).get("layoutRevision")).longValue());
        assertEquals("layout_revision_conflict", assertThrows(TravelError.class,
                () -> layouts.compose(alice, trip, 0, 0, "old-layout", List.of("itinerary", "map", "requirements"))).code());
        assertEquals("invalid_component_layout", assertThrows(TravelError.class,
                () -> layouts.compose(alice, trip, 0, 1, "bad-layout", List.of("itinerary", "unregistered"))).code());
        layouts.compose(alice, trip, 0, 1, "restore", List.of("itinerary", "map", "requirements"));
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> layouts.userEdit(bob, trip, 0, 2, "viewer-pin", "pin")).code());
        assertEquals(3L, layouts.userEdit(alice, trip, 0, 2, "pin", "pin").get("layoutRevision"));
        assertEquals("protected_component", assertThrows(TravelError.class,
                () -> layouts.compose(alice, trip, 0, 3, "remove-user-component", List.of("itinerary", "map"))).code());
        assertEquals(4L, layouts.userEdit(alice, trip, 0, 3, "hide", "hide").get("layoutRevision"));
        assertEquals("protected_component", assertThrows(TravelError.class,
                () -> layouts.compose(alice, trip, 0, 4, "readd-user-component", List.of("itinerary", "map", "requirements"))).code());
        assertEquals(5L, layouts.userEdit(alice, trip, 0, 4, "show", "show").get("layoutRevision"));
        assertEquals(0L, trips.get(alice, trip).get("revision"));
    }

    @Test
    void composingCannotDropAnUnsupportedVersionOfAKnownComponent() {
        UUID actor = accounts.fromVerifiedGoogleSubject("future-layout", "Traveler");
        UUID trip = UUID.fromString((String) trips.create(actor, "future-trip", Map.of("destination", "上海")).get("tripId"));
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var layouts = new WorkbenchDocuments(jdbc, tx);
        layouts.get(actor, trip);
        jdbc.update("UPDATE travel_workbench_documents SET document=jsonb_set(document,'{components,2,version}','2'::jsonb) WHERE trip_id=?", trip);
        String before = jdbc.queryForObject("SELECT document::text FROM travel_workbench_documents WHERE trip_id=?", String.class, trip);
        assertEquals("unsupported_component_preserved", assertThrows(TravelError.class,
                () -> layouts.compose(actor, trip, 0, 0, "future-compose", List.of("itinerary", "map"))).code());
        assertEquals(before, jdbc.queryForObject("SELECT document::text FROM travel_workbench_documents WHERE trip_id=?", String.class, trip));
        assertEquals(0L, layouts.get(actor, trip).get("layoutRevision"));
    }

    @Test
    void presentingCannotRewriteAnUnsupportedPlaceComponentVersion() {
        UUID actor = accounts.fromVerifiedGoogleSubject("future-places", "Traveler");
        UUID trip = UUID.fromString((String) trips.create(actor, "future-places-trip", Map.of("destination", "上海")).get("tripId"));
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        var layouts = new WorkbenchDocuments(jdbc, tx);
        var results = new TravelResults(jdbc, tx);
        var now = Instant.now();
        var data = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", now.toString(),
                "freshUntil", now.plusSeconds(1200).toString(), "domain", "play", "candidates", List.of(Map.of("sourceId", "place", "name", "地点", "domain", "play")));
        UUID first = UUID.fromString((String) results.savePlaces(actor, trip, 0, data).get("resultId"));
        UUID second = UUID.fromString((String) results.savePlaces(actor, trip, 0, data).get("resultId"));
        var shown = layouts.presentPlaces(actor, trip, 0, 0, "first-place", first);
        var components = (List<?>) ((Map<?, ?>) shown.get("document")).get("components");
        assertEquals(1, ((Map<?, ?>) components.get(3)).get("version"));
        jdbc.update("UPDATE travel_workbench_documents SET document=jsonb_set(document,'{components,3,version}','2'::jsonb) WHERE trip_id=?", trip);
        String before = jdbc.queryForObject("SELECT document::text FROM travel_workbench_documents WHERE trip_id=?", String.class, trip);
        assertEquals("unsupported_component_preserved", assertThrows(TravelError.class,
                () -> layouts.presentPlaces(actor, trip, 0, 1, "future-place", second)).code());
        assertEquals(before, jdbc.queryForObject("SELECT document::text FROM travel_workbench_documents WHERE trip_id=?", String.class, trip));
        assertEquals(1L, layouts.get(actor, trip).get("layoutRevision"));
        jdbc.update("UPDATE travel_workbench_documents SET document=jsonb_set(document,'{pendingPlaceResults}',CAST(? AS jsonb)) WHERE trip_id=?",
                "[\"" + second + "\"]", trip);
        String withPending = jdbc.queryForObject("SELECT document::text FROM travel_workbench_documents WHERE trip_id=?", String.class, trip);
        assertEquals("unsupported_component_preserved", assertThrows(TravelError.class,
                () -> layouts.decidePlaces(actor, trip, 0, 1, "future-accept", second, "accept")).code());
        assertEquals(withPending, jdbc.queryForObject("SELECT document::text FROM travel_workbench_documents WHERE trip_id=?", String.class, trip));
    }

    @Test
    void tripListingPaginatesWithoutSilentlyDroppingOlderTrips() {
        UUID alice = accounts.fromVerifiedGoogleSubject("alice-subject", "Alice");
        jdbc.update("INSERT INTO travel_trips(trip_id, owner_id, state) SELECT gen_random_uuid(), ?, '{}'::jsonb FROM generate_series(1,105)", alice);
        jdbc.update("INSERT INTO travel_trip_access(trip_id, account_id, role) SELECT trip_id, owner_id, 'owner' FROM travel_trips WHERE owner_id=?", alice);
        var first = trips.list(alice, 100, null, null);
        assertEquals(100, ((List<?>) first.get("items")).size());
        var cursor = (Map<?, ?>) first.get("nextCursor");
        var second = trips.list(alice, 100, Instant.parse((String) cursor.get("updatedAt")), UUID.fromString((String) cursor.get("tripId")));
        assertEquals(5, ((List<?>) second.get("items")).size());
        assertNull(second.get("nextCursor"));
    }
}
