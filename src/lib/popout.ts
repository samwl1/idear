// Pop a page out into its own window. The new window runs the whole app with
// the sidebar hidden, opened on one page (the hash says which). Edits made
// in any window reach the others through the backend (see "local-applied").
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** What this window was opened on, when it's a pop-out. */
export function popTarget(): { workspace: string; id: string } | null {
  const m = /^#pop\/([^/]+)\/([^/]+)$/.exec(window.location.hash);
  return m ? { workspace: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) } : null;
}

export const isPopout = () => popTarget() !== null;

/** This window's label ("main", or "pop-…"). */
export function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

/** Open `id` in its own window, or bring that window forward if it's already open. */
export async function popOut(workspace: string, id: string, title: string) {
  const label = `pop-${id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40)}`;
  const existing = (await getAllWebviewWindows()).find((w) => w.label === label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const url = `${window.location.pathname}#pop/${encodeURIComponent(workspace)}/${encodeURIComponent(id)}`;
  const w = new WebviewWindow(label, { url, title: title || "idear", width: 960, height: 720, minWidth: 320, minHeight: 240 });
  await new Promise<void>((resolve, reject) => {
    w.once("tauri://created", () => resolve());
    w.once("tauri://error", (e) => reject(new Error(String(e.payload ?? "Couldn't open a window"))));
  });
}
