// Copies Excalidraw's fonts into public/ so the whiteboard never fetches them from a CDN.
// The CJK fallback (Xiaolai, ~13 MB) is skipped; CJK text falls back to system fonts.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const src = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const dest = "public/excalidraw/fonts";
const skip = new Set(["Xiaolai"]);

if (!existsSync(src)) {
  console.error(`Missing ${src}. Run npm install first.`);
  process.exit(1);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const family of readdirSync(src)) {
  if (!skip.has(family)) cpSync(join(src, family), join(dest, family), { recursive: true });
}
