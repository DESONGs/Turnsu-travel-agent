package app.travelagent.auth;

import app.travelagent.core.TravelError;
import java.net.URI;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** Public origin and callback allowlist are explicit; forwarded headers never select them. */
@Component
public final class OAuthSettings {
    private final URI origin;
    private final Set<String> redirectUris;
    private final Set<String> allowedOrigins;
    private final Set<String> allowedHosts;
    private final boolean allowLoopback;

    @Autowired
    public OAuthSettings(Environment environment) {
        this(environment.getProperty("TRAVEL_PUBLIC_ORIGIN", ""),
                environment.getProperty("TRAVEL_MCP_REDIRECT_URIS", "https://chatgpt.com/connector_platform_oauth_redirect"), false,
                environment.getProperty("TRAVEL_MCP_ALLOWED_ORIGINS", "https://chatgpt.com"),
                environment.getProperty("TRAVEL_MCP_ALLOWED_HOSTS", ""));
    }

    public OAuthSettings(String origin, String redirects, boolean allowLoopback) {
        this(origin, redirects, allowLoopback, "https://chatgpt.com", "");
    }

    private OAuthSettings(String origin, String redirects, boolean allowLoopback, String origins, String hosts) {
        URI parsed = null;
        if (origin != null && !origin.isBlank()) {
            try {
                parsed = URI.create(origin);
                boolean secure = "https".equals(parsed.getScheme());
                boolean local = allowLoopback && "http".equals(parsed.getScheme()) && parsed.getHost() != null && Set.of("127.0.0.1", "localhost").contains(parsed.getHost());
                if ((!secure && !local) || parsed.getHost() == null || parsed.getUserInfo() != null || parsed.getQuery() != null
                        || parsed.getFragment() != null || !(parsed.getPath().isEmpty() || "/".equals(parsed.getPath()))) parsed = null;
            } catch (IllegalArgumentException ignored) { parsed = null; }
        }
        this.origin = parsed;
        this.allowLoopback = allowLoopback;
        this.redirectUris = Arrays.stream(redirects == null ? new String[0] : redirects.split(","))
                .map(String::trim).filter(value -> !value.isEmpty()).collect(Collectors.toUnmodifiableSet());
        this.allowedOrigins = Arrays.stream(origins == null ? new String[0] : origins.split(","))
                .map(String::trim).filter(value -> !value.isEmpty()).collect(Collectors.toUnmodifiableSet());
        var trustedHosts = Arrays.stream(hosts == null ? new String[0] : hosts.split(","))
                .map(String::trim).filter(value -> !value.isEmpty()).map(value -> value.toLowerCase(java.util.Locale.ROOT)).collect(Collectors.toSet());
        if (parsed != null) trustedHosts.add(parsed.getRawAuthority().toLowerCase(java.util.Locale.ROOT));
        this.allowedHosts = Set.copyOf(trustedHosts);
    }

    public boolean configured() { return origin != null && !redirectUris.isEmpty(); }
    public String issuer() {
        if (!configured()) throw new TravelError("auth_provider_not_configured");
        return origin.toString().replaceAll("/$", "");
    }
    public String resource() { return issuer() + "/mcp"; }
    public boolean allowsBrowserOrigin(String origin) { return origin == null || allowedOrigins.contains(origin); }
    public boolean allowsHost(String authority) {
        if (authority == null || authority.length() > 255) return false;
        try {
            URI request = URI.create("http://" + authority);
            if (request.getHost() == null || request.getUserInfo() != null || !request.getPath().isEmpty()
                    || request.getQuery() != null || request.getFragment() != null) return false;
            String exact = authority.toLowerCase(java.util.Locale.ROOT);
            String hostname = request.getHost().toLowerCase(java.util.Locale.ROOT);
            return allowedHosts.contains(exact) || allowedHosts.contains(hostname);
        } catch (IllegalArgumentException invalid) { return false; }
    }
    public boolean allowsRedirect(String redirect) {
        if (!configured() || redirect == null || !redirectUris.contains(redirect)) return false;
        try {
            URI uri = URI.create(redirect);
            boolean secure = "https".equals(uri.getScheme());
            // Native OAuth accepts HTTP only on an exactly registered loopback callback.
            // The public issuer above still requires HTTPS.
            boolean local = "http".equals(uri.getScheme()) && uri.getHost() != null
                    && Set.of("127.0.0.1", "localhost", "[::1]").contains(uri.getHost())
                    && uri.getPort() >= 1024 && uri.getPort() <= 65535;
            return (secure || local) && uri.isAbsolute() && uri.getHost() != null && uri.getUserInfo() == null && uri.getFragment() == null;
        } catch (IllegalArgumentException error) { return false; }
    }
}
