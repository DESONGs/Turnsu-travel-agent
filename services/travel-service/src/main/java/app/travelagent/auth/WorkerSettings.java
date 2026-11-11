package app.travelagent.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** Worker traffic must also be restricted to the private deployment network. */
@Component
public class WorkerSettings {
    private final boolean enabled;
    private final String secret;
    public WorkerSettings(Environment environment) {
        enabled = environment.getProperty("TRAVEL_BACKGROUND_WORKER_ENABLED", Boolean.class, false);
        secret = environment.getProperty("TRAVEL_WORKER_TOKEN", "");
    }
    public boolean configured() { return enabled && secret.matches("[A-Za-z0-9_-]{43,128}"); }
    public boolean authenticates(String authorization) {
        if (!configured() || authorization == null || !authorization.startsWith("Bearer ")) return false;
        return MessageDigest.isEqual(secret.getBytes(StandardCharsets.US_ASCII), authorization.substring(7).getBytes(StandardCharsets.US_ASCII));
    }
}
