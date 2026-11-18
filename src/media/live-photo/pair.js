// The two small templates were generated with Apple ImageIO (MakerApple key 17)
// and AVAssetWriter (one signed-byte still-image-time sample at time zero).
// They contain no user media. The AVC track and its original chunk offsets are
// preserved by keeping mdat in place and extending the final moov.
import exif from "./apple-exif.b64?raw";
import metadata from "./timed-metadata.b64?raw";

const referenceID = "12345678-1234-4123-8123-123456789abc";
const ascii = new TextEncoder();
const unpack = (s) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
const uint32 = (arr, at) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength).getUint32(at);
const put = (arr, at, n) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength).setUint32(at, n);
function boxes(bytes, start = 0) {
  const result = [];
  for (let i = start; i < bytes.length; ) {
    const size = uint32(bytes, i);
    if (size < 8 || i + size > bytes.length) throw Error("Invalid movie box");
    result.push({
      type: String.fromCharCode(...bytes.subarray(i + 4, i + 8)),
      bytes: bytes.subarray(i, i + size),
    });
    i += size;
  }
  return result;
}
function child(parent, type) {
  const item = boxes(parent, 8).find((box) => box.type === type);
  if (!item) throw Error("Missing movie box " + type);
  return item.bytes;
}
function replaceIdentifier(bytes, id) {
  const index = new TextDecoder("latin1").decode(bytes).indexOf(referenceID);
  if (index < 0 || id.length !== 36) throw Error("Invalid asset identifier");
  bytes.set(ascii.encode(id), index);
}
export function pairLivePhoto(jpeg, mp4, assetID) {
  const makerNote = unpack(exif),
    template = boxes(unpack(metadata));
  replaceIdentifier(makerNote, assetID);
  const content = boxes(mp4);
  const header = content.find((box) => box.type === "ftyp").bytes;
  const movie = content.at(-1);
  if (movie.type !== "moov" || jpeg[0] !== 255 || jpeg[1] !== 216) throw Error("Invalid postcard media");
  header.set(ascii.encode("qt  "), 8);
  const oldMovie = movie.bytes,
    movieHeader = child(oldMovie, "mvhd");
  if (movieHeader[8] !== 0) throw Error("Unsupported movie timebase");
  const timescale = uint32(movieHeader, 20);
  const templateMovie = template.find((box) => box.type === "moov").bytes;
  const meta = child(templateMovie, "meta"),
    track = child(templateMovie, "trak");
  replaceIdentifier(meta, assetID);
  const sample = template.find((box) => box.type === "mdat").bytes;
  const timeHeader = child(track, "tkhd");
  put(timeHeader, 20, 2);
  put(timeHeader, 28, Math.max(1, Math.round(timescale / 24)));
  put(child(child(track, "edts"), "elst"), 16, Math.max(1, Math.round(timescale / 24)));
  const chunks = child(child(child(child(track, "mdia"), "minf"), "stbl"), "stco");
  put(chunks, 16, mp4.length - oldMovie.length + 8);
  put(movieHeader, movieHeader.length - 4, 3);
  put(oldMovie, 0, oldMovie.length + track.length + meta.length);
  return {
    jpeg: new Blob([jpeg.subarray(0, 2), makerNote, jpeg.subarray(2)], { type: "image/jpeg" }),
    mov: new Blob([...content.slice(0, -1).map((x) => x.bytes), sample, oldMovie, track, meta], {
      type: "video/quicktime",
    }),
  };
}
