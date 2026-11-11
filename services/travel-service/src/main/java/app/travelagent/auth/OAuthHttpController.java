package app.travelagent.auth;

import app.travelagent.core.TravelError;
import java.util.List;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** OAuth discovery and public-client endpoints. No endpoint accepts a client-selected resource or callback. */
@RestController
public class OAuthHttpController {
    private final OAuthSettings settings;
    private final OAuthGrants grants;

    public OAuthHttpController(OAuthSettings settings, OAuthGrants grants) { this.settings = settings; this.grants = grants; }

    @GetMapping("/.well-known/oauth-protected-resource/mcp")
    public ResponseEntity<?> protectedResource() {
        if (!settings.configured()) return unavailable();
        return noStore(Map.of("resource", settings.resource(), "authorization_servers", List.of(settings.issuer()),
                "scopes_supported", List.of("travel:read", "travel:write"), "bearer_methods_supported", List.of("header")));
    }

    @GetMapping("/.well-known/oauth-authorization-server")
    public ResponseEntity<?> authorizationServer() {
        if (!settings.configured()) return unavailable();
        String issuer = settings.issuer();
        return noStore(Map.ofEntries(Map.entry("issuer", issuer), Map.entry("authorization_endpoint", issuer + "/oauth/authorize"),
                Map.entry("token_endpoint", issuer + "/oauth/token"), Map.entry("registration_endpoint", issuer + "/oauth/register"),
                Map.entry("revocation_endpoint", issuer + "/oauth/revoke"), Map.entry("response_types_supported", List.of("code")),
                Map.entry("grant_types_supported", List.of("authorization_code", "refresh_token")),
                Map.entry("token_endpoint_auth_methods_supported", List.of("none")), Map.entry("code_challenge_methods_supported", List.of("S256")),
                Map.entry("scopes_supported", List.of("travel:read", "travel:write")),
                Map.entry("authorization_response_iss_parameter_supported", true)));
    }

    @PostMapping(path = "/oauth/register", consumes = "application/json")
    public Mono<ResponseEntity<?>> register(@RequestBody Map<String, Object> request) {
        return database(() -> {
            Object method = request.getOrDefault("token_endpoint_auth_method", "none");
            Object responseTypes = request.getOrDefault("response_types", List.of("code"));
            Object grantTypes = request.getOrDefault("grant_types", List.of("authorization_code", "refresh_token"));
            if (!"none".equals(method) || !List.of("code").equals(responseTypes)
                    || !(grantTypes instanceof List<?> types) || !types.contains("authorization_code")
                    || !List.of("authorization_code", "refresh_token").containsAll(types)
                    || !(request.get("redirect_uris") instanceof List<?> raw) || raw.stream().anyMatch(item -> !(item instanceof String))) {
                throw new TravelError("invalid_client_metadata");
            }
            var redirects = raw.stream().map(String.class::cast).toList();
            Object name = request.getOrDefault("client_name", "MCP client");
            if (!(name instanceof String clientName)) throw new TravelError("invalid_client_metadata");
            return ResponseEntity.status(HttpStatus.CREATED).cacheControl(CacheControl.noStore()).body(grants.registerClient(clientName, redirects));
        });
    }

    @PostMapping(path = "/oauth/token", consumes = "application/x-www-form-urlencoded")
    public Mono<ResponseEntity<?>> token(ServerWebExchange exchange) {
        return exchange.getFormData().flatMap(form -> database(() -> {
            var type = single(form, "grant_type");
            var client = single(form, "client_id");
            var resource = single(form, "resource");
            OAuthGrants.TokenPair tokens;
            if ("authorization_code".equals(type)) tokens = grants.exchangeCode(client, single(form, "code"),
                    single(form, "code_verifier"), single(form, "redirect_uri"), resource);
            else if ("refresh_token".equals(type)) tokens = grants.refresh(client, single(form, "refresh_token"), resource);
            else throw new TravelError("unsupported_grant_type");
            return noStore(Map.of("access_token", tokens.accessToken(), "token_type", tokens.tokenType(),
                    "expires_in", tokens.expiresIn(), "refresh_token", tokens.refreshToken(), "scope", tokens.scope()));
        }));
    }

    @PostMapping(path = "/oauth/revoke", consumes = "application/x-www-form-urlencoded")
    public Mono<ResponseEntity<?>> revoke(ServerWebExchange exchange) {
        return exchange.getFormData().flatMap(form -> database(() -> {
            grants.revoke(single(form, "client_id"), single(form, "token"));
            return noStore(Map.of());
        }));
    }

    static String single(MultiValueMap<String, String> values, String key) {
        List<String> matches = values.get(key);
        if (matches == null || matches.size() != 1 || matches.get(0) == null || matches.get(0).isBlank() || matches.get(0).length() > 2048)
            throw new TravelError("invalid_request");
        return matches.get(0);
    }

    static Mono<ResponseEntity<?>> database(java.util.concurrent.Callable<ResponseEntity<?>> operation) {
        return Mono.fromCallable(operation).subscribeOn(Schedulers.boundedElastic())
                .onErrorResume(TravelError.class, error -> Mono.just(ResponseEntity.status("auth_provider_not_configured".equals(error.code())
                        ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_REQUEST).cacheControl(CacheControl.noStore()).body(Map.of("error", error.code()))))
                .onErrorResume(error -> Mono.just(unavailable()));
    }

    static ResponseEntity<?> noStore(Object body) { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).header("Pragma", "no-cache").body(body); }
    static ResponseEntity<?> unavailable() { return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).cacheControl(CacheControl.noStore()).body(Map.of("error", "auth_provider_not_configured")); }
}
