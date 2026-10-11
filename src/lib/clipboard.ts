/** Copy text, falling back to a hidden textarea where the clipboard API is blocked. */
export async function copy(text: string, fallback: HTMLTextAreaElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some webviews block the clipboard API; fall back to selecting the text.
    if (fallback) {
      fallback.select();
      return document.execCommand("copy");
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function ago(ts: number): string {
  const s = Math.round((ts - Date.now()) / 1000);
  if (Math.abs(s) < 60) return rtf.format(s, "second");
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(h, "hour");
  return rtf.format(Math.round(h / 24), "day");
}
