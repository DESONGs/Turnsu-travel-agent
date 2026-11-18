import { GIFEncoder, quantize, applyPalette } from "gifenc";

const width = 720,
  height = 540;
const paper = "#f9f5eb",
  ink = "#272722";
const writing = '"Kaiti SC","STKaiti","KaiTi","Songti SC",serif';

const paintingTop = 22, paintingHeight = 340;

export function postcardFrame(entry, drawing, caption, position = 0) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.fillStyle = paper;
  c.fillRect(0, 0, width, height);
  c.strokeStyle = "#b6ab95";
  c.lineWidth = 1;
  c.strokeRect(9.5, 9.5, width - 19, height - 19);
  if (drawing) {
    const scale = Math.min(660 / drawing.width, paintingHeight / drawing.height);
    const w = drawing.width * scale,
      h = drawing.height * scale;
    const left = (width - w) / 2,
      top = paintingTop + (paintingHeight - h) / 2;
    c.save();
    c.beginPath();
    c.rect(left, top, w, h);
    c.clip();
    for (const { canvas: layer, depth } of drawing.plates) {
      const shift = position * (depth - 2) * h * 0.008;
      c.drawImage(layer, left - w * 0.019 + shift, top - h * 0.019, w * 1.038, h * 1.038);
    }
    c.restore();
  }

  const date = entry.takenOn || entry.createdAt?.slice(0, 10);
  const headingY = drawing ? 401 : 130;
  c.fillStyle = ink;
  c.font = "bold 29px " + writing;
  c.fillText(entry.placeTitle, 32, headingY, date ? 484 : 648);
  if (date) {
    // The dated impression stays on the paper as the illustration moves.
    c.save();
    c.translate(598, headingY - 7);
    c.rotate(-0.045);
    c.strokeStyle = "#9f624c";
    c.fillStyle = c.strokeStyle;
    c.lineWidth = 1;
    c.strokeRect(-65, -14, 130, 27);
    c.font = "15px ui-monospace, monospace";
    c.textAlign = "center";
    c.fillText(date.replaceAll("-", "."), 0, 5);
    c.restore();
  }
  c.font = "23px " + writing;
  let line = "",
    y = drawing ? 445 : 193;
  for (const char of caption) {
    if (char === "\n" || c.measureText(line + char).width > 650) {
      c.fillText(line, 32, y);
      line = "";
      y += 30;
    }
    if (char !== "\n") line += char;
  }
  if (line) c.fillText(line, 30, y);
  c.fillStyle = "#625d56";
  c.font = "15px sans-serif";
  c.strokeStyle = "#cec5b4";
  c.beginPath();
  c.moveTo(32, 493.5);
  c.lineTo(688, 493.5);
  c.stroke();
  c.textAlign = "right";
  c.fillText(entry.photos?.[0]?.source || "", 690, 516, 490);
  return canvas;
}
export function cardCaption(text) {
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 54).join("");
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function exportPostcard(entry, drawing, caption, format) {
  // A single card can be shared without including a journal ID, account or other entries.
  const frame = (angle) => postcardFrame(entry, drawing, caption, angle);
  const cover = frame(0);
  if (format === "png")
    return new Promise((resolve, reject) =>
      cover.toBlob((b) => (b ? resolve(b) : reject(Error("PNG export failed"))), "image/png"),
    );
  if (format === "live") {
    const { encodeLiveCard } = await import("./postcard-live.js");
    return encodeLiveCard(frame);
  }
  const gif = GIFEncoder(),
    frames = 36;
  const pixels = cover.getContext("2d").getImageData(0, 0, width, height).data;
  const palette = quantize(pixels, 255);
  const transparentIndex = palette.length;
  let previous;
  for (let i = 0; i < frames; i++) {
    // Store the paper and handwriting once. Only changed pixels in the view move.
    const rows = i === 0 ? height : paintingTop + paintingHeight;
    const indexed = i === 0 ? applyPalette(pixels, palette)
      : applyPalette(frame(Math.sin(2 * Math.PI * i / frames)).getContext("2d").getImageData(0, 0, width, rows).data, palette);
    const delta = indexed.slice();
    if (previous) {
      for (let p = 0; p < delta.length; p++) if (delta[p] === previous[p]) delta[p] = transparentIndex;
    }
    gif.writeFrame(delta, width, rows, {
      palette: i === 0 ? [...palette, [0, 0, 0]] : undefined,
      transparent: i > 0, transparentIndex, dispose: 1,
      delay: Math.round(((i + 1) * 300) / frames) * 10 - Math.round((i * 300) / frames) * 10,
      repeat: 0
    });
    previous = indexed;
    await pause();
  }
  gif.finish();
  return new Blob([gif.bytesView()], { type: "image/gif" });
}
