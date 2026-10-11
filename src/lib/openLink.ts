import { openUrl } from "@tauri-apps/plugin-opener";

/** Only web and mail links leave the app; anything else is ignored. */
const ALLOWED = /^(https?:\/\/|mailto:)/i;

/** Open a link in the system's default browser or mail app. */
export function openExternal(href: string | null | undefined, onError?: (err: unknown) => void) {
  if (!href || !ALLOWED.test(href.trim())) return false;
  openUrl(href.trim()).catch((err) => onError?.(err) ?? console.error(err));
  return true;
}
