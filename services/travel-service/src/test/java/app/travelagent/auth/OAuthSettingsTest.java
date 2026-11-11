package app.travelagent.auth;

import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class OAuthSettingsTest {
    @Test void productionAcceptsOnlyTheExplicitNativeLoopbackCallbackAndKeepsTheIssuerHttps() {
        String callback = "http://127.0.0.1:4321/callback/registered";
        var environment = new MockEnvironment().withProperty("TRAVEL_PUBLIC_ORIGIN", "https://travel.example.com")
                .withProperty("TRAVEL_MCP_REDIRECT_URIS", callback);
        var settings = new OAuthSettings(environment);
        assertTrue(settings.configured());
        assertTrue(settings.allowsRedirect(callback));
        for (String rejected : new String[] { "http://127.0.0.1:4322/callback/registered", "http://127.0.0.1:4321/callback/other",
                "http://localhost:4321/callback/registered", "http://attacker.example:4321/callback/registered", callback + "#fragment" })
            assertFalse(settings.allowsRedirect(rejected));
        environment.setProperty("TRAVEL_PUBLIC_ORIGIN", "http://127.0.0.1:4321");
        assertFalse(new OAuthSettings(environment).configured());
    }
}
