// Getting images into notes: size limits, downscaling, and storage as attachments.
import { IMAGE_TYPES } from "../lib/session";

/** Larger images are scaled down to fit this many pixels on their longest side. */
const MAX_SIDE = 2400;
/** Files above this are re-encoded even when they're small enough in pixels. */
const REENCODE_ABOVE = 1.5 * 1024 * 1024;
/** Nothing larger is stored, after any downscaling. */
const MAX_BYTES = 6 * 1024 * 1024;

export interface PreparedImage {
  name: string;
  type: string;
  data: Uint8Array;
}

/** Check and shrink an image file before it's stored in a doc. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error("Only PNG, JPEG, GIF, and WebP images can be added.");
  }
  // Animated GIFs would lose their animation on a canvas; keep them as they are.
  if (file.type === "image/gif") return checked(file.name, file.type, await file.arrayBuffer());

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= REENCODE_ABOVE) {
    bitmap.close();
    return checked(file.name, file.type, await file.arrayBuffer());
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't process that image.");
  // Keep transparency for PNGs that stay small enough; photos go to JPEG.
  const type = file.type === "image/png" && scale === 1 ? "image/png" : "image/jpeg";
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, 0.86));
  if (!blob) throw new Error("Couldn't process that image.");
  const name = type === file.type ? file.name : file.name.replace(/\.\w+$/, "") + ".jpg";
  return checked(name, blob.type || type, await blob.arrayBuffer());
}

function checked(name: string, type: string, buf: ArrayBuffer): PreparedImage {
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`That image is over ${MAX_BYTES / 1024 / 1024} MB even after shrinking it.`);
  }
  return { name: name.slice(0, 120), type, data: new Uint8Array(buf) };
}

/** Ask for an image file. Resolves null if the picker is dismissed. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_TYPES.join(",");
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export const ATTACHMENT_PREFIX = "att:";
