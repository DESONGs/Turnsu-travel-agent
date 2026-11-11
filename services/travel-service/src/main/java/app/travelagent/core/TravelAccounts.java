package app.travelagent.core;

import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;

/** Google subject must already have been verified by the authentication layer. */
@Repository
public class TravelAccounts {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;

    @Autowired
    public TravelAccounts(JdbcTemplate jdbc, TransactionTemplate transactions) { this.jdbc = jdbc; this.transactions = transactions; }

    public TravelAccounts(JdbcTemplate jdbc) {
        this(jdbc, new TransactionTemplate(new org.springframework.jdbc.datasource.DataSourceTransactionManager(jdbc.getDataSource())));
    }

    public UUID fromVerifiedGoogleSubject(String subject, String displayName) {
        return fromVerifiedGoogleSubject(subject, displayName, null, false);
    }

    public UUID fromVerifiedGoogleSubject(String subject, String displayName, String verifiedEmail, boolean authoritative) {
        if (subject == null || subject.isBlank() || subject.length() > 255 || (displayName != null && displayName.length() > 255)) {
            throw new TravelError("invalid_verified_identity");
        }
        String name = displayName != null && displayName.contains("@") ? null : displayName;
        String email;
        try { email = verifiedEmail == null ? null : normalizeEmail(verifiedEmail); }
        catch (TravelError invalid) { email = null; }
        String hash = email == null ? null : emailDigest(email);
        final String savedEmail = email, savedHash = hash;
        return transactions.execute(status -> {
            if (savedHash != null) lockEmailDigest(jdbc, savedHash);
            return jdbc.queryForObject("""
                INSERT INTO travel_accounts(account_id, google_subject, display_name, verified_email, verified_email_hash, email_authoritative, email_verified_at)
                VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)
                ON CONFLICT (google_subject) DO UPDATE
                SET display_name = COALESCE(EXCLUDED.display_name, travel_accounts.display_name),
                    verified_email=EXCLUDED.verified_email, verified_email_hash=EXCLUDED.verified_email_hash,
                    email_authoritative=EXCLUDED.email_authoritative, email_verified_at=EXCLUDED.email_verified_at
                RETURNING account_id
                """, UUID.class, UUID.randomUUID(), subject, name, savedEmail, savedHash, savedEmail != null && authoritative, savedEmail != null);
        });
    }

    public static String normalizeEmail(String input) {
        if (input == null) throw new TravelError("invalid_share_email");
        String value = input.strip();
        int at = value.indexOf('@');
        if (value.length() > 254 || at <= 0 || at != value.lastIndexOf('@') || at >= value.length() - 1
                || value.substring(at + 1).indexOf('.') <= 0 || value.endsWith(".")
                || value.codePoints().anyMatch(point -> Character.isWhitespace(point) || Character.isSpaceChar(point) || Character.isISOControl(point)))
            throw new TravelError("invalid_share_email");
        // A third-party mailbox can treat its local part as case- and Unicode-sensitive.
        // Guessing here can grant access to a different Google account.
        String domain = java.text.Normalizer.normalize(value.substring(at + 1), java.text.Normalizer.Form.NFC).toLowerCase(java.util.Locale.ROOT);
        String local = value.substring(0, at);
        if ("gmail.com".equals(domain)) local = local.toLowerCase(java.util.Locale.ROOT);
        return local + "@" + domain;
    }

    public static String emailDigest(String normalized) {
        try {
            byte[] bytes = ("travel-share-email-v1:" + normalized).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    static void lockEmailDigest(JdbcTemplate jdbc, String hash) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?,0))", rs -> {}, "travel-share-email:" + hash);
    }

    public java.util.Map<String, Object> profile(UUID accountId) {
        if (accountId == null) throw new TravelError("authentication_required");
        var rows = jdbc.query("SELECT account_id, display_name FROM travel_accounts WHERE account_id=?", (rs, index) -> {
            var result = new java.util.LinkedHashMap<String, Object>();
            result.put("id", rs.getObject("account_id", UUID.class).toString());
            String name = rs.getString("display_name");
            if (name != null && !name.contains("@")) result.put("name", name);
            return result;
        }, accountId);
        if (rows.isEmpty()) throw new TravelError("authentication_required");
        return rows.get(0);
    }
}
