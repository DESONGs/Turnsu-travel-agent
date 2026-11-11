package app.travelagent.auth;

import app.travelagent.core.TravelError;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Map;
import org.springframework.core.env.Environment;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

/** Google is only an identity provider. Its access token is never persisted or sent to a model. */
@Component
public class GoogleIdentityClient {
    static final String ISSUER = "https://accounts.google.com";
    static final String AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
    private static final String TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
    private static final String KEYS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";
    private final String clientId;
    private final String clientSecret;
    private final OAuthSettings settings;
    private final WebClient http;
    private final NimbusReactiveJwtDecoder decoder;

    public GoogleIdentityClient(Environment environment, OAuthSettings settings, WebClient.Builder http) {
        this.clientId = environment.getProperty("TRAVEL_GOOGLE_CLIENT_ID", "");
        this.clientSecret = environment.getProperty("TRAVEL_GOOGLE_CLIENT_SECRET", "");
        this.settings = settings;
        this.http = http.build();
        this.decoder = NimbusReactiveJwtDecoder.withJwkSetUri(KEYS_ENDPOINT).build();
        this.decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(ISSUER));
    }

    public boolean configured() { return settings.configured() && !clientId.isBlank() && !clientSecret.isBlank(); }
    public String clientId() { if (!configured()) throw new TravelError("auth_provider_not_configured"); return clientId; }
    public String callback() { if (!configured()) throw new TravelError("auth_provider_not_configured"); return settings.issuer() + "/oauth/google/callback"; }

    public Mono<Identity> exchange(String code, String verifier, String nonceHash) {
        if (!configured()) return Mono.error(new TravelError("auth_provider_not_configured"));
        if (code == null || code.isBlank() || code.length() > 4096) return Mono.error(new TravelError("invalid_google_response"));
        return http.post().uri(TOKEN_ENDPOINT).body(BodyInserters.fromFormData("code", code)
                .with("client_id", clientId).with("client_secret", clientSecret).with("redirect_uri", callback())
                .with("grant_type", "authorization_code").with("code_verifier", verifier))
                .retrieve().bodyToMono(Map.class).timeout(Duration.ofSeconds(15))
                .flatMap(response -> response.get("id_token") instanceof String token ? decoder.decode(token) : Mono.error(new TravelError("invalid_google_response")))
                .map(jwt -> verifiedIdentity(jwt, nonceHash))
                .onErrorMap(error -> error instanceof TravelError ? error : new TravelError("google_identity_unavailable"));
    }

    Identity verifiedIdentity(Jwt jwt, String nonceHash) {
        String nonce = jwt.getClaimAsString("nonce");
        String authorizedParty = jwt.getClaimAsString("azp");
        if (jwt.getExpiresAt() == null || jwt.getIssuedAt() == null || jwt.getSubject() == null || jwt.getSubject().isBlank()
                || !jwt.getAudience().contains(clientId) || (authorizedParty != null && !authorizedParty.equals(clientId))
                || (jwt.getAudience().size() > 1 && authorizedParty == null) || nonce == null || nonce.length() > 256
                || !MessageDigest.isEqual(OAuthGrants.hash(nonce).getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                        nonceHash.getBytes(java.nio.charset.StandardCharsets.US_ASCII))) throw new TravelError("invalid_google_identity");
        String name = jwt.getClaimAsString("name");
        if (name != null && name.length() > 255) name = null;
        String email = Boolean.TRUE.equals(jwt.getClaim("email_verified")) ? jwt.getClaimAsString("email") : null;
        String hostedDomain = jwt.getClaimAsString("hd");
        boolean authoritative = email != null && (email.toLowerCase(java.util.Locale.ROOT).endsWith("@gmail.com")
                || (hostedDomain != null && !hostedDomain.isBlank()));
        return new Identity(jwt.getSubject(), name, email, authoritative);
    }

    public record Identity(String subject, String displayName, String verifiedEmail, boolean emailAuthoritative) {
        public Identity(String subject, String displayName) { this(subject, displayName, null, false); }
        @Override public String toString() { return "Identity[redacted]"; }
    }
}
