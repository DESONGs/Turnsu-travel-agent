package app.travelagent.core;

import static org.junit.jupiter.api.Assertions.*;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class TravelJournalEditingPostgresTest {
    static EmbeddedPostgres postgres;
    static JdbcTemplate jdbc;
    TravelTrips trips;
    TravelJournal journal;
    TravelAccounts accounts;
    UUID owner, member, trip;

    @BeforeAll static void database() throws Exception {
        postgres = EmbeddedPostgres.builder().setPort(0).start();
        var source = postgres.getPostgresDatabase();
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
    }
    @AfterAll static void close() throws Exception { if (postgres != null) postgres.close(); }
    @BeforeEach void initialize() {
        jdbc.execute("TRUNCATE travel_accounts CASCADE");
        var tx = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        accounts = new TravelAccounts(jdbc); trips = new TravelTrips(jdbc, tx, Clock.systemUTC());
        journal = new TravelJournal(jdbc, tx, new TravelResults(jdbc, tx));
        owner = accounts.fromVerifiedGoogleSubject("journal-editor", "Owner"); member = accounts.fromVerifiedGoogleSubject("journal-member", "Member");
        trip = UUID.fromString((String) trips.create(owner, "trip", Map.of("destination", "京都")).get("tripId"));
    }
    Map<String, Object> save(UUID actor, UUID entry, long version, String request, String note, List<?> photos) {
        return journal.saveEntry(actor, trip, 0, request, entry, version, "东山散步", note, "2026-11-21", "building", "visited", null, photos);
    }
    @SuppressWarnings("unchecked") Map<String, Object> entry(Map<String, Object> result) { return (Map<String, Object>) result.get("entry"); }
    Map<String, Object> recipe(double depth) { return Map.of("version", "photo-relief-v1", "horizon", .48, "depth", depth, "style", "ink"); }
    String jpeg() throws Exception {
        var buffer = new ByteArrayOutputStream();
        javax.imageio.ImageIO.write(new BufferedImage(32, 24, BufferedImage.TYPE_INT_RGB), "jpeg", buffer);
        return Base64.getEncoder().encodeToString(buffer.toByteArray());
    }

    @Test void aTextMemoryCanBeCreatedAndEditedAfterTheTripWithoutACandidateReference() {
        var id = UUID.randomUUID();
        var first = save(owner, id, -1, "create", "今天只想记住一段散步。", List.of());
        assertEquals("saved", first.get("status")); assertEquals(0L, entry(first).get("entryRevision"));
        assertEquals(List.of(), entry(first).get("photos"));
        var edited = save(owner, id, 0, "edit", "补充了回到酒店前的片刻。", List.of());
        assertEquals(1L, entry(edited).get("entryRevision"));
        assertEquals("补充了回到酒店前的片刻。", entry(journal.get(owner, trip, id)).get("note"));
        assertEquals(0L, trips.get(owner, trip).get("revision"), "A journal edit must not change planning or itinerary acknowledgments");
        assertEquals(1, ((List<?>) journal.list(owner, trip).get("items")).size());
    }

    @Test void savedEffectsSurviveReopenAndPhotoReorderingWithoutChangingSourceBytes() throws Exception {
        UUID id = UUID.randomUUID(), a = UUID.randomUUID(), b = UUID.randomUUID();
        save(owner, id, -1, "photos", "两张照片", List.of(Map.of("photoId", a.toString(), "data", jpeg()), Map.of("photoId", b.toString(), "data", jpeg())));
        var original = journal.photoById(owner, trip, id, a).get("data");
        var effect = journal.saveRelief(owner, trip, 0, "effect", id, 0, a, recipe(.8));
        assertEquals(1L, entry(effect).get("entryRevision"));
        var reordered = save(owner, id, 1, "reorder", "次序已改", List.of(Map.of("photoId", b.toString()), Map.of("photoId", a.toString())));
        var photos = (List<?>) entry(reordered).get("photos");
        assertEquals(a.toString(), ((Map<?, ?>) photos.get(1)).get("photoId"));
        assertEquals(.8, ((Map<?, ?>) ((Map<?, ?>) photos.get(1)).get("relief")).get("depth"));
        assertEquals(original, journal.photoById(owner, trip, id, a).get("data"));
        assertEquals(journal.photoById(owner, trip, id, a), journal.photo(owner, trip, id, 1));
    }

    @Test void aLostReplyCanBeRetriedWithoutOverwritingLaterEditsAndDeletedPhotosCannotReturn() throws Exception {
        UUID id = UUID.randomUUID(), photo = UUID.randomUUID();
        var content = List.of(Map.of("photoId", photo.toString(), "data", jpeg()));
        save(owner, id, -1, "create", "第一次保存", content);
        save(owner, id, 0, "edit", "后来的修改", List.of(Map.of("photoId", photo.toString())));
        var receipt = save(owner, id, -1, "create", "第一次保存", content);
        assertEquals("后来的修改", entry(receipt).get("note")); assertEquals(0, ((Number) receipt.get("appliedEntryRevision")).intValue());
        assertEquals("journal_revision_conflict", assertThrows(TravelError.class, () -> save(owner, id, 0, "stale", "错误覆盖", List.of())).code());
        assertEquals("journal_revision_conflict", assertThrows(TravelError.class, () -> journal.delete(owner, trip, 0, "stale-delete", id, 0L)).code());
        journal.delete(owner, trip, 0, "delete", id, 1L);
        assertEquals("deleted", save(owner, id, -1, "create", "第一次保存", content).get("status"));
        assertEquals("journal_id_conflict", assertThrows(TravelError.class, () -> save(owner, id, -1, "resurrect", "不能重建", content)).code());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM travel_journal_photos", Integer.class));
    }

    @Test void viewersCanReadButNotEditAndRevocationBlocksMediaAndOldWriteReceipts() throws Exception {
        UUID id = UUID.randomUUID(), photo = UUID.randomUUID();
        save(owner, id, -1, "private", "只给旅行成员看", List.of(Map.of("photoId", photo.toString(), "data", jpeg())));
        trips.grant(owner, trip, member, "viewer", 0, "viewer");
        assertNotNull(journal.photoById(member, trip, id, photo).get("data"));
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> save(member, id, 0, "denied", "不能编辑", List.of())).code());
        trips.grant(owner, trip, member, "editor", 1, "editor");
        save(member, id, 0, "member-edit", "同行人补充", List.of(Map.of("photoId", photo.toString())));
        trips.revoke(owner, trip, member, 2, "revoke");
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> journal.photoById(member, trip, id, photo)).code());
        assertEquals("trip_not_found", assertThrows(TravelError.class, () -> save(member, id, 0, "member-edit", "同行人补充", List.of(Map.of("photoId", photo.toString())))).code());
    }

    @Test void aPhotoCannotBeBorrowedFromAnotherEntryAndUnsupportedEffectsAreRejected() throws Exception {
        UUID a = UUID.randomUUID(), b = UUID.randomUUID(), photo = UUID.randomUUID();
        save(owner, a, -1, "a", "原记录", List.of(Map.of("photoId", photo.toString(), "data", jpeg())));
        assertEquals("journal_photo_invalid", assertThrows(TravelError.class, () -> save(owner, b, -1, "b", "不能借用照片", List.of(Map.of("photoId", photo.toString())))).code());
        assertEquals("journal_visit_not_found", assertThrows(TravelError.class, () -> journal.saveEntry(owner, trip, 0, "bad-visit", b, -1, "标题", "备注", null,
                "building", "visited", "not-a-trip-visit", List.of())).code());
        assertEquals("journal_empty", assertThrows(TravelError.class, () -> journal.saveEntry(owner, trip, 0, "empty", b, -1, "", "", null,
                "building", "visited", null, List.of())).code());
        assertEquals("journal_relief_invalid", assertThrows(TravelError.class, () -> journal.saveRelief(owner, trip, 0, "bad-effect", a, 0, photo, recipe(8))).code());
        assertEquals(0L, entry(journal.get(owner, trip, a)).get("entryRevision"));
    }
}
