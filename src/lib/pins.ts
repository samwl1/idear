// Pinned items: anything in a workspace you want one click away. Pins are
// personal, so they're kept on this device rather than in the shared workspace.
import { useSyncExternalStore } from "react";
import type { IconName } from "../components/Icon";

export type Pin =
  | { kind: "node"; id: string }
  | { kind: "view"; id: string }
  | { kind: "task"; id: string; project: string }
  | { kind: "hub" }
  | { kind: "activity" };

export interface PinnedSettings {
  name: string;
  icon: IconName;
}

const DEFAULTS: PinnedSettings = { name: "Pinned", icon: "pin" };
const listeners = new Set<() => void>();
const cache = new Map<string, unknown>();

function read<T>(key: string, fallback: T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let value = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw) value = JSON.parse(raw) as T;
  } catch {
    // storage unavailable or damaged: start fresh
  }
  cache.set(key, value);
  return value;
}

function write(key: string, value: unknown) {
  cache.set(key, value);
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: keep it for this session
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const EMPTY: Pin[] = [];
const pinsKey = (workspace: string) => `pins:${workspace}`;

export const pinKey = (p: Pin) => ("id" in p ? `${p.kind}:${p.id}` : p.kind);

export function usePins(workspace: string): Pin[] {
  return useSyncExternalStore(subscribe, () => read<Pin[]>(pinsKey(workspace), EMPTY));
}

export function usePinnedSettings(): PinnedSettings {
  return useSyncExternalStore(subscribe, () => read<PinnedSettings>("pinned:settings", DEFAULTS));
}

export function setPinnedSettings(s: PinnedSettings) {
  write("pinned:settings", s);
}

export function isPinned(pins: Pin[], p: Pin) {
  return pins.some((x) => pinKey(x) === pinKey(p));
}

export function togglePin(workspace: string, p: Pin) {
  const pins = read<Pin[]>(pinsKey(workspace), EMPTY);
  write(pinsKey(workspace), isPinned(pins, p) ? pins.filter((x) => pinKey(x) !== pinKey(p)) : [...pins, p]);
}

/** Move a pin to sit before another (or to the end). */
export function movePin(workspace: string, key: string, before: string | null) {
  const pins = read<Pin[]>(pinsKey(workspace), EMPTY);
  const moving = pins.find((p) => pinKey(p) === key);
  if (!moving || key === before) return;
  const rest = pins.filter((p) => pinKey(p) !== key);
  const i = before ? rest.findIndex((p) => pinKey(p) === before) : -1;
  rest.splice(i >= 0 ? i : rest.length, 0, moving);
  write(pinsKey(workspace), rest);
}

/** Whether a collapsible rail section is open. */
export function useSectionOpen(id: string): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribe, () => read<boolean>(`section:${id}`, true));
  return [open, (v) => write(`section:${id}`, v)];
}
