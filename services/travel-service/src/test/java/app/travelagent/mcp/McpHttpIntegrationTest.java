package app.travelagent.mcp;

import static org.junit.jupiter.api.Assertions.*;

import app.travelagent.auth.OAuthGrants;
import app.travelagent.auth.OAuthSettings;
import app.travelagent.auth.GoogleIdentityClient;
import app.travelagent.core.TravelAccounts;
import app.travelagent.core.TravelJournal;
import app.travelagent.core.TravelError;
import app.travelagent.provider.AmapWeatherClient;
import app.travelagent.provider.AmapPlaceClient;
import app.travelagent.provider.AmapWalkingRouteClient;
import app.travelagent.provider.CiriumFlightStatusClient;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.web.util.UriComponentsBuilder;
import reactor.core.publisher.Mono;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Real HTTP and PostgreSQL; identities are deliberately test identities, not Google login. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class McpHttpIntegrationTest {
    private static final EmbeddedPostgres POSTGRES = database();
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final String REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
    private static final String WORKER_TOKEN = "w".repeat(43);
    private final HttpClient http = HttpClient.newHttpClient();

    @LocalServerPort int port;
    @Autowired OAuthGrants grants;
    @Autowired OAuthSettings settings;
    @Autowired TravelAccounts accounts;
    @Autowired TravelJournal journal;
    @Autowired org.springframework.jdbc.core.JdbcTemplate jdbc;
    @Autowired app.travelagent.core.TravelRiskFollowUps followUps;
    @Autowired WorkbenchUiAssets uiAssets;
    @MockitoBean GoogleIdentityClient google;
    @MockitoSpyBean AmapWeatherClient weather;
    @MockitoSpyBean AmapPlaceClient places;
    @MockitoSpyBean AmapWalkingRouteClient walking;
    @MockitoSpyBean CiriumFlightStatusClient flightStatus;

    private static EmbeddedPostgres database() {
        try { return EmbeddedPostgres.builder().setPort(0).start(); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry properties) {
        properties.add("spring.datasource.url", () -> POSTGRES.getJdbcUrl("postgres", "postgres"));
        properties.add("spring.datasource.username", () -> "postgres");
        properties.add("spring.datasource.password", () -> "");
        properties.add("TRAVEL_PUBLIC_ORIGIN", () -> "https://travel.example.com");
        properties.add("TRAVEL_MCP_REDIRECT_URIS", () -> REDIRECT + ",http://127.0.0.1:4321/callback/registered");
        properties.add("TRAVEL_MCP_ALLOWED_HOSTS", () -> "127.0.0.1");
        properties.add("TRAVEL_FOLLOW_UP_SCHEDULER_ENABLED", () -> "false");
        properties.add("TRAVEL_BACKGROUND_WORKER_ENABLED", () -> "true");
        properties.add("TRAVEL_WORKER_TOKEN", () -> WORKER_TOKEN);
    }

    @AfterAll static void stopDatabase() throws Exception { POSTGRES.close(); }

    @Test
    @org.junit.jupiter.api.condition.EnabledIfSystemProperty(named="travel.browser.fixture", matches="true")
    void manualTentativeWorkbenchWithRealService() throws Exception {
        assertTrue(uiAssets.available());
        UUID actor=accounts.fromVerifiedGoogleSubject("browser-tentative-owner","隔离测试账号");
        String access=token(actor,"travel:read travel:write"), date=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).plusDays(1).toString();
        String trip=call(access,"create_travel_workspace",Map.of("requestId","browser-trip","brief",Map.of("destination","上海市","countryCode","CN","dates",date,"totalBudget",1200,"currency","CNY")))
                .path("structuredContent").path("tripId").asString();
        var now=java.time.Instant.now();
        var source=Map.<String,Object>of("status","completed","provider","amap_places","coverage","page","checkedAt",now.toString(),"freshUntil",now.plusSeconds(1800).toString(),
                "domain","play","candidates",List.of(Map.of("sourceId","browser-place","name","隔离测试地点（合成资料）","domain","play")));
        org.mockito.Mockito.doReturn(Mono.just(source)).when(places).search(org.mockito.ArgumentMatchers.anyMap(),org.mockito.ArgumentMatchers.eq("play"),org.mockito.ArgumentMatchers.eq(""),org.mockito.ArgumentMatchers.eq(1),org.mockito.ArgumentMatchers.eq(10));
        String result=call(access,"search_trip_places",Map.of("tripId",trip,"domain","play")).path("structuredContent").path("resultId").asString();
        call(access,"stage_trip_itinerary",Map.of("tripId",trip,"expectedRevision",0,"requestId","browser-draft","stops",List.of(Map.of("stopId","visit-1","sourceResultId",result,"sourceId","browser-place","role","activity","startLocal",date+"T10:00","timeZone","Asia/Shanghai","durationMinutes",60))));
        var directory=java.nio.file.Files.createTempDirectory("travel-service-browser-");
        var connection=directory.resolve("connection.json");
        java.nio.file.Files.createFile(connection,java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")));
        java.nio.file.Files.writeString(connection,JSON.writeValueAsString(Map.of("format","travel-service-browser-fixture-v1","mcpUrl","http://127.0.0.1:"+port+"/mcp","bearer",access,"tripId",trip,"uiUri",uiAssets.page("codex").uri())));
        System.out.println("TRAVEL_SERVICE_BROWSER_CONNECTION="+connection);
        long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.MINUTES.toNanos(12);
        try {
            while(!java.nio.file.Files.exists(directory.resolve("stop")) && System.nanoTime()<deadline) {
                var command=directory.resolve("command.json");
                if(java.nio.file.Files.exists(command)) {
                    var instruction=JSON.readTree(java.nio.file.Files.readString(command));
                    String action=instruction.path("action").asString();
                    if(!Set.of("baseline","rain").contains(action)) throw new IllegalStateException("invalid_fixture_action");
                    assertTrue(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM travel_risk_follow_ups WHERE trip_id=?)",Boolean.class,UUID.fromString(trip)),"Adopt the itinerary before injecting weather");
                    var checked=java.time.Instant.now();
                    var forecast=Map.<String,Object>of("status","completed","provider","amap_weather","coverage","covered","checkedAt",checked.toString(),"freshUntil",checked.plusSeconds(7200).toString(),
                            "requestedDates",List.of(date),"forecastDays",List.of(Map.of("date",date,"dayCondition",action.equals("rain") ? "雨" : "晴","nightCondition",action.equals("rain") ? "雨" : "晴","highC",20,"lowC",10)));
                    org.mockito.Mockito.doReturn(Mono.just(forecast)).when(weather).forecast(org.mockito.ArgumentMatchers.anyMap());
                    jdbc.update("UPDATE travel_risk_follow_ups SET next_check_at=CURRENT_TIMESTAMP WHERE trip_id=?",UUID.fromString(trip));
                    followUps.checkDue();
                    java.nio.file.Files.writeString(directory.resolve("result.json"),JSON.writeValueAsString(Map.of("id",instruction.path("id").asString(),"ok",true)));
                    java.nio.file.Files.delete(command);
                }
                Thread.sleep(100);
            }
            var adopted=call(access,"get_travel_workspace",Map.of("tripId",trip)).path("structuredContent").path("state").path("planning").path("adopted");
            assertEquals("tentative",adopted.path("status").asString());
            assertEquals(1,jdbc.queryForObject("SELECT count(*) FROM travel_risk_changes WHERE trip_id=?",Integer.class,UUID.fromString(trip)));
        } finally {
            try(var files=java.nio.file.Files.list(directory)) { for(var file:files.toList()) java.nio.file.Files.deleteIfExists(file); }
            java.nio.file.Files.deleteIfExists(directory);
        }
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledIfSystemProperty(named="travel.media.fixture", matches="true")
    void manualJournalWorkbenchWithRealService() throws Exception {
        assertTrue(uiAssets.available());
        UUID actor=accounts.fromVerifiedGoogleSubject("browser-media-owner","隔离测试拥有者","owner@example.com",false);
        String access=token(actor,"travel:read travel:write"), date=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).plusDays(1).toString();
        String trip=call(access,"create_travel_workspace",Map.of("requestId","browser-trip","brief",Map.of("destination","上海市","countryCode","CN","dates",date,"totalBudget",1200,"currency","CNY")))
                .path("structuredContent").path("tripId").asString();
        var now=java.time.Instant.now();
        var source=Map.<String,Object>of("status","completed","provider","amap_places","coverage","page","checkedAt",now.toString(),"freshUntil",now.plusSeconds(1800).toString(),
                "domain","play","candidates",List.of(Map.of("sourceId","browser-place","name","隔离测试地点（合成资料）","domain","play")));
        org.mockito.Mockito.doReturn(Mono.just(source)).when(places).search(org.mockito.ArgumentMatchers.anyMap(),org.mockito.ArgumentMatchers.eq("play"),org.mockito.ArgumentMatchers.eq(""),org.mockito.ArgumentMatchers.eq(1),org.mockito.ArgumentMatchers.eq(10));
        String result=call(access,"search_trip_places",Map.of("tripId",trip,"domain","play")).path("structuredContent").path("resultId").asString();
        call(access,"stage_trip_itinerary",Map.of("tripId",trip,"expectedRevision",0,"requestId","browser-draft","stops",List.of(Map.of("stopId","visit-1","sourceResultId",result,"sourceId","browser-place","role","activity","startLocal",date+"T10:00","timeZone","Asia/Shanghai","durationMinutes",60))));
        UUID peer=accounts.fromVerifiedGoogleSubject("browser-media-peer","测试同行人","chen@example.com",false);
        String peerAccess=token(peer,"travel:read travel:write");
        var directory=java.nio.file.Files.createTempDirectory("travel-service-browser-");
        var connection=directory.resolve("connection.json");
        java.nio.file.Files.createFile(connection,java.nio.file.attribute.PosixFilePermissions.asFileAttribute(java.nio.file.attribute.PosixFilePermissions.fromString("rw-------")));
        java.nio.file.Files.writeString(connection,JSON.writeValueAsString(Map.of("format","travel-service-browser-fixture-v1","mcpUrl","http://127.0.0.1:"+port+"/mcp","bearer",access,"peerBearer",peerAccess,"tripId",trip,"uiUri",uiAssets.page("codex").uri())));
        System.out.println("TRAVEL_SERVICE_BROWSER_CONNECTION="+connection);
        long deadline=System.nanoTime()+java.util.concurrent.TimeUnit.MINUTES.toNanos(45);
        try {
            while(!java.nio.file.Files.exists(directory.resolve("stop")) && System.nanoTime()<deadline) Thread.sleep(100);
        } finally {
            try(var files=java.nio.file.Files.list(directory)) { for(var file:files.toList()) java.nio.file.Files.deleteIfExists(file); }
            java.nio.file.Files.deleteIfExists(directory);
        }
    }

    @Test
    void humanReviewedTentativeAdoptionAndFollowUpPersistThroughTheMcpHttpEntry() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(uiAssets.available(), "workbench tools need a UI build");
        UUID actor=accounts.fromVerifiedGoogleSubject("tentative-http-owner","Owner"), other=accounts.fromVerifiedGoogleSubject("tentative-http-other","Other");
        String owner=token(actor,"travel:read travel:write"), outsider=token(other,"travel:read travel:write");
        String date=java.time.LocalDate.now(java.time.ZoneId.of("Asia/Shanghai")).plusDays(1).toString();
        String trip=call(owner,"create_travel_workspace",Map.of("requestId","tentative-http-trip","brief",Map.of("destination","上海市","countryCode","CN","dates",date)))
                .path("structuredContent").path("tripId").asString();
        var now=java.time.Instant.now();
        var source=Map.<String,Object>of("status","completed","provider","amap_places","coverage","page","checkedAt",now.toString(),"freshUntil",now.plusSeconds(1200).toString(),
                "domain","play","candidates",List.of(Map.of("sourceId","http-place","name","协议测试地点","domain","play")));
        org.mockito.Mockito.doReturn(Mono.just(source)).when(places).search(org.mockito.ArgumentMatchers.anyMap(),org.mockito.ArgumentMatchers.eq("play"),org.mockito.ArgumentMatchers.eq(""),org.mockito.ArgumentMatchers.eq(1),org.mockito.ArgumentMatchers.eq(10));
        String result=call(owner,"search_trip_places",Map.of("tripId",trip,"domain","play")).path("structuredContent").path("resultId").asString();
        String draft=call(owner,"stage_trip_itinerary",Map.of("tripId",trip,"expectedRevision",0,"requestId","tentative-http-draft","stops",List.of(Map.of("stopId","visit-1","sourceResultId",result,"sourceId","http-place",
                "role","activity","startLocal",date+"T10:00","timeZone","Asia/Shanghai","durationMinutes",60)))).path("structuredContent").path("draftId").asString();
        var review=call(owner,"verify_trip_itinerary_draft",Map.of("tripId",trip,"draftId",draft,"expectedRevision",0,"expectedDraftRevision",0)).path("structuredContent");
        assertTrue(review.path("canAdoptTentatively").asBoolean()); assertFalse(review.path("canAdopt").asBoolean());
        assertTrue(review.path("reviewState").isMissingNode(),"The assistant's verifier must not receive private checkbox progress");
        var reviewArgs=Map.<String,Object>of("tripId",trip,"draftId",draft,"expectedRevision",0,"expectedDraftRevision",0);
        var cloud=call(owner,"get_trip_itinerary_review",reviewArgs).path("structuredContent");
        assertEquals(0,cloud.path("reviewState").path("revision").asInt(-1),"A new workbench must read its account's saved review progress");
        var acknowledgments=new java.util.ArrayList<String>(); for(var item:review.path("requiredAcknowledgments")) acknowledgments.add(item.asString());
        var command=new java.util.LinkedHashMap<String,Object>(Map.of("tripId",trip,"draftId",draft,"expectedRevision",0,"expectedDraftRevision",0,"reviewDigest",review.path("reviewDigest").asString(),
                "acknowledgments",acknowledgments,"riskFollowUpConsent",true,"requestId","tentative-http-adopt"));
        assertEquals("trip_not_found",call(outsider,"adopt_tentative_trip_itinerary",command).path("structuredContent").path("code").asString());
        var incomplete=new java.util.LinkedHashMap<>(command); incomplete.put("acknowledgments",List.of()); incomplete.put("requestId","tentative-http-incomplete");
        assertEquals("adoption_acknowledgments_required",call(owner,"adopt_tentative_trip_itinerary",incomplete).path("structuredContent").path("code").asString());
        assertEquals("adoption_acknowledgments_not_saved",call(owner,"adopt_tentative_trip_itinerary",command).path("structuredContent").path("code").asString());
        long reviewRevision=0;
        for(var check:cloud.path("checks")) if(acknowledgments.contains(check.path("id").asString())) {
            cloud=call(owner,"save_trip_itinerary_review_condition",Map.of("tripId",trip,"draftId",draft,"expectedRevision",0,"expectedDraftRevision",0,
                    "expectedReviewRevision",reviewRevision,"checkId",check.path("id").asString(),"basisDigest",check.path("basisDigest").asString(),
                    "acknowledged",true,"requestId","http-ack-"+reviewRevision)).path("structuredContent");
            assertEquals(++reviewRevision,cloud.path("reviewState").path("revision").asLong(-1));
        }
        var reopenedReview=call(token(actor,"travel:read travel:write"),"get_trip_itinerary_review",reviewArgs).path("structuredContent");
        assertEquals(acknowledgments.size(),reopenedReview.path("reviewState").path("acknowledgedCheckIds").size());
        assertEquals("trip_not_found",call(outsider,"get_trip_itinerary_review",reviewArgs).path("structuredContent").path("code").asString());
        assertEquals(1,call(owner,"adopt_tentative_trip_itinerary",command).path("structuredContent").path("revision").asInt());
        assertEquals(1,call(owner,"adopt_tentative_trip_itinerary",command).path("structuredContent").path("revision").asInt());
        var reopened=call(owner,"get_travel_workspace",Map.of("tripId",trip)).path("structuredContent").path("state").path("planning").path("adopted");
        assertEquals("tentative",reopened.path("status").asString()); assertEquals(1,reopened.path("stops").size());
        assertEquals(acknowledgments.size(),reopened.path("acknowledgedCheckIds").size());
        var tracking=call(owner,"get_trip_follow_up",Map.of("tripId",trip)).path("structuredContent");
        assertTrue(tracking.path("enabled").asBoolean()); assertEquals("pending",tracking.path("weather").path("status").asString());
        org.mockito.Mockito.doReturn(Mono.just(Map.of("status","provider_unavailable","reason","test_source_disabled"))).when(weather).forecast(org.mockito.ArgumentMatchers.anyMap());
        followUps.checkDue();
        assertEquals("provider_unavailable",call(owner,"get_trip_follow_up",Map.of("tripId",trip)).path("structuredContent").path("weather").path("status").asString());
        assertFalse(call(owner,"set_trip_follow_up",Map.of("tripId",trip,"expectedRevision",1,"expectedFollowUpRevision",0,"enabled",false,"requestId","tentative-http-pause"))
                .path("structuredContent").path("enabled").asBoolean());
        var listed=JSON.readTree(request(owner,null,Map.of("jsonrpc","2.0","id",99,"method","tools/list")).body());
        JsonNode tool=null; for(var item:listed.path("result").path("tools")) if("adopt_tentative_trip_itinerary".equals(item.path("name").asString())) tool=item;
        assertNotNull(tool); assertEquals("app",tool.path("_meta").path("ui").path("visibility").get(0).asString());
    }

    @Test
    void httpCallsEnforceAuthenticationScopeAndCurrentTripPermission() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("mcp-test-alice", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("mcp-test-bob", "Bob");
        String aliceToken = token(alice, "travel:read travel:write");
        String bobToken = token(bob, "travel:read");

        var unauthenticated = request(null, null, Map.of("jsonrpc", "2.0", "id", 1, "method", "tools/list"));
        assertEquals(401, unauthenticated.statusCode());
        assertTrue(unauthenticated.headers().firstValue("WWW-Authenticate").orElse("").contains("oauth-protected-resource"));
        assertEquals(403, request(aliceToken, "https://attacker.example", Map.of("jsonrpc", "2.0", "id", 1, "method", "tools/list")).statusCode());

        var initialized = request(aliceToken, null, Map.of("jsonrpc", "2.0", "id", 1, "method", "initialize", "params",
                Map.of("protocolVersion", "2025-11-25", "capabilities", Map.of(), "clientInfo", Map.of("name", "isolated-test", "version", "1"))));
        assertEquals(200, initialized.statusCode());
        var listed = JSON.readTree(request(aliceToken, null, Map.of("jsonrpc", "2.0", "id", 2, "method", "tools/list")).body());
        JsonNode workbench = null;
        JsonNode standardWorkbench = null;
        JsonNode editComponent = null;
        for (JsonNode tool : listed.path("result").path("tools")) if ("open_travel_workbench".equals(tool.path("name").asString())) workbench = tool;
        for (JsonNode tool : listed.path("result").path("tools")) if ("open_travel_mcp_workbench".equals(tool.path("name").asString())) standardWorkbench = tool;
        for (JsonNode tool : listed.path("result").path("tools")) if ("edit_workbench_component".equals(tool.path("name").asString())) editComponent = tool;
        if (workbench == null) assertFalse(Boolean.getBoolean("travel.ui.required"), "build the workbench before requiring the UI integration");
        else {
            String uiUri = workbench.path("_meta").path("ui").path("resourceUri").asString();
            assertTrue(uiUri.matches("ui://travel/workbench/[0-9.]+/codex/[0-9a-f]{16}\\.html"));
            assertNotNull(standardWorkbench);
            String standardUri = standardWorkbench.path("_meta").path("ui").path("resourceUri").asString();
            assertTrue(standardUri.matches("ui://travel/workbench/[0-9.]+/mcp/[0-9a-f]{16}\\.html"));
            assertFalse(standardWorkbench.path("_meta").has("openai/ui"));
            assertNotEquals(uiUri, standardUri);
            assertTrue(JSON.readTree(request(aliceToken, null, Map.of("jsonrpc", "2.0", "id", 30, "method", "resources/read", "params", Map.of("uri", standardUri))).body())
                    .path("result").path("contents").get(0).path("text").asString().contains("Travel Agent"));
            var entrypoints = workbench.path("_meta").path("openai/ui").path("entrypoints");
            assertEquals(3, entrypoints.size());
            assertEquals("global", entrypoints.get(0).path("type").asString());
            assertEquals("thread", entrypoints.get(1).path("type").asString());
            assertEquals("file", entrypoints.get(2).path("type").asString());
            assertEquals(".traveltrip", entrypoints.get(2).path("extensions").get(0).asString());
            assertNotNull(editComponent);
            assertEquals("app", editComponent.path("_meta").path("ui").path("visibility").get(0).asString());
            var page = request(aliceToken, null, Map.of("jsonrpc", "2.0", "id", 3, "method", "resources/read", "params", Map.of("uri", uiUri)));
            assertEquals(200, page.statusCode());
            assertTrue(JSON.readTree(page.body()).path("result").path("contents").get(0).path("text").asString().contains("Travel Agent"));
        }

        JsonNode profile = call(aliceToken, "get_profile", Map.of());
        assertEquals(alice.toString(), profile.path("structuredContent").path("id").asString());
        JsonNode creation = call(aliceToken, "create_travel_workspace", Map.of("requestId", "http-create", "brief", Map.of("destination", "上海", "countryCode", "CN")));
        assertFalse(creation.path("isError").asBoolean());
        String trip = creation.path("structuredContent").path("tripId").asString();
        assertFalse(trip.isBlank());
        var weather = call(aliceToken, "check_trip_weather", Map.of("tripId", trip)).path("structuredContent");
        assertEquals("provider_unavailable", weather.path("status").asString());
        assertEquals("amap_weather_not_configured", weather.path("reason").asString());
        var layout = call(aliceToken, "get_workbench_document", Map.of("tripId", trip)).path("structuredContent");
        assertEquals(0, layout.path("layoutRevision").asInt());
        var composition = call(aliceToken, "compose_workbench", Map.of("tripId", trip, "expectedTripRevision", 0,
                "expectedLayoutRevision", 0, "requestId", "http-layout", "componentTypes", List.of("itinerary", "map"))).path("structuredContent");
        assertEquals(1, composition.path("layoutRevision").asInt());
        assertEquals(2, composition.path("document").path("components").size());
        var userLayout = call(aliceToken, "edit_workbench_component", Map.of("tripId", trip, "expectedTripRevision", 0,
                "expectedLayoutRevision", 1, "requestId", "http-show", "action", "show")).path("structuredContent");
        assertEquals(2, userLayout.path("layoutRevision").asInt());
        var update = call(aliceToken, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "http-update", "changes", Map.of("totalBudget", 3000)));
        assertEquals(1, update.path("structuredContent").path("revision").asInt());
        assertEquals("revision_conflict", call(aliceToken, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "stale-update", "changes", Map.of("destination", "Osaka"))).path("structuredContent").path("code").asString());
        assertEquals("trip_not_found", call(bobToken, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("code").asString());
        assertEquals("permission_denied", call(bobToken, "create_travel_workspace", Map.of("requestId", "no-write")).path("structuredContent").path("code").asString());
        assertFalse(call(aliceToken, "grant_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "role", "viewer", "expectedAccessRevision", 0, "requestId", "http-share")).path("isError").asBoolean());
        assertEquals("viewer", call(bobToken, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("role").asString());
        assertFalse(call(aliceToken, "revoke_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "expectedAccessRevision", 1, "requestId", "http-revoke")).path("isError").asBoolean());
        assertEquals("trip_not_found", call(bobToken, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("code").asString());
    }

    @Test
    void placeResearchReferenceUsesTheRealMcpAndTripAccessBoundary() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("places-test-owner", "Owner");
        UUID bob = accounts.fromVerifiedGoogleSubject("places-test-viewer", "Viewer");
        String owner = token(alice, "travel:read travel:write");
        String viewer = token(bob, "travel:read");
        var created = call(owner, "create_travel_workspace", Map.of("requestId", "places-trip", "brief", Map.of("destination", "上海市", "countryCode", "CN")));
        String trip = created.path("structuredContent").path("tripId").asString();
        var now = java.time.Instant.now();
        var source = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", now.toString(),
                "freshUntil", now.plusSeconds(1800).toString(), "candidates", List.of(Map.of("sourceId", "test-poi", "name", "测试地点", "address", "模拟地址")));
        var secondSource = new java.util.LinkedHashMap<>(source);
        secondSource.put("candidates", List.of(Map.of("sourceId", "second-poi", "name", "第二个测试地点", "address", "第二个模拟地址")));
        org.mockito.Mockito.doReturn(Mono.just(source), Mono.just(secondSource), Mono.just(secondSource)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq("博物馆"), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        assertEquals("trip_not_found", call(viewer, "search_trip_places", Map.of("tripId", trip, "domain", "play", "keyword", "博物馆"))
                .path("structuredContent").path("code").asString());
        var research = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play", "keyword", "博物馆"));
        var reference = research.path("structuredContent");
        assertEquals("places", reference.path("kind").asString());
        assertEquals("测试地点", reference.path("data").path("candidates").get(0).path("name").asString());
        assertFalse(reference.path("data").path("candidates").get(0).has("address"));
        assertFalse(research.path("content").get(0).path("text").asString().contains("模拟地址"));
        assertEquals("模拟地址", research.path("_meta").path("travel/uiData").path("data").path("candidates").get(0).path("address").asString());
        String result = reference.path("resultId").asString();
        assertFalse(result.isBlank());
        String replacement = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play", "keyword", "博物馆"))
                .path("structuredContent").path("resultId").asString();
        var presented = call(owner, "present_trip_places", Map.of("tripId", trip, "resultId", result, "expectedTripRevision", 0,
                "expectedLayoutRevision", 0, "requestId", "present-places")).path("structuredContent");
        assertEquals(1, presented.path("layoutRevision").asInt());
        var appended = call(owner, "present_trip_places", Map.of("tripId", trip, "resultId", replacement, "expectedTripRevision", 0,
                "expectedLayoutRevision", 1, "requestId", "append-places")).path("structuredContent");
        assertEquals(2, appended.path("layoutRevision").asInt());
        var savedIds = appended.path("document").path("components").get(3).path("resultIds");
        assertEquals(result, savedIds.get(0).asString());
        assertEquals(replacement, savedIds.get(1).asString());
        assertEquals(2, call(owner, "present_trip_places", Map.of("tripId", trip, "resultId", replacement, "expectedTripRevision", 0,
                "expectedLayoutRevision", 2, "requestId", "append-same-places")).path("structuredContent").path("layoutRevision").asInt());
        String later = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play", "keyword", "博物馆"))
                .path("structuredContent").path("resultId").asString();
        var pin = call(owner, "edit_workbench_component", Map.of("tripId", trip, "expectedTripRevision", 0, "expectedLayoutRevision", 2,
                "requestId", "pin-places", "componentType", "places", "action", "pin")).path("structuredContent");
        assertEquals(3, pin.path("layoutRevision").asInt());
        var pending = call(owner, "present_trip_places", Map.of("tripId", trip, "resultId", later,
                "expectedTripRevision", 0, "expectedLayoutRevision", 3, "requestId", "pending-pinned")).path("structuredContent");
        assertEquals("pending_confirmation", pending.path("presentation").asString());
        assertEquals(4, pending.path("layoutRevision").asInt());
        assertEquals(later, pending.path("document").path("pendingPlaceResults").get(0).asString());
        assertEquals(2, pending.path("document").path("components").get(3).path("resultIds").size());
        assertEquals(5, call(owner, "edit_workbench_component", Map.of("tripId", trip, "expectedTripRevision", 0, "expectedLayoutRevision", 4,
                "requestId", "hide-places", "componentType", "places", "action", "hide")).path("structuredContent").path("layoutRevision").asInt());
        String laterHidden = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play", "keyword", "博物馆"))
                .path("structuredContent").path("resultId").asString();
        var hiddenPending = call(owner, "present_trip_places", Map.of("tripId", trip, "resultId", laterHidden,
                "expectedTripRevision", 0, "expectedLayoutRevision", 5, "requestId", "pending-hidden")).path("structuredContent");
        assertEquals("pending_confirmation", hiddenPending.path("presentation").asString());
        assertEquals(6, hiddenPending.path("layoutRevision").asInt());
        var accepted = call(owner, "decide_trip_place_result", Map.of("tripId", trip, "resultId", later, "expectedTripRevision", 0,
                "expectedLayoutRevision", 6, "requestId", "accept-places", "decision", "accept")).path("structuredContent");
        assertEquals(7, accepted.path("layoutRevision").asInt());
        assertEquals(result, accepted.path("document").path("components").get(3).path("resultIds").get(0).asString());
        assertEquals(replacement, accepted.path("document").path("components").get(3).path("resultIds").get(1).asString());
        assertEquals(later, accepted.path("document").path("components").get(3).path("resultIds").get(2).asString());
        assertTrue(accepted.path("document").path("components").get(3).path("pinned").asBoolean());
        assertEquals(1, accepted.path("document").path("pendingPlaceResults").size());
        var rejected = call(owner, "decide_trip_place_result", Map.of("tripId", trip, "resultId", laterHidden, "expectedTripRevision", 0,
                "expectedLayoutRevision", 7, "requestId", "reject-places", "decision", "reject")).path("structuredContent");
        assertEquals(8, rejected.path("layoutRevision").asInt());
        assertEquals(0, rejected.path("document").path("pendingPlaceResults").size());
        assertEquals(8, call(owner, "edit_workbench_component", Map.of("tripId", trip, "expectedTripRevision", 0, "expectedLayoutRevision", 2,
                "requestId", "pin-places", "componentType", "places", "action", "pin")).path("structuredContent").path("layoutRevision").asInt());
        assertEquals("no_longer_present", call(owner, "present_trip_places", Map.of("tripId", trip, "resultId", laterHidden,
                "expectedTripRevision", 0, "expectedLayoutRevision", 5, "requestId", "pending-hidden")).path("structuredContent").path("presentation").asString());
        assertEquals("result_not_found", call(viewer, "get_trip_result_reference", Map.of("resultId", result)).path("structuredContent").path("code").asString());
        call(owner, "grant_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "role", "viewer", "expectedAccessRevision", 0, "requestId", "places-share"));
        var viewerResult = call(viewer, "get_trip_result_reference", Map.of("resultId", result));
        assertEquals("测试地点", viewerResult.path("structuredContent").path("data").path("candidates").get(0).path("name").asString());
        assertEquals("模拟地址", viewerResult.path("_meta").path("travel/uiData").path("data").path("candidates").get(0).path("address").asString());
        call(owner, "revoke_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "expectedAccessRevision", 1, "requestId", "places-revoke"));
        assertEquals("result_not_found", call(viewer, "get_trip_result_reference", Map.of("resultId", result)).path("structuredContent").path("code").asString());
        call(owner, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "places-change-trip", "changes", Map.of("destination", "北京")));
        assertEquals("result_stale", call(owner, "present_trip_places", Map.of("tripId", trip, "resultId", result, "expectedTripRevision", 1,
                "expectedLayoutRevision", 8, "requestId", "present-stale")).path("structuredContent").path("code").asString());
    }

    @Test
    void sharingEmailStaysOutOfModelVisibleResultsAndAccessCanBeRevoked() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("email-http-owner", "Owner", "owner@gmail.com", true);
        UUID bob = accounts.fromVerifiedGoogleSubject("email-http-bob", "Bob", "bob@gmail.com", true);
        String owner = token(alice, "travel:read travel:write"), viewer = token(bob, "travel:read travel:write");
        String trip = call(owner, "create_travel_workspace", Map.of("requestId", "email-http-trip", "brief", Map.of("destination", "Tokyo")))
                .path("structuredContent").path("tripId").asString();
        String digest = TravelAccounts.emailDigest(TravelAccounts.normalizeEmail("bob@gmail.com"));
        var found = call(owner, "resolve_trip_share_email", Map.of("tripId", trip, "emailHash", digest));
        assertFalse(found.toString().contains("bob@gmail.com"));
        assertEquals("ok", found.path("structuredContent").path("status").asString());
        assertEquals(bob.toString(), found.path("_meta").path("travel/uiData").path("accountId").asString());
        var share = Map.<String, Object>of("tripId", trip, "accountId", bob.toString(), "emailHash", digest, "role", "viewer", "expectedAccessRevision", 0, "requestId", "email-http-grant");
        assertFalse(call(owner, "grant_trip_share_email", share).path("isError").asBoolean());
        assertEquals("viewer", call(viewer, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("role").asString());
        var listed = call(owner, "list_trip_share_members", Map.of("tripId", trip));
        assertFalse(listed.path("structuredContent").toString().contains("bob@gmail.com"));
        assertFalse(listed.path("content").toString().contains("bob@gmail.com"));
        assertEquals("bob@gmail.com", listed.path("_meta").path("travel/uiData").path("items").get(0).path("email").asString());
        assertEquals("trip_not_found", call(viewer, "list_trip_share_members", Map.of("tripId", trip)).path("structuredContent").path("code").asString());
        call(owner, "grant_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "role", "editor", "expectedAccessRevision", 1, "requestId", "email-http-editor"));
        assertEquals("editor", call(viewer, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("role").asString());
        call(owner, "revoke_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "expectedAccessRevision", 2, "requestId", "email-http-revoke"));
        assertEquals("trip_not_found", call(viewer, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("code").asString());
        assertEquals("not_shared", call(owner, "grant_trip_share_email", share).path("_meta").path("travel/uiData").path("status").asString());
        assertEquals("trip_not_found", call(viewer, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("code").asString());
        UUID carol = accounts.fromVerifiedGoogleSubject("email-http-carol", "Carol", "carol@example.com", false);
        String carolDigest = TravelAccounts.emailDigest(TravelAccounts.normalizeEmail("carol@example.com"));
        var external = call(owner, "resolve_trip_share_email", Map.of("tripId", trip, "emailHash", carolDigest));
        assertFalse(external.path("_meta").path("travel/uiData").path("emailAuthoritative").asBoolean(true));
        assertFalse(external.toString().contains("carol@example.com"));
        assertFalse(call(owner, "grant_trip_share_email", Map.of("tripId", trip, "accountId", carol.toString(), "emailHash", carolDigest,
                "role", "viewer", "expectedAccessRevision", 3, "requestId", "external-http-grant")).path("isError").asBoolean());
        assertEquals("viewer", call(token(carol, "travel:read"), "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("role").asString());
    }

    @Test
    void journeysPreserveIndependentDirectionsAndRefuseUnsafeWholeListReplacement() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("journey-owner", "Alice");
        UUID stranger = accounts.fromVerifiedGoogleSubject("journey-stranger", "Stranger");
        String owner = token(alice, "travel:read travel:write"), other = token(stranger, "travel:read travel:write");
        var outbound = Map.<String, Object>of("journeyId", "out", "origin", "杭州", "destination", "上海", "date", "2026-11-20", "purpose", "outbound", "scope", "plan", "mode", "train");
        var returning = Map.<String, Object>of("journeyId", "back", "origin", "上海", "destination", "杭州", "date", "2026-11-23", "purpose", "return", "scope", "plan", "mode", "train", "arriveBy", "2026-11-25T19:00:00+08:00");
        var transfer = Map.<String, Object>of("journeyId", "transfer", "origin", "上海", "destination", "苏州", "date", "2026-11-21", "purpose", "transfer", "scope", "self_arranged");
        String trip = call(owner, "create_travel_workspace", Map.of("requestId", "journey-create", "brief", Map.of("destination", "上海", "journeys", List.of(outbound, returning))))
                .path("structuredContent").path("tripId").asString();
        var add = Map.<String, Object>of("tripId", trip, "expectedRevision", 0, "requestId", "journey-add", "journey", transfer);
        assertEquals(1, call(owner, "upsert_trip_journey", add).path("structuredContent").path("revision").asInt());
        var updatedReturn = new java.util.LinkedHashMap<>(returning); updatedReturn.put("date", "2026-11-24"); updatedReturn.remove("mode"); updatedReturn.remove("arriveBy");
        var changed = call(owner, "upsert_trip_journey", Map.of("tripId", trip, "expectedRevision", 1, "requestId", "journey-update", "journey", updatedReturn)).path("structuredContent");
        assertEquals(2, changed.path("revision").asInt());
        assertEquals("2026-11-20", changed.path("state").path("brief").path("journeys").get(0).path("date").asString());
        assertEquals("2026-11-24", changed.path("state").path("brief").path("journeys").get(1).path("date").asString());
        assertEquals("train", changed.path("state").path("brief").path("journeys").get(1).path("mode").asString());
        assertEquals("2026-11-25T19:00:00+08:00", changed.path("state").path("brief").path("journeys").get(1).path("arriveBy").asString());
        assertEquals("self_arranged", changed.path("state").path("brief").path("journeys").get(2).path("scope").asString());
        assertEquals(2, call(owner, "upsert_trip_journey", add).path("structuredContent").path("revision").asInt());
        assertEquals("request_id_conflict", call(owner, "upsert_trip_journey", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "journey-add", "journey", outbound)).path("structuredContent").path("code").asString());
        assertEquals("use_individual_journey_change", call(owner, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 2, "requestId", "replace-all", "changes", Map.of("journeys", List.of(outbound)))).path("structuredContent").path("code").asString());
        assertEquals("trip_not_found", call(other, "remove_trip_journey", Map.of("tripId", trip, "expectedRevision", 2, "requestId", "bad-remove", "journeyId", "back")).path("structuredContent").path("code").asString());
        var removed = call(owner, "remove_trip_journey", Map.of("tripId", trip, "expectedRevision", 2, "requestId", "journey-remove", "journeyId", "back")).path("structuredContent");
        assertEquals(3, removed.path("revision").asInt());
        assertEquals("out", removed.path("state").path("brief").path("journeys").get(0).path("journeyId").asString());
        assertEquals("transfer", removed.path("state").path("brief").path("journeys").get(1).path("journeyId").asString());
        var invalid = new java.util.LinkedHashMap<>(returning); invalid.put("date", "2026-02-30");
        assertEquals("invalid_journeys", call(owner, "upsert_trip_journey", Map.of("tripId", trip, "expectedRevision", 3, "requestId", "invalid-date", "journey", invalid)).path("structuredContent").path("code").asString());
        var confirmed = Map.<String, Object>of("transportId", "ticket", "mode", "train", "origin", "杭州", "destination", "上海",
                "departure", Map.of("local", "2026-11-20T08:00", "timeZone", "Asia/Shanghai"),
                "arrival", Map.of("local", "2026-11-20T10:00", "timeZone", "Asia/Shanghai"), "travelerIds", List.of());
        assertEquals(4, call(owner, "save_confirmed_transport", Map.of("tripId", trip, "expectedRevision", 3, "requestId", "ticket", "transport", confirmed)).path("structuredContent").path("revision").asInt());
        assertEquals("scope_change_needs_planning_rules", call(owner, "upsert_trip_journey", Map.of("tripId", trip, "expectedRevision", 4, "requestId", "blocked-journey", "journey", returning)).path("structuredContent").path("code").asString());
        assertEquals("ticket", call(owner, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("state").path("confirmedTransport").get(0).path("transportId").asString());
    }

    @Test
    void flightStatusResultIsTripScopedAndDoesNotClaimABookingMatch() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("flight-status-owner", "Alice");
        UUID bob = accounts.fromVerifiedGoogleSubject("flight-status-viewer", "Bob");
        String owner = token(alice, "travel:read travel:write"), viewer = token(bob, "travel:read");
        String trip = call(owner, "create_travel_workspace", Map.of("requestId", "flight-status-trip", "brief", Map.of("destination", "London")))
                .path("structuredContent").path("tripId").asString();
        var query = Map.<String, Object>of("tripId", trip, "carrier", "AA", "flight", "100", "departureAirportIata", "JFK", "departureDateLocal", "2026-11-20");
        assertEquals("cirium_status_not_configured", call(owner, "check_trip_flight_status", query).path("structuredContent").path("reason").asString());
        var checked = java.time.Instant.now();
        var fixture = Map.<String, Object>of("status", "completed", "provider", "cirium_flight_status", "coverage", "query",
                "checkedAt", checked.toString(), "freshUntil", checked.plusSeconds(900).toString(), "returnedCount", 1,
                "candidates", List.of(Map.of("sourceFlightId", "123", "statusCode", "C", "bookingMatchConfirmed", false)), "unusable", List.of());
        org.mockito.Mockito.doReturn(Mono.just(fixture)).when(flightStatus).lookup("AA", "100", "JFK", "2026-11-20");
        var result = call(owner, "check_trip_flight_status", query).path("structuredContent");
        String id = result.path("resultId").asString();
        assertEquals("flight_status", result.path("kind").asString());
        assertFalse(result.path("data").path("candidates").get(0).path("bookingMatchConfirmed").asBoolean(true));
        assertEquals("result_not_found", call(viewer, "get_trip_result_reference", Map.of("resultId", id)).path("structuredContent").path("code").asString());
        call(owner, "grant_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "role", "viewer", "expectedAccessRevision", 0, "requestId", "flight-share"));
        assertEquals("C", call(viewer, "get_trip_result_reference", Map.of("resultId", id)).path("structuredContent").path("data").path("candidates").get(0).path("statusCode").asString());
        call(owner, "revoke_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "expectedAccessRevision", 1, "requestId", "flight-unshare"));
        assertEquals("result_not_found", call(viewer, "get_trip_result_reference", Map.of("resultId", id)).path("structuredContent").path("code").asString());
    }

    @Test
    void editableJournalMcpResultsKeepPrivateContentInTheAppAndFencePhotoIdentity() throws Exception {
        UUID actor=accounts.fromVerifiedGoogleSubject("journal-edit-http","Owner");
        String access=token(actor,"travel:read travel:write");
        String trip=call(access,"create_travel_workspace",Map.of("requestId","edit-http-trip","brief",Map.of("destination","京都"))).path("structuredContent").path("tripId").asString();
        String entry=UUID.randomUUID().toString(), photo=UUID.randomUUID().toString();
        String jpeg="/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAA//2Q==";
        var save=new java.util.LinkedHashMap<String,Object>();
        save.putAll(Map.of("tripId",trip,"entryId",entry,"expectedRevision",0,"expectedEntryRevision",-1,"requestId","http-save-entry","title","私密回忆","note","私密文字","subject","building","stage","visited","photos",List.of(Map.of("photoId",photo,"data",jpeg))));
        var saved=call(access,"save_trip_journal_entry",save);
        assertFalse(saved.path("isError").asBoolean(false),saved.toString());
        assertEquals(0,saved.path("_meta").path("travel/uiData").path("entry").path("entryRevision").asInt());
        assertFalse(saved.path("content").toString().contains("私密"));
        assertFalse(saved.path("structuredContent").toString().contains("私密"));
        var get=call(access,"get_trip_journal_entry",Map.of("tripId",trip,"entryId",entry));
        assertEquals("私密文字",get.path("_meta").path("travel/uiData").path("entry").path("note").asString());
        assertFalse(get.path("content").toString().contains("私密"));
        var image=call(access,"read_trip_journal_image",Map.of("tripId",trip,"entryId",entry,"photoId",photo));
        String before=image.path("_meta").path("travel/uiData").path("data").asString();
        assertFalse(before.isBlank());
        assertFalse(image.path("content").toString().contains(before));
        var recipe=Map.<String,Object>of("version","photo-relief-v1","horizon",.5,"depth",.6,"style","photo");
        var effect=call(access,"save_trip_photo_relief",Map.of("tripId",trip,"entryId",entry,"photoId",photo,"expectedRevision",0,"expectedEntryRevision",0,"requestId","http-effect","relief",recipe));
        assertFalse(effect.path("isError").asBoolean(false),effect.toString());
        assertEquals(1,effect.path("_meta").path("travel/uiData").path("entry").path("entryRevision").asInt());
        assertEquals(before,call(access,"read_trip_journal_image",Map.of("tripId",trip,"entryId",entry,"photoId",photo)).path("_meta").path("travel/uiData").path("data").asString());
        assertEquals("journal_revision_conflict",call(access,"delete_trip_journal",Map.of("tripId",trip,"entryId",entry,"expectedRevision",0,"expectedEntryRevision",0,"requestId","http-stale-delete")).path("structuredContent").path("code").asString());
        assertFalse(call(access,"delete_trip_journal",Map.of("tripId",trip,"entryId",entry,"expectedRevision",0,"expectedEntryRevision",1,"requestId","http-delete")).path("isError").asBoolean(false));
    }

    @Test
    void privateJournalStripsMetadataEnforcesAccessAndNeverRestoresADeletedPhotoOnRetry() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("journal-owner", "Alice"), bob = accounts.fromVerifiedGoogleSubject("journal-viewer", "Bob");
        String owner = token(alice, "travel:read travel:write"), viewer = token(bob, "travel:read travel:write");
        String trip = call(owner, "create_travel_workspace", Map.of("requestId", "journal-trip", "brief", Map.of("destination", "上海", "countryCode", "CN")))
                .path("structuredContent").path("tripId").asString();
        var now = java.time.Instant.now();
        var source = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", now.toString(),
                "freshUntil", now.plusSeconds(1800).toString(), "candidates", List.of(Map.of("sourceId", "poi-1", "name", "测试地点")));
        org.mockito.Mockito.doReturn(Mono.just(source)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq("博物馆"), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        String resultId = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play", "keyword", "博物馆")).path("structuredContent").path("resultId").asString();
        String jpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAA//2Q==";
        byte[] original = Base64.getDecoder().decode(jpeg), exif = "Exif\0\0GPS secret".getBytes(StandardCharsets.UTF_8);
        var buffer = new java.io.ByteArrayOutputStream(); buffer.write(original, 0, 2); buffer.write(0xff); buffer.write(0xe1);
        int length = exif.length + 2; buffer.write(length >> 8); buffer.write(length & 0xff); buffer.writeBytes(exif); buffer.write(original, 2, original.length - 2);
        buffer.writeBytes("trailing-sensitive-data".getBytes(StandardCharsets.UTF_8));
        String entry = UUID.randomUUID().toString();
        var recipe = Map.<String, Object>of("version", "photo-relief-v1", "horizon", .48, "depth", .65, "style", "ink");
        var create = Map.<String, Object>of("tripId", trip, "entryId", entry, "resultId", resultId, "sourceId", "poi-1", "expectedRevision", 0,
                "requestId", "journal-save", "subject", "building", "stage", "visited", "note", "傍晚的光",
                "photos", List.of(Map.of("data", Base64.getEncoder().encodeToString(buffer.toByteArray()), "relief", recipe)));
        var saved = call(owner, "create_trip_journal", create);
        assertEquals("ok", saved.path("structuredContent").path("status").asString());
        assertFalse(saved.path("content").toString().contains("傍晚的光"));
        assertEquals("傍晚的光", saved.path("_meta").path("travel/uiData").path("entry").path("note").asString());
        assertEquals("photo-relief-v1", saved.path("_meta").path("travel/uiData").path("entry").path("photos").get(0).path("relief").path("version").asString());
        assertEquals(.65, saved.path("_meta").path("travel/uiData").path("entry").path("photos").get(0).path("relief").path("depth").asDouble());
        var invalidRecipe = new java.util.LinkedHashMap<>(recipe); invalidRecipe.put("url", "https://untrusted.invalid/model");
        assertEquals("journal_relief_invalid", assertThrows(TravelError.class, () -> journal.create(alice, UUID.fromString(trip), 0, "invalid-relief", UUID.randomUUID(),
                UUID.fromString(resultId), "poi-1", "building", "visited", "", null, List.of(Map.of("data", jpeg, "relief", invalidRecipe)))).code());
        var changedRecipe = new java.util.LinkedHashMap<>(recipe); changedRecipe.put("style", "photo");
        var changedRequest = new java.util.LinkedHashMap<>(create); changedRequest.put("photos", List.of(Map.of("data", Base64.getEncoder().encodeToString(buffer.toByteArray()), "relief", changedRecipe)));
        assertEquals("request_id_conflict", call(owner, "create_trip_journal", changedRequest).path("structuredContent").path("code").asString());
        assertEquals("trip_not_found", call(viewer, "list_trip_journal", Map.of("tripId", trip)).path("structuredContent").path("code").asString());
        call(owner, "grant_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "role", "viewer", "expectedAccessRevision", 0, "requestId", "journal-share"));
        var listed = call(viewer, "list_trip_journal", Map.of("tripId", trip));
        assertFalse(listed.path("structuredContent").toString().contains("傍晚的光"));
        assertFalse(listed.path("content").toString().contains("傍晚的光"));
        assertEquals("傍晚的光", listed.path("_meta").path("travel/uiData").path("items").get(0).path("note").asString());
        var photo = call(viewer, "read_trip_journal_photo", Map.of("tripId", trip, "entryId", entry, "photoIndex", 0));
        assertFalse(photo.path("content").toString().contains("/9j/"));
        byte[] clean = Base64.getDecoder().decode(photo.path("_meta").path("travel/uiData").path("data").asString());
        assertFalse(new String(clean, StandardCharsets.ISO_8859_1).contains("GPS secret"));
        assertFalse(new String(clean, StandardCharsets.ISO_8859_1).contains("trailing-sensitive-data"));
        assertEquals("trip_not_found", call(viewer, "create_trip_journal", create).path("structuredContent").path("code").asString());
        call(owner, "revoke_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "expectedAccessRevision", 1, "requestId", "journal-revoke"));
        assertEquals("trip_not_found", call(viewer, "read_trip_journal_photo", Map.of("tripId", trip, "entryId", entry, "photoIndex", 0)).path("structuredContent").path("code").asString());
        var image = new java.awt.image.BufferedImage(720, 720, java.awt.image.BufferedImage.TYPE_INT_RGB);
        var random = new java.util.Random(17);
        for (int y = 0; y < image.getHeight(); y++) for (int x = 0; x < image.getWidth(); x++) image.setRGB(x, y, random.nextInt(0x1000000));
        var encodedImage = new java.io.ByteArrayOutputStream(); assertTrue(javax.imageio.ImageIO.write(image, "jpeg", encodedImage));
        assertTrue(encodedImage.size() > 100000 && encodedImage.size() < 450000);
        String bigPhoto = Base64.getEncoder().encodeToString(encodedImage.toByteArray());
        var noNote = new java.util.LinkedHashMap<>(create); noNote.put("entryId", UUID.randomUUID().toString()); noNote.put("requestId", "journal-no-note"); noNote.put("note", "");
        noNote.put("photos", List.of(Map.of("data", bigPhoto), Map.of("data", bigPhoto), Map.of("data", bigPhoto)));
        var three = call(owner, "create_trip_journal", noNote).path("_meta").path("travel/uiData");
        assertEquals("saved", three.path("status").asString());
        assertEquals(3, three.path("entry").path("photos").size());
        var food = new java.util.LinkedHashMap<>(create); food.put("entryId", UUID.randomUUID().toString()); food.put("requestId", "journal-food-relief"); food.put("subject", "food");
        assertEquals("journal_relief_subject_unsupported", call(owner, "create_trip_journal", food).path("structuredContent").path("code").asString());
        var allEntries = call(owner, "list_trip_journal", Map.of("tripId", trip)).path("_meta").path("travel/uiData").path("items");
        assertEquals(2, allEntries.size());
        assertTrue(java.util.stream.StreamSupport.stream(allEntries.spliterator(), false)
                .anyMatch(item -> noNote.get("entryId").equals(item.path("entryId").asString()) && item.path("photos").size() == 3));
        var oversized = new java.util.LinkedHashMap<>(noNote); oversized.put("photos", List.of(Map.of("data", "A".repeat(600000)), Map.of("data", "A".repeat(600000)), Map.of("data", "A".repeat(600000)), Map.of("data", "A".repeat(600000))));
        var rejectedSize = request(owner, null, Map.of("jsonrpc", "2.0", "id", 11, "method", "tools/call", "params", Map.of("name", "create_trip_journal", "arguments", oversized)));
        assertEquals(413, rejectedSize.statusCode());
        assertFalse(rejectedSize.body().contains("A".repeat(100)));
        assertEquals(0, call(owner, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("revision").asInt());
        var delete = Map.<String, Object>of("tripId", trip, "entryId", entry, "expectedRevision", 0, "expectedEntryRevision", 0, "requestId", "journal-delete");
        assertEquals("deleted", call(owner, "delete_trip_journal", delete).path("_meta").path("travel/uiData").path("status").asString());
        assertEquals("deleted", call(owner, "delete_trip_journal", delete).path("_meta").path("travel/uiData").path("status").asString());
        assertEquals("deleted", call(owner, "create_trip_journal", create).path("_meta").path("travel/uiData").path("status").asString());
        var resurrect = new java.util.LinkedHashMap<>(create); resurrect.put("requestId", "journal-new-retry");
        assertEquals("journal_id_conflict", call(owner, "create_trip_journal", resurrect).path("structuredContent").path("code").asString());
        assertEquals("journal_photo_not_found", call(owner, "read_trip_journal_photo", Map.of("tripId", trip, "entryId", entry, "photoIndex", 0)).path("structuredContent").path("code").asString());
    }

    @Test
    void walkingResearchUsesAuthorizedFreshPlaceReferencesAndRejectsLateResults() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("walking-owner", "Owner");
        UUID bob = accounts.fromVerifiedGoogleSubject("walking-viewer", "Viewer");
        String owner = token(alice, "travel:read travel:write"), stranger = token(bob, "travel:read");
        String trip = call(owner, "create_travel_workspace", Map.of("requestId", "walking-trip", "brief", Map.of("destination", "上海", "countryCode", "CN")))
                .path("structuredContent").path("tripId").asString();
        var now = java.time.Instant.now();
        var first = Map.<String, Object>of("sourceId", "from", "name", "起点", "domain", "play", "coordinates",
                Map.of("longitude", 121.47, "latitude", 31.23, "coordinateSystem", "GCJ-02"));
        var second = Map.<String, Object>of("sourceId", "to", "name", "终点", "domain", "play", "coordinates",
                Map.of("longitude", 121.48, "latitude", 31.24, "coordinateSystem", "GCJ-02"));
        var source = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", now.toString(),
                "freshUntil", now.plusSeconds(1800).toString(), "domain", "play", "candidates", List.of(first, second, Map.of("sourceId", "no-point", "name", "坐标缺失", "domain", "play")));
        org.mockito.Mockito.doReturn(Mono.just(source)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq(""), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        String reference = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play")).path("structuredContent").path("resultId").asString();
        var request = Map.<String, Object>of("tripId", trip, "origin", Map.of("resultId", reference, "sourceId", "from"),
                "destination", Map.of("resultId", reference, "sourceId", "to"));
        var route = Map.<String, Object>of("status", "completed", "provider", "amap_walking_route", "coverage", "query", "checkedAt", now.toString(),
                "freshUntil", now.plusSeconds(900).toString(), "returnedCount", 1, "alternatives", List.of(Map.of("sourceIndex", 0, "distanceMeters", 900, "durationSeconds", 700,
                        "steps", List.of(Map.of("instruction", "沿路前行", "polylineGcj02", "121.47,31.23;121.48,31.24", "missing", List.of())))), "unusable", List.of());
        org.mockito.Mockito.doReturn(Mono.just(route)).when(walking).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        var routeResponse = call(owner, "check_trip_walking_route", request);
        var found = routeResponse.path("structuredContent");
        assertEquals("walking_route", found.path("kind").asString());
        assertEquals("from", found.path("data").path("endpoints").path("origin").path("sourceId").asString());
        assertEquals(900, found.path("data").path("alternatives").get(0).path("distanceMeters").asInt());
        assertEquals(1, found.path("data").path("alternatives").get(0).path("stepCount").asInt());
        assertTrue(found.path("data").path("alternatives").get(0).path("steps").isMissingNode());
        assertEquals("沿路前行", routeResponse.path("_meta").path("travel/uiData").path("data").path("alternatives").get(0).path("steps").get(0).path("instruction").asString());
        var fromVisit = Map.<String, Object>of("stopId", "visit-from", "sourceResultId", reference, "sourceId", "from", "role", "activity",
                "startLocal", "2026-11-07T10:00", "timeZone", "Asia/Shanghai", "durationMinutes", 60);
        var toVisit = Map.<String, Object>of("stopId", "visit-to", "sourceResultId", reference, "sourceId", "to", "role", "activity",
                "startLocal", "2026-11-07T11:05", "timeZone", "Asia/Shanghai", "durationMinutes", 60);
        String draftId = call(owner, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "walking-draft", "stops", List.of(fromVisit, toVisit)))
                .path("structuredContent").path("draftId").asString();
        var timing = Map.<String, Object>of("tripId", trip, "draftId", draftId, "expectedRevision", 0, "expectedDraftRevision", 0,
                "originStopId", "visit-from", "destinationStopId", "visit-to", "routeResultId", found.path("resultId").asString(), "sourceIndex", 0);
        var comparison = call(owner, "check_draft_walking_timing", timing).path("structuredContent");
        assertEquals(300, comparison.path("gapSeconds").asInt());
        assertFalse(comparison.path("fitsEstimatedDuration").asBoolean());
        assertEquals("query_time_estimate_not_future_guarantee", comparison.path("basis").asString());
        var wrongAlternative = new java.util.LinkedHashMap<>(timing); wrongAlternative.put("sourceIndex", 3);
        assertEquals("route_alternative_not_found", call(owner, "check_draft_walking_timing", wrongAlternative).path("structuredContent").path("code").asString());
        call(owner, "edit_trip_itinerary_visit", Map.of("tripId", trip, "draftId", draftId, "expectedRevision", 0, "expectedDraftRevision", 0,
                "requestId", "walking-move-visit", "stopId", "visit-to", "changes", Map.of("startLocal", "2026-11-07T12:00", "timeZone", "Asia/Shanghai", "durationMinutes", 60)));
        assertEquals("draft_revision_conflict", call(owner, "check_draft_walking_timing", timing).path("structuredContent").path("code").asString());
        var updatedTiming = new java.util.LinkedHashMap<>(timing); updatedTiming.put("expectedDraftRevision", 1);
        assertTrue(call(owner, "check_draft_walking_timing", updatedTiming).path("structuredContent").path("fitsEstimatedDuration").asBoolean());
        assertEquals("trip_not_found", call(stranger, "check_trip_walking_route", request).path("structuredContent").path("code").asString());
        var missing = Map.<String, Object>of("tripId", trip, "origin", Map.of("resultId", reference, "sourceId", "no-point"), "destination", Map.of("resultId", reference, "sourceId", "to"));
        assertEquals("route_coordinates_unavailable", call(owner, "check_trip_walking_route", missing).path("structuredContent").path("code").asString());
        String otherTrip = call(owner, "create_travel_workspace", Map.of("requestId", "walking-other-trip", "brief", Map.of("countryCode", "CN")))
                .path("structuredContent").path("tripId").asString();
        var crossTrip = new java.util.LinkedHashMap<>(request); crossTrip.put("tripId", otherTrip);
        assertEquals("result_not_found", call(owner, "check_trip_walking_route", crossTrip).path("structuredContent").path("code").asString());
        var oversized = new java.util.LinkedHashMap<>(route); oversized.put("details", "x".repeat(70000));
        org.mockito.Mockito.doReturn(Mono.just(oversized)).when(walking).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        assertEquals("source_result_too_large", call(owner, "check_trip_walking_route", request).path("structuredContent").path("code").asString());

        var entered = new java.util.concurrent.CountDownLatch(1); var release = new java.util.concurrent.CountDownLatch(1);
        org.mockito.Mockito.doReturn(Mono.fromCallable(() -> {
            entered.countDown();
            if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new IllegalStateException("test_timeout");
            return route;
        })).when(walking).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        var late = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try { return call(owner, "check_trip_walking_route", request); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        try {
            assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(1, call(owner, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "walking-change", "changes", Map.of("destination", "北京")))
                    .path("structuredContent").path("revision").asInt());
        } finally { release.countDown(); }
        assertEquals("result_stale", late.get(10, java.util.concurrent.TimeUnit.SECONDS).path("structuredContent").path("code").asString());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM travel_result_references WHERE trip_id=? AND kind='walking_route'", Integer.class, UUID.fromString(trip)));
    }

    @Test
    void itineraryDraftPreservesVisitsChecksIanaTimeAndNeverAdopts() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("draft-test-owner", "Owner");
        UUID bob = accounts.fromVerifiedGoogleSubject("draft-test-viewer", "Viewer");
        String owner = token(alice, "travel:read travel:write"), viewer = token(bob, "travel:read travel:write");
        String trip = call(owner, "create_travel_workspace", Map.of("requestId", "draft-trip", "brief", Map.of("destination", "上海市", "countryCode", "CN")))
                .path("structuredContent").path("tripId").asString();
        var now = java.time.Instant.now();
        var source = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", now.toString(),
                "freshUntil", now.plusSeconds(1800).toString(), "domain", "play", "candidates", List.of(Map.of("sourceId", "poi-a", "name", "模拟地点", "domain", "play")));
        org.mockito.Mockito.doReturn(Mono.just(source)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq(""), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        String result = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play")).path("structuredContent").path("resultId").asString();
        var repeatedHour = Map.<String, Object>of("stopId", "visit-1", "sourceResultId", result, "sourceId", "poi-a", "role", "activity",
                "startLocal", "2026-11-01T01:30", "timeZone", "America/New_York", "durationMinutes", 60);
        var input = Map.<String, Object>of("tripId", trip, "expectedRevision", 0, "requestId", "draft-ambiguous", "stops", List.of(repeatedHour));
        assertEquals("ambiguous_local_time", call(owner, "stage_trip_itinerary", input).path("structuredContent").path("code").asString());
        var gap = new java.util.LinkedHashMap<>(repeatedHour); gap.put("startLocal", "2026-03-08T02:30");
        assertEquals("nonexistent_local_time", call(owner, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 0,
                "requestId", "draft-gap", "stops", List.of(gap))).path("structuredContent").path("code").asString());
        var first = new java.util.LinkedHashMap<>(repeatedHour); first.put("utcOffset", "-04:00");
        var mismatchedRole = new java.util.LinkedHashMap<>(first); mismatchedRole.put("role", "stay_check_in");
        assertEquals("plan_role_domain_mismatch", call(owner, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 0,
                "requestId", "draft-wrong-role", "stops", List.of(mismatchedRole))).path("structuredContent").path("code").asString());
        var wrongOffset = new java.util.LinkedHashMap<>(first); wrongOffset.put("utcOffset", "+08:00");
        assertEquals("invalid_utc_offset", call(owner, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 0,
                "requestId", "draft-wrong-offset", "stops", List.of(wrongOffset))).path("structuredContent").path("code").asString());
        assertEquals("duplicate_visit_id", call(owner, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 0,
                "requestId", "draft-duplicate", "stops", List.of(first, first))).path("structuredContent").path("code").asString());
        var revisit = Map.<String, Object>of("stopId", "visit-2", "sourceResultId", result, "sourceId", "poi-a", "role", "activity",
                "startLocal", "2026-11-01T06:15", "timeZone", "Europe/London", "durationMinutes", 30);
        var draftInput = Map.<String, Object>of("tripId", trip, "expectedRevision", 0, "requestId", "draft-valid", "stops", List.of(first, revisit));
        var draft = call(owner, "stage_trip_itinerary", draftInput).path("structuredContent");
        String draftId = draft.path("draftId").asString();
        assertFalse(draftId.isBlank());
        assertFalse(draft.path("draft").path("canAdopt").asBoolean());
        assertEquals(2, draft.path("draft").path("stops").size());
        assertEquals("2026-11-01T05:30:00Z", draft.path("draft").path("stops").get(0).path("startAt").asString());
        assertEquals("time_overlap", draft.path("draft").path("timeConflicts").get(0).path("code").asString());
        assertEquals(draftId, call(owner, "stage_trip_itinerary", draftInput).path("structuredContent").path("draftId").asString());
        var verifyInput = Map.<String, Object>of("tripId", trip, "draftId", draftId, "expectedRevision", 0, "expectedDraftRevision", 0);
        var verified = call(owner, "verify_trip_itinerary_draft", verifyInput).path("structuredContent");
        assertFalse(verified.path("canAdopt").asBoolean());
        assertEquals("passed", verified.path("checks").get(0).path("status").asString());
        assertEquals("blocked", verified.path("checks").get(1).path("status").asString());
        assertEquals(result, verified.path("readSet").path("sources").get(0).path("resultId").asString());
        assertEquals("trip_not_found", call(viewer, "verify_trip_itinerary_draft", verifyInput).path("structuredContent").path("code").asString());
        String anotherDraft = call(owner, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "draft-second", "stops", List.of(first)))
                .path("structuredContent").path("draftId").asString();
        var page1 = call(owner, "list_trip_itinerary_drafts", Map.of("tripId", trip, "limit", 1)).path("structuredContent");
        var cursor = page1.path("nextCursor");
        var page2 = call(owner, "list_trip_itinerary_drafts", Map.of("tripId", trip, "limit", 1,
                "cursor", Map.of("createdAt", cursor.path("createdAt").asString(), "draftId", cursor.path("draftId").asString()))).path("structuredContent");
        assertEquals(Set.of(draftId, anotherDraft), Set.of(page1.path("items").get(0).path("draftId").asString(), page2.path("items").get(0).path("draftId").asString()));
        var requestInput = Map.<String, Object>of("tripId", trip, "draftId", draftId, "expectedRevision", 0, "expectedDraftRevision", 0, "requestId", "save-handoff");
        var saved = call(owner, "save_workbench_request", requestInput).path("structuredContent");
        String handoffId = saved.path("handoffId").asString();
        assertEquals("saved", saved.path("notification").asString());
        assertEquals(handoffId, call(owner, "save_workbench_request", requestInput).path("structuredContent").path("handoffId").asString());
        assertEquals("request_not_found", call(viewer, "read_workbench_request", Map.of("handoffId", handoffId)).path("structuredContent").path("code").asString());
        var begin = Map.<String, Object>of("tripId", trip, "handoffId", handoffId, "expectedRevision", 0, "requestId", "begin-handoff");
        assertTrue(call(owner, "begin_workbench_notification", begin).path("structuredContent").path("maySend").asBoolean());
        assertFalse(call(owner, "begin_workbench_notification", begin).path("structuredContent").path("maySend").asBoolean());
        assertEquals("notification_already_started", call(owner, "begin_workbench_notification", Map.of("tripId", trip, "handoffId", handoffId,
                "expectedRevision", 0, "requestId", "second-begin")).path("structuredContent").path("code").asString());
        var unknown = call(owner, "record_workbench_notification", Map.of("tripId", trip, "handoffId", handoffId, "expectedRevision", 0,
                "requestId", "handoff-unknown", "outcome", "unknown")).path("structuredContent");
        assertEquals("unknown", unknown.path("notification").asString());
        assertEquals("saved", unknown.path("workStatus").asString());
        var acknowledged = call(owner, "acknowledge_workbench_request", Map.of("tripId", trip, "handoffId", handoffId,
                "expectedRevision", 0, "requestId", "handoff-accepted")).path("structuredContent");
        assertEquals("accepted", acknowledged.path("workStatus").asString());
        assertEquals("unknown", acknowledged.path("notification").asString());
        var editInput = Map.<String, Object>of("tripId", trip, "draftId", draftId, "expectedRevision", 0, "expectedDraftRevision", 0,
                "requestId", "edit-visit", "stopId", "visit-2", "changes", Map.of("startLocal", "2026-11-01T08:00", "timeZone", "Europe/London", "durationMinutes", 30));
        var edited = call(owner, "edit_trip_itinerary_visit", editInput).path("structuredContent");
        assertEquals(1, edited.path("draftRevision").asInt());
        assertEquals("draft_revision_conflict", call(owner, "verify_trip_itinerary_draft", verifyInput).path("structuredContent").path("code").asString());
        assertEquals(2, edited.path("draft").path("stops").size());
        assertEquals("2026-11-01T05:30:00Z", edited.path("draft").path("stops").get(0).path("startAt").asString());
        assertEquals(0, edited.path("draft").path("timeConflicts").size());
        assertEquals(1, call(owner, "edit_trip_itinerary_visit", editInput).path("structuredContent").path("draftRevision").asInt());
        assertEquals("superseded", call(owner, "read_workbench_request", Map.of("handoffId", handoffId)).path("structuredContent").path("workStatus").asString());
        assertEquals("draft_revision_conflict", call(owner, "save_workbench_request", Map.of("tripId", trip, "draftId", draftId, "expectedRevision", 0,
                "expectedDraftRevision", 0, "requestId", "stale-draft-handoff")).path("structuredContent").path("code").asString());
        assertEquals("draft_revision_conflict", call(owner, "edit_trip_itinerary_visit", Map.of("tripId", trip, "draftId", draftId, "expectedRevision", 0,
                "expectedDraftRevision", 0, "requestId", "stale-edit", "stopId", "visit-2", "changes", Map.of("startLocal", "2026-11-01T09:00", "timeZone", "Europe/London", "durationMinutes", 30))).path("structuredContent").path("code").asString());
        assertEquals(0, call(owner, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("revision").asInt());
        assertEquals("trip_not_found", call(viewer, "list_trip_itinerary_drafts", Map.of("tripId", trip)).path("structuredContent").path("code").asString());
        call(owner, "grant_trip_access", Map.of("tripId", trip, "accountId", bob.toString(), "role", "viewer", "expectedAccessRevision", 0, "requestId", "draft-share"));
        assertEquals(2, call(viewer, "list_trip_itinerary_drafts", Map.of("tripId", trip)).path("structuredContent").path("items").size());
        assertFalse(call(viewer, "verify_trip_itinerary_draft", Map.of("tripId", trip, "draftId", draftId, "expectedRevision", 0, "expectedDraftRevision", 1))
                .path("isError").asBoolean());
        assertEquals("trip_not_found", call(viewer, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 0,
                "requestId", "viewer-draft", "stops", List.of(first))).path("structuredContent").path("code").asString());
        call(owner, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "draft-change-trip", "changes", Map.of("destination", "北京")));
        assertEquals("revision_conflict", call(owner, "verify_trip_itinerary_draft", verifyInput).path("structuredContent").path("code").asString());
        assertTrue(call(owner, "list_trip_itinerary_drafts", Map.of("tripId", trip)).path("structuredContent").path("items").get(0).path("stale").asBoolean());
        assertEquals("rejected", call(owner, "reject_trip_itinerary_draft", Map.of("tripId", trip, "draftId", draftId, "expectedRevision", 1,
                "requestId", "reject-draft")).path("structuredContent").path("status").asString());
        assertEquals("superseded", call(owner, "read_workbench_request", Map.of("handoffId", handoffId)).path("structuredContent").path("workStatus").asString());
        assertEquals("request_superseded", call(owner, "acknowledge_workbench_request", Map.of("tripId", trip, "handoffId", handoffId,
                "expectedRevision", 1, "requestId", "ack-rejected-draft")).path("structuredContent").path("code").asString());
        assertEquals("request_superseded", call(owner, "acknowledge_workbench_request", Map.of("tripId", trip, "handoffId", handoffId,
                "expectedRevision", 0, "requestId", "handoff-accepted")).path("structuredContent").path("code").asString());
        assertEquals("rejected", call(owner, "stage_trip_itinerary", draftInput).path("structuredContent").path("status").asString());
        call(owner, "reject_trip_itinerary_draft", Map.of("tripId", trip, "draftId", anotherDraft, "expectedRevision", 1, "requestId", "reject-draft-2"));
        assertEquals(0, call(owner, "list_trip_itinerary_drafts", Map.of("tripId", trip)).path("structuredContent").path("items").size());
        assertEquals(1, call(owner, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("revision").asInt());
    }

    @Test
    void itineraryWarnsWhenAVisitOverlapsUserRecordedTransportAndRechecksAfterEditing() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("transport-draft-owner", "Owner");
        String owner = token(alice, "travel:read travel:write");
        String trip = call(owner, "create_travel_workspace", Map.of("requestId", "transport-draft-trip", "brief", Map.of("destination", "上海市", "countryCode", "CN")))
                .path("structuredContent").path("tripId").asString();
        var transport = Map.<String, Object>of("transportId", "flight-one", "mode", "flight", "origin", "London", "destination", "New York",
                "departure", Map.of("local", "2026-11-10T12:00", "timeZone", "Europe/London"),
                "arrival", Map.of("local", "2026-11-10T16:00", "timeZone", "America/New_York"));
        assertEquals(1, call(owner, "save_confirmed_transport", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "transport-draft-flight", "transport", transport))
                .path("structuredContent").path("revision").asInt());
        var now = java.time.Instant.now();
        var source = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", now.toString(),
                "freshUntil", now.plusSeconds(1800).toString(), "domain", "play", "candidates", List.of(Map.of("sourceId", "poi-a", "name", "模拟地点", "domain", "play")));
        org.mockito.Mockito.doReturn(Mono.just(source)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq(""), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        String result = call(owner, "search_trip_places", Map.of("tripId", trip, "domain", "play")).path("structuredContent").path("resultId").asString();
        var visit = Map.<String, Object>of("stopId", "visit", "sourceResultId", result, "sourceId", "poi-a", "role", "activity",
                "startLocal", "2026-11-10T22:30", "timeZone", "Asia/Shanghai", "durationMinutes", 60);
        var boundary = Map.<String, Object>of("stopId", "arrival-boundary", "sourceResultId", result, "sourceId", "poi-a", "role", "activity",
                "startLocal", "2026-11-11T05:00", "timeZone", "Asia/Shanghai", "durationMinutes", 0);
        var draft = call(owner, "stage_trip_itinerary", Map.of("tripId", trip, "expectedRevision", 1, "requestId", "draft-with-flight", "stops", List.of(visit, boundary)))
                .path("structuredContent");
        String draftId = draft.path("draftId").asString();
        assertEquals(1, draft.path("draft").path("transportOverlaps").size());
        assertEquals("visit", draft.path("draft").path("transportOverlaps").get(0).path("stopId").asString());
        assertEquals("flight-one", draft.path("draft").path("transportOverlaps").get(0).path("transportId").asString());
        var edited = call(owner, "edit_trip_itinerary_visit", Map.of("tripId", trip, "draftId", draftId, "expectedRevision", 1, "expectedDraftRevision", 0,
                "requestId", "move-overlapping-visit", "stopId", "visit", "changes", Map.of("startLocal", "2026-11-11T08:00", "timeZone", "Asia/Shanghai", "durationMinutes", 60)))
                .path("structuredContent");
        assertEquals(0, edited.path("draft").path("transportOverlaps").size());
        assertFalse(edited.path("draft").path("canAdopt").asBoolean());
    }

    @Test
    void travelerUpdatesPreserveOtherPeopleAndExistingRequirements() throws Exception {
        UUID account = accounts.fromVerifiedGoogleSubject("travelers-test-owner", "Owner");
        String access = token(account, "travel:read travel:write");
        String trip = call(access, "create_travel_workspace", Map.of("requestId", "travelers-trip", "brief", Map.of("destination", "上海")))
                .path("structuredContent").path("tripId").asString();
        var first = Map.<String, Object>of("travelerId", "person-a", "displayName", "同行人甲", "careNeeds", Map.of(
                "mobility", Map.of("stepFreeRequired", true, "maxContinuousWalkMeters", 1000), "food", Map.of("exclusions", List.of("海鲜"))));
        var firstCall = Map.<String, Object>of("tripId", trip, "expectedRevision", 0, "requestId", "person-a-create", "traveler", first);
        assertEquals(1, call(access, "upsert_trip_traveler", firstCall).path("structuredContent").path("revision").asInt());
        var second = Map.<String, Object>of("travelerId", "person-b", "displayName", "同行人乙", "careNeeds", Map.of("stamina", Map.of("needsFrequentRest", true)));
        assertEquals(2, call(access, "upsert_trip_traveler", Map.of("tripId", trip, "expectedRevision", 1, "requestId", "person-b-create", "traveler", second))
                .path("structuredContent").path("revision").asInt());
        var patch = Map.<String, Object>of("travelerId", "person-a", "careNeeds", Map.of("mobility", Map.of("maxTransfers", 2), "food", Map.of("exclusions", List.of("花生"))));
        var updated = call(access, "upsert_trip_traveler", Map.of("tripId", trip, "expectedRevision", 2, "requestId", "person-a-update", "traveler", patch)).path("structuredContent");
        assertEquals(3, updated.path("revision").asInt());
        var travelers = updated.path("state").path("travelers");
        assertEquals(2, travelers.size());
        assertTrue(travelers.get(0).path("careNeeds").path("mobility").path("stepFreeRequired").asBoolean());
        assertEquals(1000, travelers.get(0).path("careNeeds").path("mobility").path("maxContinuousWalkMeters").asInt());
        assertEquals(2, travelers.get(0).path("careNeeds").path("food").path("exclusions").size());
        assertTrue(travelers.get(1).path("careNeeds").path("stamina").path("needsFrequentRest").asBoolean());
        assertEquals(3, call(access, "upsert_trip_traveler", firstCall).path("structuredContent").path("revision").asInt());
        assertEquals("sensitive_trip_input_blocked", call(access, "upsert_trip_traveler", Map.of("tripId", trip, "expectedRevision", 3,
                "requestId", "private-care", "traveler", Map.of("travelerId", "person-a", "diagnosis", "private"))).path("structuredContent").path("code").asString());
        assertEquals("invalid_traveler_constraints", call(access, "upsert_trip_traveler", Map.of("tripId", trip, "expectedRevision", 3,
                "requestId", "invalid-care", "traveler", Map.of("travelerId", "person-a", "careNeeds", Map.of("schedule", Map.of("earliestStartTime", "25:00")))))
                .path("structuredContent").path("code").asString());
        assertEquals(3, call(access, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("revision").asInt());
        var removePeanut = Map.<String, Object>of("tripId", trip, "expectedRevision", 3, "requestId", "remove-peanut", "travelerId", "person-a",
                "target", Map.of("type", "food_exclusion", "value", "花生"));
        var afterFood = call(access, "remove_trip_traveler_requirement", removePeanut).path("structuredContent");
        assertEquals(4, afterFood.path("revision").asInt());
        assertEquals("海鲜", afterFood.path("state").path("travelers").get(0).path("careNeeds").path("food").path("exclusions").get(0).asString());
        assertEquals(2, afterFood.path("state").path("travelers").size());
        assertEquals(4, call(access, "remove_trip_traveler_requirement", removePeanut).path("structuredContent").path("revision").asInt());
        assertEquals("revision_conflict", call(access, "remove_trip_traveler_requirement", Map.of("tripId", trip, "expectedRevision", 3,
                "requestId", "stale-care", "travelerId", "person-a", "target", Map.of("type", "care", "group", "mobility", "field", "maxTransfers")))
                .path("structuredContent").path("code").asString());
        assertEquals("invalid_traveler_constraints", call(access, "remove_trip_traveler_requirement", Map.of("tripId", trip, "expectedRevision", 4,
                "requestId", "broad-food", "travelerId", "person-a", "target", Map.of("type", "care", "group", "food", "field", "exclusions")))
                .path("structuredContent").path("code").asString());
        var afterCare = call(access, "remove_trip_traveler_requirement", Map.of("tripId", trip, "expectedRevision", 4,
                "requestId", "remove-transfer", "travelerId", "person-a", "target", Map.of("type", "care", "group", "mobility", "field", "maxTransfers")))
                .path("structuredContent");
        assertEquals(5, afterCare.path("revision").asInt());
        assertTrue(afterCare.path("state").path("travelers").get(0).path("careNeeds").path("mobility").path("stepFreeRequired").asBoolean());
        assertTrue(afterCare.path("state").path("travelers").get(1).path("careNeeds").path("stamina").path("needsFrequentRest").asBoolean());
        var removePerson = Map.<String, Object>of("tripId", trip, "expectedRevision", 5, "requestId", "remove-person-b", "travelerId", "person-b", "target", Map.of("type", "traveler"));
        assertEquals(6, call(access, "remove_trip_traveler_requirement", removePerson).path("structuredContent").path("revision").asInt());
        assertEquals(1, call(access, "remove_trip_traveler_requirement", removePerson).path("structuredContent").path("state").path("travelers").size());
        assertEquals(6, call(access, "remove_trip_traveler_requirement", removePeanut).path("structuredContent").path("revision").asInt());
        String intruder = token(accounts.fromVerifiedGoogleSubject("travelers-other", "Other"), "travel:read travel:write");
        assertEquals("trip_not_found", call(intruder, "remove_trip_traveler_requirement", Map.of("tripId", trip, "expectedRevision", 6,
                "requestId", "unauthorized-removal", "travelerId", "person-a", "target", Map.of("type", "traveler"))).path("structuredContent").path("code").asString());
        var transport = Map.<String, Object>of("transportId", "return", "mode", "train", "number", "G123", "origin", "上海", "destination", "北京",
                "departure", Map.of("local", "2026-11-20T09:00", "timeZone", "Asia/Shanghai"),
                "arrival", Map.of("local", "2026-11-20T15:00", "timeZone", "Asia/Shanghai"), "travelerIds", List.of("person-a"));
        var saveTransport = Map.<String, Object>of("tripId", trip, "expectedRevision", 6, "requestId", "train-fact", "transport", transport);
        var savedTransport = call(access, "save_confirmed_transport", saveTransport).path("structuredContent");
        assertEquals(7, savedTransport.path("revision").asInt());
        assertFalse(savedTransport.path("state").path("confirmedTransport").get(0).path("verified").asBoolean(true));
        assertEquals("2026-11-20T01:00:00Z", savedTransport.path("state").path("confirmedTransport").get(0).path("departure").path("instant").asString());
        assertEquals("scope_change_needs_planning_rules", call(access, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 7,
                "requestId", "destination-after-train", "changes", Map.of("destination", "天津"))).path("structuredContent").path("code").asString());
        assertEquals(8, call(access, "remove_confirmed_transport", Map.of("tripId", trip, "expectedRevision", 7,
                "requestId", "remove-train", "transportId", "return")).path("structuredContent").path("revision").asInt());
        assertEquals(8, call(access, "save_confirmed_transport", saveTransport).path("structuredContent").path("revision").asInt());
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = { REDIRECT, "http://127.0.0.1:4321/callback/registered" })
    void oauthDiscoveryConsentAndTokenFlowBindTheBrowserAndClient(String redirectUri) throws Exception {
        var metadata = get("/.well-known/oauth-protected-resource/mcp", null);
        assertEquals(200, metadata.statusCode());
        assertEquals(settings.resource(), JSON.readTree(metadata.body()).path("resource").asString());
        assertEquals(200, get("/.well-known/oauth-authorization-server", null).statusCode());
        var registration = send("/oauth/register", "application/json", JSON.writeValueAsString(Map.of("client_name", "<client>", "redirect_uris", List.of(redirectUri))), null);
        assertEquals(201, registration.statusCode());
        String client = JSON.readTree(registration.body()).path("client_id").asString();
        assertEquals(400, send("/oauth/register", "application/json", JSON.writeValueAsString(Map.of("redirect_uris", List.of("https://attacker.example"))), null).statusCode());

        String verifier = "x".repeat(43);
        String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        String authorize = "/oauth/authorize?response_type=code&client_id=" + enc(client) + "&redirect_uri=" + enc(redirectUri)
                + "&state=" + enc("host-state") + "&code_challenge=" + challenge + "&code_challenge_method=S256&scope="
                + enc("travel:read travel:write") + "&resource=" + enc(settings.resource());
        assertEquals(503, get(authorize, null).statusCode());
        org.mockito.Mockito.when(google.configured()).thenReturn(true);
        org.mockito.Mockito.when(google.clientId()).thenReturn("test-google-client");
        org.mockito.Mockito.when(google.callback()).thenReturn("https://travel.example.com/oauth/google/callback");
        org.mockito.Mockito.when(google.exchange(org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.anyString()))
                .thenReturn(Mono.just(new GoogleIdentityClient.Identity("test-google-subject", "Traveler")));
        var start = get(authorize, null);
        assertEquals(302, start.statusCode());
        String googleLocation = start.headers().firstValue("Location").orElseThrow();
        assertEquals("openid profile email", java.net.URLDecoder.decode(
                UriComponentsBuilder.fromUriString(googleLocation).build().getQueryParams().getFirst("scope"), StandardCharsets.UTF_8));
        String cookie = start.headers().firstValue("Set-Cookie").orElseThrow().split(";", 2)[0];
        String state = UriComponentsBuilder.fromUriString(googleLocation).build().getQueryParams().getFirst("state");
        String callback = "/oauth/google/callback?state=" + state + "&code=test-code&iss=" + enc("https://accounts.google.com");
        assertEquals(400, get(callback, null).statusCode());
        var authenticated = get(callback, cookie);
        assertEquals(302, authenticated.statusCode());
        assertEquals(400, get(callback, cookie).statusCode());
        String consent = authenticated.headers().firstValue("Location").orElseThrow();
        assertEquals(400, get(consent, null).statusCode());
        var page = get(consent, cookie);
        assertEquals(200, page.statusCode());
        assertTrue(page.body().contains("&lt;client&gt;"));
        var approval = send("/oauth/consent", "application/x-www-form-urlencoded", "state=" + state + "&decision=approve", cookie);
        assertEquals(302, approval.statusCode());
        URI redirect = URI.create(approval.headers().firstValue("Location").orElseThrow());
        assertEquals(URI.create(redirectUri).getHost(), redirect.getHost());
        var redirectQuery = UriComponentsBuilder.fromUri(redirect).build().getQueryParams();
        assertEquals("host-state", redirectQuery.getFirst("state"));
        String code = redirectQuery.getFirst("code");
        assertEquals(400, send("/oauth/consent", "application/x-www-form-urlencoded", "state=" + state + "&decision=approve", cookie).statusCode());
        String tokenForm = "grant_type=authorization_code&client_id=" + enc(client) + "&code=" + enc(code) + "&code_verifier="
                + verifier + "&redirect_uri=" + enc(redirectUri) + "&resource=" + enc(settings.resource());
        var issued = send("/oauth/token", "application/x-www-form-urlencoded", tokenForm, null);
        assertEquals(200, issued.statusCode());
        String access = JSON.readTree(issued.body()).path("access_token").asString();
        assertEquals("Traveler", call(access, "get_profile", Map.of()).path("structuredContent").path("name").asString());
        assertEquals(400, send("/oauth/token", "application/x-www-form-urlencoded", tokenForm, null).statusCode());
    }

    @Test
    void workerHttpRequiresItsOwnCredentialAndFencesAnInterruptedRun() throws Exception {
        UUID alice = accounts.fromVerifiedGoogleSubject("worker-http-alice", "Alice");
        String access = token(alice, "travel:read travel:write");
        String trip = call(access, "create_travel_workspace", Map.of("requestId", "worker-trip", "brief", Map.of("destination", "上海")))
                .path("structuredContent").path("tripId").asString();
        String task = call(access, "delegate_trip_task", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "worker-task", "objective", "研究旅行要求"))
                .path("structuredContent").path("taskId").asString();
        assertFalse(task.isBlank());
        var listedTask = call(access, "list_trip_tasks", Map.of("tripId", trip)).path("structuredContent").path("items").get(0);
        assertEquals(task, listedTask.path("taskId").asString());
        assertEquals("queued", listedTask.path("status").asString());
        assertEquals(401, worker("claim", null, Map.of()).statusCode());
        assertEquals(401, worker("claim", "x".repeat(43), Map.of()).statusCode());
        var claimed = worker("claim", WORKER_TOKEN, Map.of());
        assertEquals(200, claimed.statusCode());
        JsonNode run = JSON.readTree(claimed.body());
        assertEquals(task, run.path("taskId").asString());
        var identity = Map.<String, Object>of("taskId", task, "generation", run.path("generation").asLong(), "leaseId", run.path("leaseId").asString());
        assertEquals(200, worker("context", WORKER_TOKEN, identity).statusCode());
        assertEquals(200, worker("heartbeat", WORKER_TOKEN, identity).statusCode());
        var at = java.time.Instant.now();
        var fixture = Map.<String, Object>of("status", "completed", "provider", "amap_weather", "coverage", "partial",
                "checkedAt", at.toString(), "freshUntil", at.plusSeconds(3600).toString(), "forecastDays", List.of());
        org.mockito.Mockito.doReturn(Mono.just(fixture)).when(weather).forecast(org.mockito.ArgumentMatchers.anyMap());
        var observed = worker("weather", WORKER_TOKEN, identity);
        assertEquals(200, observed.statusCode());
        String resultId = JSON.readTree(observed.body()).path("resultId").asString();
        assertFalse(resultId.isBlank());
        assertEquals(resultId, call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("checkpoint").path("weatherResultId").asString());
        // This valid generated UUID contains a digit run that resembles a Luhn-valid card number.
        String digitHeavyResultId = "b64f930d-3698-4308-8977-2e1cfa5d5c73";
        jdbc.update("UPDATE travel_result_references SET result_id=? WHERE result_id=?", UUID.fromString(digitHeavyResultId), UUID.fromString(resultId));
        jdbc.update("UPDATE travel_planning_tasks SET checkpoint=jsonb_set(checkpoint,'{weatherResultId}',to_jsonb(?::text)) WHERE task_id=?", digitHeavyResultId, UUID.fromString(task));
        var placeFixture = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", at.toString(),
                "freshUntil", at.plusSeconds(1800).toString(), "domain", "play", "keyword", "博物馆", "page", 1, "pageSize", 10,
                "candidates", List.of(Map.of("sourceId", "fixture-from", "name", "起点", "coordinates", Map.of("longitude", 121.47, "latitude", 31.23, "coordinateSystem", "GCJ-02")),
                        Map.of("sourceId", "fixture-to", "name", "终点", "coordinates", Map.of("longitude", 121.48, "latitude", 31.24, "coordinateSystem", "GCJ-02"))));
        org.mockito.Mockito.doReturn(Mono.just(placeFixture)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq("博物馆"), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        var placeQuery = new java.util.LinkedHashMap<>(identity);
        placeQuery.put("domain", "play"); placeQuery.put("keyword", "博物馆"); placeQuery.put("page", 1); placeQuery.put("pageSize", 10);
        var found = worker("places", WORKER_TOKEN, placeQuery);
        assertEquals(200, found.statusCode(), found.body());
        String placeResult = JSON.readTree(found.body()).path("resultId").asString();
        assertFalse(placeResult.isBlank());
        assertEquals(placeResult, JSON.readTree(worker("places", WORKER_TOKEN, placeQuery).body()).path("resultId").asString());
        org.mockito.Mockito.verify(places, org.mockito.Mockito.times(1)).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq("博物馆"), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        assertEquals(placeResult, call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent")
                .path("checkpoint").path("placeSearches").get(0).path("resultId").asString());
        var walkingFixture = Map.<String, Object>of("status", "completed", "provider", "amap_walking_route", "coverage", "query", "checkedAt", at.toString(),
                "freshUntil", at.plusSeconds(900).toString(), "alternatives", List.of(Map.of("sourceIndex", 0, "distanceMeters", 900, "durationSeconds", 700)), "unusable", List.of());
        org.mockito.Mockito.doReturn(Mono.just(walkingFixture)).when(walking).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        var walkingQuery = new java.util.LinkedHashMap<>(identity);
        walkingQuery.put("origin", Map.of("resultId", placeResult, "sourceId", "fixture-from"));
        walkingQuery.put("destination", Map.of("resultId", placeResult, "sourceId", "fixture-to"));
        var walked = worker("walking", WORKER_TOKEN, walkingQuery);
        assertEquals(200, walked.statusCode(), walked.body());
        String walkingResult = JSON.readTree(walked.body()).path("resultId").asString();
        assertFalse(walkingResult.isBlank());
        assertEquals(walkingResult, JSON.readTree(worker("walking", WORKER_TOKEN, walkingQuery).body()).path("resultId").asString());
        org.mockito.Mockito.verify(walking, org.mockito.Mockito.times(1)).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        assertEquals(walkingResult, call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent")
                .path("checkpoint").path("walkingSearches").get(0).path("resultId").asString());
        var flightParams = Map.of("carrier", "MU", "flight", "5101", "departureAirportIata", "SHA", "departureDateLocal", "2026-11-07");
        var flightFixture = Map.<String, Object>of("status", "completed", "provider", "cirium_flight_status", "coverage", "query",
                "checkedAt", at.toString(), "freshUntil", at.plusSeconds(900).toString(), "query", flightParams,
                "candidates", List.of(Map.of("flightNumber", "5101", "bookingMatchConfirmed", false)));
        org.mockito.Mockito.doReturn(Mono.just(flightFixture)).when(flightStatus).lookup("MU", "5101", "SHA", "2026-11-07");
        var flightQuery = new java.util.LinkedHashMap<>(identity); flightQuery.putAll(flightParams);
        var flightFound = worker("flightstatus", WORKER_TOKEN, flightQuery);
        assertEquals(200, flightFound.statusCode());
        String flightResult = JSON.readTree(flightFound.body()).path("resultId").asString();
        assertFalse(flightResult.isBlank());
        assertFalse(JSON.readTree(flightFound.body()).path("data").path("candidates").get(0).path("bookingMatchConfirmed").asBoolean());
        assertEquals(flightResult, JSON.readTree(worker("flightstatus", WORKER_TOKEN, flightQuery).body()).path("resultId").asString());
        org.mockito.Mockito.verify(flightStatus, org.mockito.Mockito.times(1)).lookup("MU", "5101", "SHA", "2026-11-07");
        assertEquals(flightResult, call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent")
                .path("checkpoint").path("flightSearches").get(0).path("resultId").asString());
        var invalidFlight = new java.util.LinkedHashMap<>(flightQuery); invalidFlight.put("flight", "invalid");
        assertEquals(400, worker("flightstatus", WORKER_TOKEN, invalidFlight).statusCode());
        var extra = new java.util.LinkedHashMap<>(flightQuery); extra.put("url", "https://example.invalid");
        assertEquals(400, worker("flightstatus", WORKER_TOKEN, extra).statusCode());
        assertEquals("paused", call(access, "take_over_trip_task", Map.of("taskId", task, "expectedRevision", 0, "requestId", "take-over"))
                .path("structuredContent").path("status").asString());
        assertEquals("paused", call(access, "delegate_trip_task", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "worker-task", "objective", "研究旅行要求"))
                .path("structuredContent").path("status").asString());
        assertEquals(409, worker("heartbeat", WORKER_TOKEN, identity).statusCode());
        assertEquals(409, worker("weather", WORKER_TOKEN, identity).statusCode());
        assertEquals(409, worker("places", WORKER_TOKEN, placeQuery).statusCode());
        assertEquals(409, worker("flightstatus", WORKER_TOKEN, flightQuery).statusCode());
        assertEquals(409, worker("walking", WORKER_TOKEN, walkingQuery).statusCode());
        assertEquals("queued", call(access, "hand_back_trip_task", Map.of("taskId", task, "expectedRevision", 0, "requestId", "hand-back"))
                .path("structuredContent").path("status").asString());
        var resumed = JSON.readTree(worker("claim", WORKER_TOKEN, Map.of()).body());
        assertTrue(resumed.path("generation").asLong() > run.path("generation").asLong());
        var resumedFlight = new java.util.LinkedHashMap<String, Object>(flightParams);
        resumedFlight.put("taskId", task); resumedFlight.put("generation", resumed.path("generation").asLong()); resumedFlight.put("leaseId", resumed.path("leaseId").asString());
        assertEquals(flightResult, JSON.readTree(worker("flightstatus", WORKER_TOKEN, resumedFlight).body()).path("resultId").asString());
        org.mockito.Mockito.verify(flightStatus, org.mockito.Mockito.times(1)).lookup("MU", "5101", "SHA", "2026-11-07");
        var resumedWalking = new java.util.LinkedHashMap<>(walkingQuery);
        resumedWalking.put("generation", resumed.path("generation").asLong()); resumedWalking.put("leaseId", resumed.path("leaseId").asString());
        assertEquals(walkingResult, JSON.readTree(worker("walking", WORKER_TOKEN, resumedWalking).body()).path("resultId").asString());
        org.mockito.Mockito.verify(walking, org.mockito.Mockito.times(1)).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        jdbc.update("UPDATE travel_result_references SET data=NULL WHERE result_id=?", UUID.fromString(placeResult));
        var noLongerAvailable = worker("walking", WORKER_TOKEN, resumedWalking);
        assertEquals(400, noLongerAvailable.statusCode());
        assertEquals("result_expired", JSON.readTree(noLongerAvailable.body()).path("error").asString());
        var output = Map.<String, Object>of("kind", "needs_context", "summary", "来源暂不可用", "evidenceIds", List.of(), "unknowns", List.of("天气来源"));
        var finish = Map.<String, Object>of("taskId", task, "generation", resumed.path("generation").asLong(),
                "leaseId", resumed.path("leaseId").asString(), "output", output);
        assertEquals(200, worker("finish", WORKER_TOKEN, finish).statusCode());
        assertEquals("needs_context", call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("status").asString());
        assertEquals("needs_context", call(access, "list_trip_tasks", Map.of("tripId", trip)).path("structuredContent").path("items").get(0).path("status").asString());
        assertEquals(0, call(access, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("revision").asInt());
        call(access, "update_trip_scope", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "worker-trip-changed", "changes", Map.of("destination", "北京")));
        assertTrue(call(access, "list_trip_tasks", Map.of("tripId", trip)).path("structuredContent").path("items").get(0).path("stale").asBoolean());
    }

    @Test
    void flightSourceFinishingAfterTakeoverCannotSaveEvidence() throws Exception {
        UUID account = accounts.fromVerifiedGoogleSubject("worker-flight-fence", "Traveler");
        String access = token(account, "travel:read travel:write");
        String trip = call(access, "create_travel_workspace", Map.of("requestId", "flight-fence-trip"))
                .path("structuredContent").path("tripId").asString();
        String task = call(access, "delegate_trip_task", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "flight-fence-task", "objective", "检查航班"))
                .path("structuredContent").path("taskId").asString();
        var run = JSON.readTree(worker("claim", WORKER_TOKEN, Map.of()).body());
        var params = Map.of("carrier", "CA", "flight", "1001", "departureAirportIata", "PEK", "departureDateLocal", "2026-11-07");
        var query = new java.util.LinkedHashMap<String, Object>(params);
        query.put("taskId", task); query.put("generation", run.path("generation").asLong()); query.put("leaseId", run.path("leaseId").asString());
        var entered = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var at = java.time.Instant.now();
        var fixture = Map.<String, Object>of("status", "completed", "provider", "cirium_flight_status", "coverage", "query", "query", params,
                "checkedAt", at.toString(), "freshUntil", at.plusSeconds(900).toString(), "candidates", List.of());
        org.mockito.Mockito.doReturn(Mono.fromCallable(() -> {
            entered.countDown();
            if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new IllegalStateException("test_timeout");
            return fixture;
        })).when(flightStatus).lookup("CA", "1001", "PEK", "2026-11-07");
        var late = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try { return worker("flightstatus", WORKER_TOKEN, query); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        try {
            assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals("paused", call(access, "take_over_trip_task", Map.of("taskId", task, "expectedRevision", 0, "requestId", "flight-fence-takeover"))
                    .path("structuredContent").path("status").asString());
        } finally { release.countDown(); }
        assertEquals(409, late.get(10, java.util.concurrent.TimeUnit.SECONDS).statusCode());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM travel_result_references WHERE trip_id=? AND kind='flight_status'", Integer.class, UUID.fromString(trip)));
        assertTrue(call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("checkpoint").path("flightSearches").isMissingNode());
    }

    @Test
    void walkingSourceFinishingAfterTakeoverCannotSaveEvidence() throws Exception {
        UUID account = accounts.fromVerifiedGoogleSubject("worker-walking-fence", "Traveler");
        String access = token(account, "travel:read travel:write");
        String trip = call(access, "create_travel_workspace", Map.of("requestId", "walking-fence-trip", "brief", Map.of("destination", "上海", "countryCode", "CN")))
                .path("structuredContent").path("tripId").asString();
        var at = java.time.Instant.now();
        var placeFixture = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", at.toString(),
                "freshUntil", at.plusSeconds(1800).toString(), "domain", "play", "candidates", List.of(
                        Map.of("sourceId", "from", "name", "起点", "coordinates", Map.of("longitude", 121.47, "latitude", 31.23, "coordinateSystem", "GCJ-02")),
                        Map.of("sourceId", "to", "name", "终点", "coordinates", Map.of("longitude", 121.48, "latitude", 31.24, "coordinateSystem", "GCJ-02"))));
        org.mockito.Mockito.doReturn(Mono.just(placeFixture)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq(""), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        String reference = call(access, "search_trip_places", Map.of("tripId", trip, "domain", "play")).path("structuredContent").path("resultId").asString();
        String task = call(access, "delegate_trip_task", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "walking-fence-task", "objective", "检查步行"))
                .path("structuredContent").path("taskId").asString();
        var run = JSON.readTree(worker("claim", WORKER_TOKEN, Map.of()).body());
        var query = Map.<String, Object>of("taskId", task, "generation", run.path("generation").asLong(), "leaseId", run.path("leaseId").asString(),
                "origin", Map.of("resultId", reference, "sourceId", "from"), "destination", Map.of("resultId", reference, "sourceId", "to"));
        var entered = new java.util.concurrent.CountDownLatch(1); var release = new java.util.concurrent.CountDownLatch(1);
        var route = Map.<String, Object>of("status", "completed", "provider", "amap_walking_route", "coverage", "query", "checkedAt", at.toString(),
                "freshUntil", at.plusSeconds(900).toString(), "alternatives", List.of(), "unusable", List.of());
        org.mockito.Mockito.doReturn(Mono.fromCallable(() -> {
            entered.countDown();
            if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) throw new IllegalStateException("test_timeout");
            return route;
        })).when(walking).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        var late = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try { return worker("walking", WORKER_TOKEN, query); }
            catch (Exception error) { throw new RuntimeException(error); }
        });
        try {
            assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals("paused", call(access, "take_over_trip_task", Map.of("taskId", task, "expectedRevision", 0, "requestId", "walking-fence-takeover"))
                    .path("structuredContent").path("status").asString());
        } finally { release.countDown(); }
        assertEquals(409, late.get(10, java.util.concurrent.TimeUnit.SECONDS).statusCode());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM travel_result_references WHERE trip_id=? AND kind='walking_route'", Integer.class, UUID.fromString(trip)));
        assertTrue(call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("checkpoint").path("walkingSearches").isMissingNode());
    }

    @Test
    @org.junit.jupiter.api.condition.EnabledIfSystemProperty(named = "travel.pi.required", matches = "true")
    void piExecutorUsesRealWorkerHttpButSimulatedModel() throws Exception {
        UUID account = accounts.fromVerifiedGoogleSubject("pi-http-test-subject", "Pi test");
        String access = token(account, "travel:read travel:write");
        String trip = call(access, "create_travel_workspace", Map.of("requestId", "pi-test-trip", "brief", Map.of("destination", "上海", "countryCode", "CN")))
                .path("structuredContent").path("tripId").asString();
        String task = call(access, "delegate_trip_task", Map.of("tripId", trip, "expectedRevision", 0, "requestId", "pi-test-task", "objective", "检查旅行要求"))
                .path("structuredContent").path("taskId").asString();
        var at = java.time.Instant.now();
        var placeFixture = Map.<String, Object>of("status", "completed", "provider", "amap_places", "coverage", "page", "checkedAt", at.toString(),
                "freshUntil", at.plusSeconds(1800).toString(), "domain", "play", "keyword", "博物馆", "page", 1, "pageSize", 10,
                "candidates", List.of(Map.of("sourceId", "fixture-from", "name", "起点", "coordinates", Map.of("longitude", 121.47, "latitude", 31.23, "coordinateSystem", "GCJ-02")),
                        Map.of("sourceId", "fixture-to", "name", "终点", "coordinates", Map.of("longitude", 121.48, "latitude", 31.24, "coordinateSystem", "GCJ-02"))));
        org.mockito.Mockito.doReturn(Mono.just(placeFixture)).when(places).search(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.eq("play"),
                org.mockito.ArgumentMatchers.eq("博物馆"), org.mockito.ArgumentMatchers.eq(1), org.mockito.ArgumentMatchers.eq(10));
        String placeResult = call(access, "search_trip_places", Map.of("tripId", trip, "domain", "play", "keyword", "博物馆"))
                .path("structuredContent").path("resultId").asString();
        var walkingFixture = Map.<String, Object>of("status", "completed", "provider", "amap_walking_route", "coverage", "query", "checkedAt", at.toString(),
                "freshUntil", at.plusSeconds(900).toString(), "alternatives", List.of(Map.of("sourceIndex", 0, "distanceMeters", 900, "durationSeconds", 700)), "unusable", List.of());
        org.mockito.Mockito.doReturn(Mono.just(walkingFixture)).when(walking).lookup(org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap(), org.mockito.ArgumentMatchers.anyMap());
        var flightQuery = Map.of("carrier", "MU", "flight", "5101", "departureAirportIata", "SHA", "departureDateLocal", "2026-11-07");
        var flightFixture = Map.<String, Object>of("status", "completed", "provider", "cirium_flight_status", "coverage", "query", "query", flightQuery,
                "checkedAt", at.toString(), "freshUntil", at.plusSeconds(900).toString(), "candidates", List.of());
        org.mockito.Mockito.doReturn(Mono.just(flightFixture)).when(flightStatus).lookup("MU", "5101", "SHA", "2026-11-07");
        var process = new ProcessBuilder("node", "../../services/planning-worker/tests/java-integration.mjs").redirectErrorStream(true);
        process.environment().put("TRAVEL_TEST_SERVICE_URL", "http://127.0.0.1:" + port);
        process.environment().put("TRAVEL_TEST_WORKER_TOKEN", WORKER_TOKEN);
        process.environment().put("TRAVEL_TEST_PLACE_RESULT", placeResult);
        var child = process.start();
        assertTrue(child.waitFor(30, java.util.concurrent.TimeUnit.SECONDS));
        assertEquals(0, child.exitValue(), new String(child.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
        assertEquals("needs_context", call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("status").asString());
        assertFalse(call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("checkpoint").path("placeSearches").get(0).path("resultId").asString().isBlank());
        assertFalse(call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("checkpoint").path("flightSearches").get(0).path("resultId").asString().isBlank());
        assertFalse(call(access, "get_trip_task", Map.of("taskId", task)).path("structuredContent").path("checkpoint").path("walkingSearches").get(0).path("resultId").asString().isBlank());
        assertEquals(0, call(access, "get_travel_workspace", Map.of("tripId", trip)).path("structuredContent").path("revision").asInt());
    }

    private String token(UUID account, String scope) throws Exception {
        String client = (String) grants.registerClient("isolated test", List.of(REDIRECT)).get("client_id");
        String verifier = "a".repeat(43);
        String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        String pending = grants.beginAuthorization(client, REDIRECT, "test-state", challenge, "S256", scope, settings.resource());
        var code = grants.completeVerifiedGoogle(pending, account);
        return grants.exchangeCode(client, code.code(), verifier, REDIRECT, settings.resource()).accessToken();
    }

    private JsonNode call(String token, String name, Map<String, Object> arguments) throws Exception {
        var response = request(token, null, Map.of("jsonrpc", "2.0", "id", 1, "method", "tools/call", "params", Map.of("name", name, "arguments", arguments)));
        assertEquals(200, response.statusCode(), response.body());
        JsonNode envelope = JSON.readTree(response.body());
        assertFalse(envelope.has("error"), response.body());
        return envelope.path("result");
    }

    private HttpResponse<String> request(String token, String origin, Map<String, Object> body) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/mcp"))
                .header("Content-Type", "application/json").header("Accept", "application/json, text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        if (token != null) request.header("Authorization", "Bearer " + token);
        if (origin != null) request.header("Origin", origin);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> get(String path, String cookie) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).GET();
        if (cookie != null) request.header("Cookie", cookie);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> send(String path, String type, String body, String cookie) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).header("Content-Type", type)
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (cookie != null) request.header("Cookie", cookie);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> worker(String path, String token, Map<String, Object> body) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/internal/worker/" + path))
                .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body)));
        if (token != null) request.header("Authorization", "Bearer " + token);
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String enc(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8); }
}
