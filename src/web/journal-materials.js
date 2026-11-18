import { journalTemplates } from "../media/journal-templates.js";
import linen from "./journal-linen.webp";
import bindings from "./journal-bindings.webp";
import world from "./journal-bindings-world.webp";

const sheets = [
  { url: bindings, columns: 3, rows: 2, ids: ["song", "ming", "british", "egyptian", "french", "roman"] },
  { url: world, columns: 2, rows: 2, ids: ["edo", "safavid", "mixtec", "asante"] },
  { url: linen, columns: 1, rows: 1, ids: ["plain"] },
];
function tile(id) {
  const sheet = sheets.find(item => item.ids.includes(id)) ?? sheets[2];
  const index = Math.max(0, sheet.ids.indexOf(id));
  return { ...sheet, column: index % sheet.columns, row: Math.floor(index / sheet.columns) };
}
export function journalSurface(id) {
  const { url, columns, rows, column, row } = tile(id);
  const style = journalTemplates[id] ?? journalTemplates.plain;
  return {
    "--book-material": 'url("' + url + '")',
    "--material-size": columns * 100 + "% " + rows * 100 + "%",
    "--material-position": (column * 100 / Math.max(1, columns-1)) + "% " + (row * 100 / Math.max(1, rows-1)) + "%",
    "--book-cover": style.cover, "--book-paper": style.paper, "--book-ink": style.ink, "--book-accent": style.accent,
  };
}
const decoded = new Map();
export async function postcardMaterial(id) {
  const {url, columns, rows, column, row} = tile(id);
  if (!decoded.has(url)) {
    const image = new Image();
    image.src = url;
    decoded.set(url, image.decode().then(() => image).catch(error => { decoded.delete(url); throw error; }));
  }
  const image = await decoded.get(url);
  const w = image.naturalWidth / columns, h = image.naturalHeight / rows;
  return [image, column*w, row*h, w, h];
}
