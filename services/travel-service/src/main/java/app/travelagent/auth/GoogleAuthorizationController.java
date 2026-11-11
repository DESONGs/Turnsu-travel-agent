package app.travelagent.auth;

import app.travelagent.core.TravelAccounts;
import app.travelagent.core.TravelError;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.util.UriComponentsBuilder;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/** Browser-bound Google OIDC login followed by explicit authorization of the MCP client. */
@RestController
public class GoogleAuthorizationController {
    private static final String COOKIE = "__Host-travel-oauth";
    private final OAuthSettings settings;
    private final OAuthGrants grants;
    private final GoogleIdentityClient google;
    private final TravelAccounts accounts;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final SecureRandom random = new SecureRandom();

    public GoogleAuthorizationController(OAuthSettings settings, OAuthGrants grants, GoogleIdentityClient google,
                                         TravelAccounts accounts, JdbcTemplate jdbc, TransactionTemplate transactions) {
        this.settings = settings; this.grants = grants; this.google = google; this.accounts = accounts;
        this.jdbc = jdbc; this.transactions = transactions;
    }

    @GetMapping("/oauth/authorize")
    public Mono<ResponseEntity<?>> authorize(ServerWebExchange exchange) {
        return OAuthHttpController.database(() -> {
            if (!google.configured()) throw new TravelError("auth_provider_not_configured");
            var query = exchange.getRequest().getQueryParams();
            if (!"code".equals(OAuthHttpController.single(query, "response_type"))) throw new TravelError("unsupported_response_type");
            String pending = grants.beginAuthorization(OAuthHttpController.single(query, "client_id"), OAuthHttpController.single(query, "redirect_uri"),
                    OAuthHttpController.single(query, "state"), OAuthHttpController.single(query, "code_challenge"),
                    OAuthHttpController.single(query, "code_challenge_method"), OAuthHttpController.single(query, "scope"),
                    OAuthHttpController.single(query, "resource"));
            String browser = browserCookie(exchange);
            if (browser == null) browser = randomValue();
            String state = randomValue(), nonce = randomValue(), verifier = randomValue();
            jdbc.update("""
                    INSERT INTO travel_google_logins(state_hash,browser_hash,pending_hash,nonce_hash,code_verifier,status,expires_at)
                    VALUES (?,?,?,?,?,'pending',CURRENT_TIMESTAMP + INTERVAL '10 minutes')
                    """, OAuthGrants.hash(state), OAuthGrants.hash(browser), OAuthGrants.hash(pending), OAuthGrants.hash(nonce), verifier);
            URI target = UriComponentsBuilder.fromUriString(GoogleIdentityClient.AUTHORIZATION_ENDPOINT)
                    .queryParam("client_id", google.clientId()).queryParam("redirect_uri", google.callback())
                    .queryParam("response_type", "code").queryParam("scope", "openid profile email").queryParam("state", state)
                    .queryParam("nonce", nonce).queryParam("code_challenge", digest(verifier)).queryParam("code_challenge_method", "S256")
                    .build().encode().toUri();
            String cookie = ResponseCookie.from(COOKIE, browser).secure(true).httpOnly(true).sameSite("Lax").path("/").maxAge(600).build().toString();
            return redirect(target).header(HttpHeaders.SET_COOKIE, cookie).build();
        });
    }

    @GetMapping("/oauth/google/callback")
    public Mono<ResponseEntity<?>> callback(ServerWebExchange exchange) {
        return Mono.<ResponseEntity<?>>defer(() -> {
            var query = exchange.getRequest().getQueryParams();
            String state = validState(OAuthHttpController.single(query, "state"));
            String browser = requiredBrowser(exchange);
            if (!GoogleIdentityClient.ISSUER.equals(OAuthHttpController.single(query, "iss"))) throw new TravelError("invalid_google_response");
            String code = OAuthHttpController.single(query, "code");
            return Mono.fromCallable(() -> claim(state, browser)).subscribeOn(Schedulers.boundedElastic())
                    .flatMap(login -> google.exchange(code, login.verifier(), login.nonceHash()))
                    .flatMap(identity -> Mono.<ResponseEntity<?>>fromCallable(() -> {
                        UUID account = accounts.fromVerifiedGoogleSubject(identity.subject(), identity.displayName(), identity.verifiedEmail(), identity.emailAuthoritative());
                        int updated = jdbc.update("""
                                UPDATE travel_google_logins SET account_id=?,status='awaiting_consent',code_verifier=''
                                WHERE state_hash=? AND browser_hash=? AND status='exchanging' AND expires_at>CURRENT_TIMESTAMP
                                """, account, OAuthGrants.hash(state), OAuthGrants.hash(browser));
                        if (updated != 1) throw new TravelError("authorization_expired");
                        URI consent = UriComponentsBuilder.fromPath("/oauth/consent").queryParam("state", state).build().encode().toUri();
                        return (ResponseEntity<?>) redirect(consent).build();
                    }).subscribeOn(Schedulers.boundedElastic()));
        }).onErrorResume(error -> Mono.just(errorResponse(error)));
    }

    @GetMapping("/oauth/consent")
    public Mono<ResponseEntity<?>> consent(ServerWebExchange exchange) {
        return OAuthHttpController.database(() -> {
            String state = validState(OAuthHttpController.single(exchange.getRequest().getQueryParams(), "state"));
            Consent info = consentInfo(state, requiredBrowser(exchange));
            String scopeText = info.scope().contains("travel:write") ? "查看和修改您授权的旅行" : "查看您授权的旅行";
            String html = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                    + "<title>连接旅行工作台</title><main><h1>连接旅行工作台</h1><p>允许 " + escape(info.clientName()) + " " + scopeText + "？</p>"
                    + "<p>您可以稍后撤销连接。分享旅行仍需单独授权。</p><form method=\"post\" action=\"/oauth/consent\">"
                    + "<input type=\"hidden\" name=\"state\" value=\"" + state + "\"><button name=\"decision\" value=\"approve\">允许连接</button> "
                    + "<button name=\"decision\" value=\"deny\">取消</button></form></main></html>";
            return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).cacheControl(CacheControl.noStore())
                    .header("Referrer-Policy", "no-referrer").header("Content-Security-Policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
                    .body(html);
        });
    }

    @PostMapping(path = "/oauth/consent", consumes = "application/x-www-form-urlencoded")
    public Mono<ResponseEntity<?>> decide(ServerWebExchange exchange) {
        return exchange.getFormData().flatMap(form -> OAuthHttpController.database(() -> {
            String state = validState(OAuthHttpController.single(form, "state"));
            String browser = requiredBrowser(exchange);
            String decision = OAuthHttpController.single(form, "decision");
            if (!"approve".equals(decision) && !"deny".equals(decision)) throw new TravelError("invalid_request");
            return transactions.execute(status -> {
                Consent info = consentInfoForUpdate(state, browser);
                UriComponentsBuilder target = UriComponentsBuilder.fromUriString(info.redirect()).queryParam("state", info.clientState()).queryParam("iss", settings.issuer());
                if ("approve".equals(decision)) {
                    var code = grants.completeVerifiedGoogleHash(info.pendingHash(), info.account());
                    target.queryParam("code", code.code());
                } else {
                    jdbc.update("DELETE FROM travel_oauth_pending WHERE request_hash=?", info.pendingHash());
                    target.queryParam("error", "access_denied");
                }
                return redirect(target.build().encode().toUri()).build();
            });
        }));
    }

    private Login claim(String state, String browser) {
        var rows = jdbc.query("""
                UPDATE travel_google_logins SET status='exchanging'
                WHERE state_hash=? AND browser_hash=? AND status='pending' AND expires_at>CURRENT_TIMESTAMP
                RETURNING code_verifier,nonce_hash
                """, (rs, index) -> new Login(rs.getString(1), rs.getString(2)), OAuthGrants.hash(state), OAuthGrants.hash(browser));
        if (rows.isEmpty()) throw new TravelError("authorization_expired");
        return rows.get(0);
    }

    private Consent consentInfo(String state, String browser) { return findConsent(state, browser, false); }
    private Consent consentInfoForUpdate(String state, String browser) { return findConsent(state, browser, true); }
    private Consent findConsent(String state, String browser, boolean lock) {
        var rows = jdbc.query("""
                SELECT p.request_hash,p.redirect_uri,p.client_state,p.scope,c.client_name,g.account_id
                FROM travel_google_logins g JOIN travel_oauth_pending p ON p.request_hash=g.pending_hash
                JOIN travel_oauth_clients c ON c.client_id=p.client_id
                WHERE g.state_hash=? AND g.browser_hash=? AND g.status='awaiting_consent'
                  AND g.expires_at>CURRENT_TIMESTAMP AND p.expires_at>CURRENT_TIMESTAMP
                """ + (lock ? " FOR UPDATE OF g,p" : ""), (rs, index) -> new Consent(rs.getString(1), rs.getString(2),
                        rs.getString(3), rs.getString(4), rs.getString(5), rs.getObject(6, UUID.class)), OAuthGrants.hash(state), OAuthGrants.hash(browser));
        if (rows.isEmpty()) throw new TravelError("authorization_expired");
        return rows.get(0);
    }

    private String browserCookie(ServerWebExchange exchange) {
        var cookie = exchange.getRequest().getCookies().getFirst(COOKIE);
        return cookie != null && cookie.getValue().matches("[A-Za-z0-9_-]{43}") ? cookie.getValue() : null;
    }
    private String requiredBrowser(ServerWebExchange exchange) {
        String value = browserCookie(exchange);
        if (value == null) throw new TravelError("authorization_expired");
        return value;
    }
    private static String validState(String state) {
        if (!state.matches("[A-Za-z0-9_-]{43}")) throw new TravelError("invalid_request");
        return state;
    }
    private String randomValue() { byte[] bytes = new byte[32]; random.nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    private static String digest(String value) {
        try { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String escape(String value) { return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;"); }
    private static ResponseEntity.BodyBuilder redirect(URI target) {
        return ResponseEntity.status(HttpStatus.FOUND).location(target).cacheControl(CacheControl.noStore()).header("Referrer-Policy", "no-referrer");
    }
    private static ResponseEntity<?> errorResponse(Throwable error) {
        if (error instanceof TravelError known) return ResponseEntity.status("auth_provider_not_configured".equals(known.code())
                || "google_identity_unavailable".equals(known.code()) ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_REQUEST)
                .cacheControl(CacheControl.noStore()).body(Map.of("error", known.code()));
        return OAuthHttpController.unavailable();
    }
    private record Login(String verifier, String nonceHash) {}
    private record Consent(String pendingHash, String redirect, String clientState, String scope, String clientName, UUID account) {}
}
