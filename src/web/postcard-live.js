import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { zipSync } from "fflate";
import { pairLivePhoto } from "../media/live-photo/pair.js";

export async function encodeLiveCard(frame) {
  const cover = frame(0),
    fps = 24,
    count = 3 * fps;
  const config = {
    codec: "avc1.42001f",
    width: cover.width,
    height: cover.height,
    bitrate: 2500000,
    framerate: fps,
    avc: { format: "avc" },
  };
  if (
    !globalThis.VideoEncoder ||
    !globalThis.VideoFrame ||
    !(await VideoEncoder.isConfigSupported(config)).supported
  )
    throw Error("live_encoder_unavailable");
  const target = new ArrayBufferTarget();
  const mux = new Muxer({
    target,
    video: { codec: "avc", width: cover.width, height: cover.height },
    fastStart: false,
    firstTimestampBehavior: "offset",
  });
  let failure;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => mux.addVideoChunk(chunk, meta),
    error: (error) => {
      failure = error;
    },
  });
  try {
    encoder.configure(config);
    for (let i = 0; i < count; i++) {
      if (failure) throw failure;
      const timestamp = Math.round((i * 1000000) / fps);
      const f = new VideoFrame(frame(Math.sin((2 * Math.PI * i) / count)), {
        timestamp,
        duration: Math.round(((i + 1) * 1000000) / fps) - timestamp,
      });
      try {
        encoder.encode(f, { keyFrame: i % fps === 0 });
      } finally {
        f.close();
      }
      if (encoder.encodeQueueSize > 5) await encoder.flush();
    }
    await encoder.flush();
    if (failure) throw failure;
    mux.finalize();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  const jpeg = await new Promise((resolve) => cover.toBlob(resolve, "image/jpeg", 0.92));
  const pair = pairLivePhoto(
    new Uint8Array(await jpeg.arrayBuffer()),
    new Uint8Array(target.buffer),
    crypto.randomUUID(),
  );
  const files = {};
  for (const [name, blob] of [
    ["Postcard.JPG", pair.jpeg],
    ["Postcard.MOV", pair.mov],
  ])
    files[name] = new Uint8Array(await blob.arrayBuffer());
  return new Blob([zipSync(files, { level: 0 })], { type: "application/zip" });
}
