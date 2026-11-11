package app.travelagent.core;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Expired OAuth material is removed; source references retain attribution but not expired payloads. */
@Component
public class ExpiredDataCleanup {
    private final JdbcTemplate jdbc;
    public ExpiredDataCleanup(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Scheduled(initialDelay = 60000, fixedDelay = 300000)
    public void removeExpiredPayloads() {
        jdbc.update("UPDATE travel_result_references SET data=NULL WHERE fresh_until<=CURRENT_TIMESTAMP AND data IS NOT NULL");
        jdbc.update("DELETE FROM travel_oauth_pending WHERE expires_at<=CURRENT_TIMESTAMP");
        jdbc.update("DELETE FROM travel_oauth_codes WHERE expires_at<=CURRENT_TIMESTAMP");
        jdbc.update("DELETE FROM travel_oauth_access WHERE expires_at<=CURRENT_TIMESTAMP");
        jdbc.update("DELETE FROM travel_oauth_refresh WHERE expires_at<=CURRENT_TIMESTAMP");
        jdbc.update("DELETE FROM travel_share_lookup_windows WHERE window_start<CURRENT_TIMESTAMP-INTERVAL '1 day'");
    }
}
