package app.travelagent.auth;

import app.travelagent.core.TravelError;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** MCP OAuth tokens are opaque and stored only as hashes; issuance and rotation are transactional. */
@Service
public final class OAuthGrants {
    private static final Set<String> ALLOWED_SCOPES = Set.of("travel:read", "travel:write");
    private static final int ACCESS_SECONDS = 3600;
    private static final int REFRESH_SECONDS = 30 * 24 * 3600;
    private final SecureRandom random = new SecureRandom();
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final OAuthSettings settings;
    private final JsonMapper json = JsonMapper.builder().build();

    public OAuthGrants(JdbcTemplate jdbc, TransactionTemplate transactions, OAuthSettings settings) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.settings = settings;
    }

    public Map<String, Object> registerClient(String name, List<String> redirects) {
        if (!settings.configured()) throw new TravelError("auth_provider_not_configured");
        if (name == null || name.isBlank() || name.length() > 255 || redirects == null || redirects.isEmpty()
                || redirects.size() > 8 || redirects.stream().anyMatch(uri -> !settings.allowsRedirect(uri))) throw new TravelError("invalid_client_metadata");
        String clientId = "travel_" + randomValue();
        jdbc.update("INSERT INTO travel_oauth_clients(client_id, client_name, redirect_uris) VALUES (?, ?, CAST(? AS jsonb))",
                clientId, name, json.writeValueAsString(redirects));
        return Map.of("client_id", clientId, "client_name", name, "redirect_uris", redirects,
                "token_endpoint_auth_method", "none", "grant_types", List.of("authorization_code", "refresh_token"),
                "response_types", List.of("code"));
    }

    public String beginAuthorization(String clientId, String redirect, String state, String challenge, String challengeMethod,
                                     String requestedScope, String resource) {
        if (!settings.configured()) throw new TravelError("auth_provider_not_configured");
        if (clientId == null || clientId.length() > 128 || state == null || state.isBlank() || state.length() > 1024
                || challenge == null || !challenge.matches("[A-Za-z0-9_-]{43}") || !"S256".equals(challengeMethod)
                || !settings.resource().equals(resource) || !settings.allowsRedirect(redirect)) throw new TravelError("invalid_authorization_request");
        var clients = jdbc.query("SELECT redirect_uris::text FROM travel_oauth_clients WHERE client_id=?", (rs, n) -> rs.getString(1), clientId);
        if (clients.isEmpty() || !json.<List<String>>readValue(clients.get(0), new TypeReference<List<String>>() {}).contains(redirect)) throw new TravelError("invalid_client");
        var scopes = parseScope(requestedScope);
        String pending = randomValue();
        jdbc.update("""
                INSERT INTO travel_oauth_pending(request_hash,client_id,redirect_uri,client_state,code_challenge,scope,resource,expires_at)
                VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP + INTERVAL '10 minutes')
                """, hash(pending), clientId, redirect, state, challenge, String.join(" ", scopes), resource);
        return pending;
    }

    /** Invoked only after the Google callback has verified issuer, audience, nonce and signature. */
    public AuthorizationCode completeVerifiedGoogle(String pending, UUID accountId) {
        if (pending == null || !pending.matches("[A-Za-z0-9_-]{43}")) throw new TravelError("invalid_authorization_request");
        return completeVerifiedGoogleHash(hash(pending), accountId);
    }

    AuthorizationCode completeVerifiedGoogleHash(String pendingHash, UUID accountId) {
        if (pendingHash == null || !pendingHash.matches("[a-f0-9]{64}") || accountId == null) throw new TravelError("invalid_authorization_request");
        return transactions.execute(status -> {
            var rows = jdbc.query("""
                    SELECT client_id,redirect_uri,client_state,code_challenge,scope,resource
                    FROM travel_oauth_pending WHERE request_hash=? AND expires_at>CURRENT_TIMESTAMP FOR UPDATE
                    """, (rs, n) -> new Pending(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6)), pendingHash);
            if (rows.isEmpty()) throw new TravelError("authorization_expired");
            var value = rows.get(0);
            jdbc.update("DELETE FROM travel_oauth_pending WHERE request_hash=?", pendingHash);
            String code = randomValue();
            jdbc.update("""
                    INSERT INTO travel_oauth_codes(code_hash,client_id,account_id,redirect_uri,code_challenge,scope,resource,expires_at)
                    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP + INTERVAL '2 minutes')
                    """, hash(code), value.client(), accountId, value.redirect(), value.challenge(), value.scope(), value.resource());
            return new AuthorizationCode(value.redirect(), value.state(), code, settings.issuer());
        });
    }

    public TokenPair exchangeCode(String clientId, String code, String verifier, String redirect, String resource) {
        if (clientId == null || clientId.length() > 128 || code == null || !code.matches("[A-Za-z0-9_-]{43}") || verifier == null || !verifier.matches("[A-Za-z0-9._~-]{43,128}")
                || !settings.resource().equals(resource)) throw new TravelError("invalid_grant");
        return transactions.execute(status -> {
            var rows = jdbc.query("""
                    SELECT client_id,account_id,redirect_uri,code_challenge,scope,resource
                    FROM travel_oauth_codes WHERE code_hash=? AND expires_at>CURRENT_TIMESTAMP FOR UPDATE
                    """, (rs, n) -> new Code(rs.getString(1), rs.getObject(2, UUID.class), rs.getString(3),
                    rs.getString(4), rs.getString(5), rs.getString(6)), hash(code));
            if (rows.isEmpty()) throw new TravelError("invalid_grant");
            var value = rows.get(0);
            if (!clientId.equals(value.client()) || !value.redirect().equals(redirect) || !value.resource().equals(resource)
                    || !constantEquals(value.challenge(), base64Digest(verifier))) throw new TravelError("invalid_grant");
            jdbc.update("DELETE FROM travel_oauth_codes WHERE code_hash=?", hash(code));
            UUID grant = UUID.randomUUID();
            jdbc.update("INSERT INTO travel_oauth_grants(grant_id,client_id,account_id,scope,resource) VALUES (?,?,?,?,?)",
                    grant, clientId, value.account(), value.scope(), resource);
            return issue(grant, value.scope());
        });
    }

    public TokenPair refresh(String clientId, String refreshToken, String resource) {
        if (clientId == null || clientId.length() > 128 || refreshToken == null || !refreshToken.matches("[A-Za-z0-9_-]{43}") || !settings.resource().equals(resource)) throw new TravelError("invalid_grant");
        var outcome = transactions.execute(status -> {
            var rows = jdbc.query("""
                    SELECT r.grant_id,r.consumed_at,g.client_id,g.scope,g.resource,g.revoked_at
                    FROM travel_oauth_refresh r JOIN travel_oauth_grants g ON g.grant_id=r.grant_id
                    WHERE r.token_hash=? AND r.expires_at>CURRENT_TIMESTAMP FOR UPDATE OF r,g
                    """, (rs, n) -> new Refresh(rs.getObject(1, UUID.class), rs.getTimestamp(2) != null, rs.getString(3),
                    rs.getString(4), rs.getString(5), rs.getTimestamp(6) != null), hash(refreshToken));
            if (rows.isEmpty()) return new RefreshOutcome(null, false);
            var value = rows.get(0);
            if (!clientId.equals(value.client()) || !resource.equals(value.resource()) || value.revoked()) return new RefreshOutcome(null, false);
            if (value.consumed()) {
                jdbc.update("UPDATE travel_oauth_grants SET revoked_at=CURRENT_TIMESTAMP WHERE grant_id=?", value.grant());
                return new RefreshOutcome(null, true);
            }
            jdbc.update("UPDATE travel_oauth_refresh SET consumed_at=CURRENT_TIMESTAMP WHERE token_hash=?", hash(refreshToken));
            jdbc.update("DELETE FROM travel_oauth_access WHERE grant_id=?", value.grant());
            return new RefreshOutcome(issue(value.grant(), value.scope()), false);
        });
        if (outcome == null || outcome.tokens() == null) throw new TravelError("invalid_grant");
        return outcome.tokens();
    }

    public Principal authenticate(String token, String requiredScope) {
        if (token == null || token.length() > 256 || !ALLOWED_SCOPES.contains(requiredScope) || !settings.configured()) throw new TravelError("authentication_required");
        var rows = jdbc.query("""
                SELECT g.account_id,g.grant_id,g.scope,g.resource
                FROM travel_oauth_access a JOIN travel_oauth_grants g ON g.grant_id=a.grant_id
                WHERE a.token_hash=? AND a.expires_at>CURRENT_TIMESTAMP AND g.revoked_at IS NULL
                """, (rs, n) -> new Principal(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), parseScope(rs.getString(3)), rs.getString(4)), hash(token));
        if (rows.isEmpty() || !settings.resource().equals(rows.get(0).resource()) || !rows.get(0).scopes().contains(requiredScope)) throw new TravelError("authentication_required");
        return rows.get(0);
    }

    public void revoke(String clientId, String token) {
        if (clientId == null || clientId.length() > 128 || token == null || !token.matches("[A-Za-z0-9_-]{43}")) return;
        String tokenHash = hash(token);
        jdbc.update("""
                UPDATE travel_oauth_grants SET revoked_at=CURRENT_TIMESTAMP
                WHERE client_id=? AND grant_id IN (
                  SELECT grant_id FROM travel_oauth_access WHERE token_hash=?
                  UNION SELECT grant_id FROM travel_oauth_refresh WHERE token_hash=?
                )
                """, clientId, tokenHash, tokenHash);
    }

    private TokenPair issue(UUID grant, String scope) {
        String access = randomValue(), refresh = randomValue();
        jdbc.update("INSERT INTO travel_oauth_access(token_hash,grant_id,expires_at) VALUES (?,?,CURRENT_TIMESTAMP + (? * INTERVAL '1 second'))", hash(access), grant, ACCESS_SECONDS);
        jdbc.update("INSERT INTO travel_oauth_refresh(token_hash,grant_id,expires_at) VALUES (?,?,CURRENT_TIMESTAMP + (? * INTERVAL '1 second'))", hash(refresh), grant, REFRESH_SECONDS);
        return new TokenPair(access, refresh, "Bearer", ACCESS_SECONDS, scope);
    }

    private String randomValue() { byte[] bytes = new byte[32]; random.nextBytes(bytes); return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    private static Set<String> parseScope(String value) {
        if (value == null || value.isBlank() || value.length() > 128) throw new TravelError("invalid_scope");
        var scopes = List.of(value.trim().split("\\s+")).stream().collect(Collectors.toUnmodifiableSet());
        if (!ALLOWED_SCOPES.containsAll(scopes) || !scopes.contains("travel:read")) throw new TravelError("invalid_scope");
        return scopes;
    }
    static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static String base64Digest(String value) {
        try { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static boolean constantEquals(String left, String right) { return MessageDigest.isEqual(left.getBytes(StandardCharsets.US_ASCII), right.getBytes(StandardCharsets.US_ASCII)); }

    public record AuthorizationCode(String redirectUri, String state, String code, String issuer) {
        @Override public String toString() { return "AuthorizationCode[redacted]"; }
    }
    public record TokenPair(String accessToken, String refreshToken, String tokenType, int expiresIn, String scope) {
        @Override public String toString() { return "TokenPair[redacted]"; }
    }
    public record Principal(UUID accountId, UUID grantId, Set<String> scopes, String resource) {}
    private record Pending(String client, String redirect, String state, String challenge, String scope, String resource) {}
    private record Code(String client, UUID account, String redirect, String challenge, String scope, String resource) {}
    private record Refresh(UUID grant, boolean consumed, String client, String scope, String resource, boolean revoked) {}
    private record RefreshOutcome(TokenPair tokens, boolean replay) {}
}
