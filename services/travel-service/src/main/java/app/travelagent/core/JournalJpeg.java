package app.travelagent.core;

import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.Set;

/** The browser re-encodes photographs. The server also strips JPEG APP and COM metadata. */
final class JournalJpeg {
    private static final Set<Integer> ALLOWED = Set.of(0xc0, 0xc4, 0xdb, 0xdd, 0xda, 0xfe);
    private JournalJpeg() {}

    static Photo sanitize(Object value) {
        if (!(value instanceof String encoded) || encoded.length() > 600_000 || !encoded.matches("[A-Za-z0-9+/]+={0,2}")) throw invalid();
        byte[] bytes;
        try { bytes = Base64.getDecoder().decode(encoded); }
        catch (IllegalArgumentException error) { throw invalid(); }
        if (bytes.length < 20 || bytes.length > 450_000 || !Base64.getEncoder().encodeToString(bytes).equals(encoded)
                || unsigned(bytes[0]) != 0xff || unsigned(bytes[1]) != 0xd8) throw invalid();
        var clean = new ByteArrayOutputStream(bytes.length); clean.write(bytes, 0, 2);
        int offset = 2, width = 0, height = 0;
        while (offset + 4 <= bytes.length) {
            if (unsigned(bytes[offset]) != 0xff) throw invalid();
            int marker = unsigned(bytes[offset + 1]);
            int length = (unsigned(bytes[offset + 2]) << 8) | unsigned(bytes[offset + 3]);
            int end = offset + 2 + length;
            if (length < 2 || end > bytes.length) throw invalid();
            if (marker == 0xc0) {
                if (length < 11 || width != 0 || unsigned(bytes[offset + 4]) != 8) throw invalid();
                height = (unsigned(bytes[offset + 5]) << 8) | unsigned(bytes[offset + 6]);
                width = (unsigned(bytes[offset + 7]) << 8) | unsigned(bytes[offset + 8]);
                if (width < 1 || height < 1 || width > 1280 || height > 1280) throw invalid();
            } else if (!ALLOWED.contains(marker) && !(marker >= 0xe0 && marker <= 0xef)) throw invalid();
            if (!(marker >= 0xe0 && marker <= 0xef) && marker != 0xfe) clean.write(bytes, offset, end - offset);
            if (marker == 0xda) {
                if (width == 0) throw invalid();
                for (int scan = end; scan < bytes.length - 1; scan++) {
                    if (unsigned(bytes[scan]) != 0xff) continue;
                    int next = unsigned(bytes[++scan]);
                    if (next == 0 || (next >= 0xd0 && next <= 0xd7)) continue;
                    if (next != 0xd9) throw invalid();
                    clean.write(bytes, end, scan + 1 - end);
                    return new Photo(clean.toByteArray(), width, height);
                }
                throw invalid();
            }
            offset = end;
        }
        throw invalid();
    }

    private static int unsigned(byte value) { return value & 0xff; }
    private static TravelError invalid() { return new TravelError("journal_photo_invalid"); }
    record Photo(byte[] bytes, int width, int height) {}
}
