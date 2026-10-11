import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type SyncStatus } from "../lib/api";
import { ago } from "../lib/clipboard";
import { Icon } from "./Icon";

type State = "off" | "starting" | "ok" | "local" | "warn" | "error";

/** One line in the sidebar footer: is sync working right now? Click for the details. */
export function SyncIndicator({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => api.syncStatus().then((s) => live && setStatus(s), () => {});
    refresh();
    // Cheap poll; sync-applied fires for incoming changes so those show at once.
    const t = setInterval(refresh, 15000);
    const off = listen("sync-applied", refresh);
    return () => {
      live = false;
      clearInterval(t);
      off.then((fn) => fn());
    };
  }, []);

  if (!status) return null;
  const { state, label, detail } = describe(status);

  return (
    <button className="sync-pill" data-state={state} title={detail} aria-label={`Sync: ${label}. ${detail}`} onClick={onOpen}>
      <span className="sync-dot" aria-hidden="true" />
      <span className="row-label">{label}</span>
      {state === "warn" || state === "error" ? <Icon name="cloud" /> : null}
    </button>
  );
}

function describe(s: SyncStatus): { state: State; label: string; detail: string } {
  if (!s.settings.enabled) return { state: "off", label: "Sync off", detail: "Live sync is off. Changes move with update files." };
  if (!s.running) return { state: "starting", label: "Starting sync", detail: "Live sync is starting." };

  const peers = Object.values(s.peers);
  const failing = peers.filter((p) => p.lastError);
  const synced = peers.map((p) => p.lastSync).filter((t): t is number => t !== null);
  const last = synced.length ? Math.max(...synced) : null;
  const lastText = last ? `Last synced ${ago(last)}.` : "Nothing synced yet.";

  if (s.settings.relay && !s.relayConnected) {
    return { state: "warn", label: "No relay", detail: `Can't reach the relay, so only devices on this network sync. ${lastText}` };
  }
  if (failing.length && failing.length === peers.length) {
    return { state: "error", label: "Sync failing", detail: `${failing[0].lastError}. ${lastText}` };
  }
  if (!s.settings.relay) return { state: "local", label: "Local only", detail: `Syncing on this network only. ${lastText}` };
  if (!peers.length) return { state: "local", label: "No devices", detail: "Live sync is on. Link another device or join a shared workspace to sync." };
  return { state: "ok", label: last ? `Synced ${brief(last)}` : "Synced", detail: failing.length ? `${failing.length} device(s) can't be reached. ${lastText}` : lastText };
}

/** "2m", "3h", "5d": short enough for the footer. */
function brief(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
