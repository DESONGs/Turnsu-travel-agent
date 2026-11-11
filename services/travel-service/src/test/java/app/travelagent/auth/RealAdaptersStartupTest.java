package app.travelagent.auth;

import static org.junit.jupiter.api.Assertions.*;

import app.travelagent.provider.AmapWeatherClient;
import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Actual service beans are constructed; no real provider credentials or network calls are used. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class RealAdaptersStartupTest {
    private static final EmbeddedPostgres POSTGRES = database();
    @Autowired GoogleIdentityClient google;
    @Autowired AmapWeatherClient weather;

    private static EmbeddedPostgres database() {
        try { return EmbeddedPostgres.builder().setPort(0).start(); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }
    @DynamicPropertySource static void properties(DynamicPropertyRegistry p) {
        p.add("spring.datasource.url", () -> POSTGRES.getJdbcUrl("postgres", "postgres"));
        p.add("spring.datasource.username", () -> "postgres");
        p.add("spring.datasource.password", () -> "");
        p.add("TRAVEL_FOLLOW_UP_SCHEDULER_ENABLED", () -> "false");
        p.add("TRAVEL_PUBLIC_ORIGIN", () -> "https://travel.example.com");
        p.add("TRAVEL_MCP_REDIRECT_URIS", () -> "https://chatgpt.com/connector_platform_oauth_redirect");
    }
    @AfterAll static void stop() throws Exception { POSTGRES.close(); }
    @Test void serviceStartsAndUnconfiguredProvidersFailClosed() {
        assertFalse(google.configured());
        assertEquals("provider_unavailable", weather.forecast(Map.of("destination", "上海", "countryCode", "CN")).block().get("status"));
    }
}
