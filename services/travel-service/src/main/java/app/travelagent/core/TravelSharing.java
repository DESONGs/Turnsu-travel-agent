package app.travelagent.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/** Directory lookup is owner-only; raw input email stays in the app, not MCP arguments. */
@Service
public class TravelSharing {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final TravelTrips trips;

    public TravelSharing(JdbcTemplate jdbc, TransactionTemplate transactions, TravelTrips trips) {
        this.jdbc = jdbc; this.transactions = transactions; this.trips = trips;
    }

    public Map<String, Object> resolve(UUID actor, UUID trip, String emailHash) {
        validateHash(emailHash);
        var result = transactions.execute(status -> {
            long revision = requireOwner(actor, trip, false);
            Integer attempts = jdbc.queryForObject("""
                    INSERT INTO travel_share_lookup_windows(account_id,window_start,attempts) VALUES (?,date_trunc('minute',CURRENT_TIMESTAMP),1)
                    ON CONFLICT (account_id,window_start) DO UPDATE SET attempts=LEAST(travel_share_lookup_windows.attempts+1,21)
                    RETURNING attempts
                    """, Integer.class, actor);
            if (attempts == null || attempts > 20) return Map.<String, Object>of("_error", "share_lookup_rate_limited");
            var matches = jdbc.query("SELECT account_id,display_name,email_authoritative FROM travel_accounts WHERE verified_email_hash=? LIMIT 2",
                    (rs, n) -> new Match(rs.getObject(1, UUID.class), rs.getString(2), rs.getBoolean(3)), emailHash);
            if (matches.size() != 1) return Map.<String, Object>of("_error", "share_account_unavailable");
            var match = matches.get(0);
            if (actor.equals(match.id())) return Map.<String, Object>of("_error", "share_own_account");
            var found = new LinkedHashMap<String, Object>(); found.put("accountId", match.id().toString());
            if (match.name() != null) found.put("name", match.name());
            found.put("emailAuthoritative", match.authoritative()); found.put("accessRevision", revision); return found;
        });
        if (result == null) throw new TravelError("travel_operation_unavailable");
        if (result.get("_error") instanceof String code) throw new TravelError(code);
        return result;
    }

    public Map<String, Object> grantByEmailHash(UUID actor, UUID trip, UUID target, String emailHash, String role,
                                                long expectedAccessRevision, String requestId) {
        validateHash(emailHash);
        if (target == null) throw new TravelError("invalid_share");
        return transactions.execute(status -> {
            requireOwner(actor, trip, false);
            TravelAccounts.lockEmailDigest(jdbc, emailHash);
            var matches = jdbc.query("SELECT account_id,email_authoritative FROM travel_accounts WHERE verified_email_hash=? FOR SHARE",
                    (rs, n) -> new Match(rs.getObject(1, UUID.class), null, rs.getBoolean(2)), emailHash);
            if (matches.size() != 1 || !target.equals(matches.get(0).id())) throw new TravelError("share_account_changed");
            return trips.grant(actor, trip, target, role, expectedAccessRevision, requestId);
        });
    }

    public Map<String, Object> list(UUID actor, UUID trip, int limit, UUID after, Long expectedAccessRevision) {
        if (limit < 1 || limit > 100 || (after == null) != (expectedAccessRevision == null)) throw new TravelError("invalid_page");
        return transactions.execute(status -> {
            long revision = requireOwner(actor, trip, true);
            if (expectedAccessRevision != null && revision != expectedAccessRevision) throw new TravelError("access_revision_conflict");
            String sql = """
                    SELECT a.account_id,a.role,u.display_name,u.verified_email
                    FROM travel_trip_access a JOIN travel_accounts u ON u.account_id=a.account_id
                    WHERE a.trip_id=? AND a.role<>'owner'
                    """ + (after == null ? "" : " AND a.account_id>? ") + " ORDER BY a.account_id LIMIT ?";
            var mapper = (org.springframework.jdbc.core.RowMapper<Map<String, Object>>) (rs, n) -> {
                var item = new LinkedHashMap<String, Object>();
                item.put("accountId", rs.getObject(1, UUID.class).toString()); item.put("role", rs.getString(2));
                item.put("name", rs.getString(3)); item.put("email", rs.getString(4)); return item;
            };
            var rows = after == null ? jdbc.query(sql, mapper, trip, limit + 1) : jdbc.query(sql, mapper, trip, after, limit + 1);
            var items = new ArrayList<>(rows.size() > limit ? rows.subList(0, limit) : rows);
            Object cursor = rows.size() > limit ? Map.of("accountId", items.get(items.size() - 1).get("accountId"), "accessRevision", revision) : null;
            var result = new LinkedHashMap<String, Object>(); result.put("items", items); result.put("nextCursor", cursor); result.put("accessRevision", revision);
            return result;
        });
    }

    private long requireOwner(UUID actor, UUID trip, boolean lock) {
        if (actor == null || trip == null) throw new TravelError("trip_not_found");
        var rows = jdbc.query("""
                SELECT t.access_revision FROM travel_trips t JOIN travel_trip_access a ON a.trip_id=t.trip_id
                WHERE t.trip_id=? AND t.owner_id=? AND a.account_id=? AND a.role='owner'
                """ + (lock ? " FOR UPDATE OF t" : ""), (rs, n) -> rs.getLong(1), trip, actor, actor);
        if (rows.isEmpty()) throw new TravelError("trip_not_found");
        return rows.get(0);
    }

    private static void validateHash(String hash) {
        if (hash == null || !hash.matches("[0-9a-f]{64}")) throw new TravelError("invalid_share_email");
    }
    private record Match(UUID id, String name, boolean authoritative) {}
}
