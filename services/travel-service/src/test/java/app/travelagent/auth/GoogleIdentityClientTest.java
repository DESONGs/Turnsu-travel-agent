package app.travelagent.auth;

import static org.junit.jupiter.api.Assertions.*;

import app.travelagent.core.TravelError;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.reactive.function.client.WebClient;

/** Claim handling is tested separately; this does not represent a real Google login. */
class GoogleIdentityClientTest {
    private final GoogleIdentityClient client = new GoogleIdentityClient(
            new MockEnvironment().withProperty("TRAVEL_GOOGLE_CLIENT_ID", "test-client").withProperty("TRAVEL_GOOGLE_CLIENT_SECRET", "test-secret"),
            new OAuthSettings("https://travel.example.com", "https://chatgpt.com/connector_platform_oauth_redirect", false), WebClient.builder());

    @Test
    void emailDirectoryIdentityRequiresAValidVerifiedClaim() {
        var gmail = client.verifiedIdentity(token("bob@gmail.com", true, null), OAuthGrants.hash("nonce"));
        assertEquals("stable-subject", gmail.subject());
        assertEquals("bob@gmail.com", gmail.verifiedEmail());
        assertTrue(gmail.emailAuthoritative());
        assertFalse(gmail.toString().contains("bob@gmail.com"));
        var workspace = client.verifiedIdentity(token("bob@example.com", true, "example.com"), OAuthGrants.hash("nonce"));
        assertTrue(workspace.emailAuthoritative());
        var external = client.verifiedIdentity(token("bob@example.com", true, null), OAuthGrants.hash("nonce"));
        assertFalse(external.emailAuthoritative());
        var unverified = client.verifiedIdentity(token("bob@gmail.com", false, null), OAuthGrants.hash("nonce"));
        assertNull(unverified.verifiedEmail());
        assertFalse(unverified.emailAuthoritative());
        assertEquals("invalid_google_identity", assertThrows(TravelError.class,
                () -> client.verifiedIdentity(token("bob@gmail.com", true, null), OAuthGrants.hash("different"))).code());
    }

    private static Jwt token(String email, boolean verified, String hostedDomain) {
        var builder = Jwt.withTokenValue("test-token").header("alg", "RS256").claim("sub", "stable-subject")
                .claim("aud", List.of("test-client")).claim("nonce", "nonce").claim("email", email).claim("email_verified", verified)
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(3600));
        if (hostedDomain != null) builder.claim("hd", hostedDomain);
        return builder.build();
    }
}
