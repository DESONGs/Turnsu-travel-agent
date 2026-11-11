package app.travelagent.core;

import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class JournalJpegTest {
    private static final String JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAA//2Q==";

    @Test
    void stripsExifAndTrailingBytesAndRejectsUnsupportedImages() {
        byte[] original = Base64.getDecoder().decode(JPEG);
        byte[] exif = "Exif\0\0GPS secret".getBytes(StandardCharsets.UTF_8);
        var input = new ByteArrayOutputStream(); input.write(original, 0, 2);
        input.write(0xff); input.write(0xe1); int length = exif.length + 2; input.write(length >> 8); input.write(length & 0xff);
        input.writeBytes(exif); input.write(original, 2, original.length - 2); input.writeBytes("trailing-sensitive-data".getBytes(StandardCharsets.UTF_8));
        var clean = JournalJpeg.sanitize(JPEG);
        var stripped = JournalJpeg.sanitize(Base64.getEncoder().encodeToString(input.toByteArray()));
        assertEquals(1, clean.width()); assertEquals(1, clean.height());
        assertArrayEquals(clean.bytes(), stripped.bytes());
        assertEquals("journal_photo_invalid", assertThrows(TravelError.class, () -> JournalJpeg.sanitize("iVBORw0KGgo=")).code());
        assertEquals("journal_photo_invalid", assertThrows(TravelError.class, () -> JournalJpeg.sanitize("A".repeat(600001))).code());
        var progressive = original.clone();
        for (int i = 0; i < progressive.length - 1; i++) if ((progressive[i] & 0xff) == 0xff && (progressive[i + 1] & 0xff) == 0xc0) { progressive[i + 1] = (byte) 0xc2; break; }
        assertEquals("journal_photo_invalid", assertThrows(TravelError.class, () -> JournalJpeg.sanitize(Base64.getEncoder().encodeToString(progressive))).code());
    }
}
