// Pinned items: anything in a workspace you want one click away. Pins are
// personal: by default they live in your account's private doc for the
// workspace, which syncs between your own devices and never reaches the
// people you share with. A pin can instead be kept on this device only, in
// localStorage.
import { useSyncExternalStore } from "react";
import type { IconName } from "../components/Icon";
import type { PrivatePin, WorkspaceSession } from "./session";

export type Pin =
  | { kind: "node"; id: string }
  | { kind: "view"; id: string }
  | { kind: "task"; id: string; project: string }
  | { kind: "hub" }
  | { kind: "activity" };

/** "all": every device of this account. "device": this one only. */
export type PinScope = "all" | "device";

/** A pin with where it's kept. */
export type ScopedPin = Pin & { scope: PinScope };

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
  emit();
}

function emit() {
  combined.clear();
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const EMPTY: ScopedPin[] = [];
/** Device-only pins. */
const localKey = (workspace: string) => `pins:${workspace}`;
/** Set once the device's old pins have been moved into the account's doc. */
const migratedKey = (workspace: string) => `pins-synced:${workspace}`;

export const pinKey = (p: Pin) => ("id" in p ? `${p.kind}:${p.id}` : p.kind);

// ---- the account's pins, in the workspace's private doc --------------------

/** The open session for each workspace, so pins can reach its private doc. */
const sessions = new Map<string, WorkspaceSession>();
const unsubscribes = new Map<string, () => void>();

/**
 * Point this workspace's pins at the session's private doc. Until the doc has
 * loaded, and in windows that never call this, pins are device-only.
 */
export async function attachPins(session: WorkspaceSession, onError: (err: unknown) => void): Promise<void> {
  const ws = session.id;
  if (sessions.get(ws) === session) return;
  unsubscribes.get(ws)?.();
  sessions.set(ws, session);
  unsubscribes.set(ws, session.subscribe(emit));
  try {
    await session.loadPrivate();
    // Pins made before syncing existed move into the account's doc, once.
    if (!read<boolean>(migratedKey(ws), false)) {
      const local = read<Pin[]>(localKey(ws), []);
      if (local.length) {
        await session.changePrivate((d) => {
          for (const p of local) if (!d.pins.some((x) => samePin(fromStored(x), p))) d.pins.push(toStored(p));
        });
        write(localKey(ws), []);
      }
      write(migratedKey(ws), true);
    }
  } catch (e) {
    onError(e);
  }
  emit();
}

export function detachPins(session: WorkspaceSession) {
  if (sessions.get(session.id) !== session) return;
  unsubscribes.get(session.id)?.();
  unsubscribes.delete(session.id);
  sessions.delete(session.id);
  emit();
}

/** A pin as stored: without the scope it's read back with. */
const bare = (p: Pin): Pin => {
  const { scope: _scope, ...rest } = p as ScopedPin;
  return rest as Pin;
};
const toStored = (p: Pin): PrivatePin => ({ ...bare(p) });
const fromStored = (p: PrivatePin): Pin => {
  const kind = String(p.kind);
  if (kind === "task") return { kind, id: String(p.id), project: String(p.project) };
  if (kind === "node" || kind === "view") return { kind, id: String(p.id) };
  return { kind: kind === "activity" ? "activity" : "hub" };
};
const samePin = (a: Pin, b: Pin) => pinKey(a) === pinKey(b);

function accountPins(workspace: string): Pin[] {
  const doc = sessions.get(workspace)?.privateSnapshot;
  return doc ? doc.pins.map(fromStored) : [];
}

function changeAccountPins(workspace: string, fn: (pins: PrivatePin[]) => void): Promise<void> {
  const s = sessions.get(workspace);
  if (!s?.privateSnapshot) return Promise.reject(new Error("Pins haven't loaded yet"));
  return s.changePrivate((d) => fn(d.pins));
}

// ---- reading --------------------------------------------------------------

/** Account pins first, then device-only ones. Memoized per workspace until something changes. */
const combined = new Map<string, ScopedPin[]>();

function allPins(workspace: string): ScopedPin[] {
  let out = combined.get(workspace);
  if (out) return out;
  const account: ScopedPin[] = accountPins(workspace).map((p) => ({ ...p, scope: "all" }));
  const local: ScopedPin[] = read<Pin[]>(localKey(workspace), []).filter((p) => !account.some((a) => samePin(a, p))).map((p) => ({ ...p, scope: "device" }));
  out = account.length || local.length ? [...account, ...local] : EMPTY;
  combined.set(workspace, out);
  return out;
}

export function usePins(workspace: string): ScopedPin[] {
  return useSyncExternalStore(subscribe, () => allPins(workspace));
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

/** Where a pin is kept, if it is. */
export function pinScope(workspace: string, p: Pin): PinScope | null {
  return allPins(workspace).find((x) => samePin(x, p))?.scope ?? null;
}

// ---- writing --------------------------------------------------------------

/**
 * Pin or unpin. New pins go to the account (all devices) when the private doc
 * is ready, else to this device. Rejections are reported through the promise.
 */
export function togglePin(workspace: string, p: Pin, scope?: PinScope): Promise<void> {
  const current = pinScope(workspace, p);
  if (current) return removePin(workspace, p, current);
  const target = scope ?? (sessions.get(workspace)?.privateSnapshot ? "all" : "device");
  if (target === "all") return changeAccountPins(workspace, (pins) => void pins.push(toStored(p)));
  write(localKey(workspace), [...read<Pin[]>(localKey(workspace), []), bare(p)]);
  return Promise.resolve();
}

function removePin(workspace: string, p: Pin, scope: PinScope): Promise<void> {
  if (scope === "all") {
    return changeAccountPins(workspace, (pins) => {
      for (let i = pins.length - 1; i >= 0; i--) if (samePin(fromStored(pins[i]), p)) pins.splice(i, 1);
    });
  }
  write(localKey(workspace), read<Pin[]>(localKey(workspace), []).filter((x) => !samePin(x, p)));
  return Promise.resolve();
}

/** Move a pin between the account's list and this device's. */
export async function setPinScope(workspace: string, p: Pin, scope: PinScope): Promise<void> {
  const current = pinScope(workspace, p);
  if (!current || current === scope) return;
  await removePin(workspace, p, current);
  await togglePin(workspace, p, scope);
}

/** Move a pin to sit before another (or to the end) within its own list. */
export function movePin(workspace: string, key: string, before: string | null): Promise<void> {
  const all = allPins(workspace);
  const moving = all.find((p) => pinKey(p) === key);
  if (!moving || key === before) return Promise.resolve();
  const target = before ? all.find((p) => pinKey(p) === before) : null;
  if (target && target.scope !== moving.scope) return Promise.resolve(); // lists don't mix
  if (moving.scope === "all") {
    return changeAccountPins(workspace, (pins) => {
      const i = pins.findIndex((x) => pinKey(fromStored(x)) === key);
      if (i < 0) return;
      const stored = toStored(fromStored(pins[i]));
      pins.splice(i, 1);
      const j = before ? pins.findIndex((x) => pinKey(fromStored(x)) === before) : -1;
      pins.splice(j >= 0 ? j : pins.length, 0, stored);
    });
  }
  const pins = read<Pin[]>(localKey(workspace), []);
  const rest = pins.filter((p) => pinKey(p) !== key);
  const i = before ? rest.findIndex((p) => pinKey(p) === before) : -1;
  rest.splice(i >= 0 ? i : rest.length, 0, bare(moving));
  write(localKey(workspace), rest);
  return Promise.resolve();
}

/**
 * Pages moved to another workspace take their pins along. `ids` maps each
 * moved id (pages, and projects for their tasks) to its id over there.
 * Account pins land in the other workspace's account pins; device pins stay
 * device pins.
 */
export async function carryPins(from: WorkspaceSession, to: WorkspaceSession, ids: Record<string, string>): Promise<void> {
  const moves = (p: Pin) => ("id" in p && ids[p.id] !== undefined) || (p.kind === "task" && ids[p.project] !== undefined);
  const renamed = (p: Pin): Pin => {
    if (p.kind === "task") return { ...p, id: ids[p.id] ?? p.id, project: ids[p.project] ?? p.project };
    return "id" in p ? { ...p, id: ids[p.id] ?? p.id } : p;
  };
  const local = read<Pin[]>(localKey(from.id), []);
  const localMoving = local.filter(moves);
  if (localMoving.length) {
    const dst = read<Pin[]>(localKey(to.id), []);
    write(localKey(from.id), local.filter((p) => !localMoving.includes(p)));
    write(localKey(to.id), [...dst, ...localMoving.map(renamed).filter((p) => !isPinned(dst, p))]);
  }
  try {
    const src = await from.loadPrivate();
    const moving = src.pins.map(fromStored).filter(moves);
    if (!moving.length) return;
    const dst = await to.loadPrivate();
    const add = moving.map(renamed).filter((p) => !dst.pins.some((x) => samePin(fromStored(x), p)));
    await to.changePrivate((d) => add.forEach((p) => d.pins.push(toStored(p))));
    await from.changePrivate((d) => {
      for (let i = d.pins.length - 1; i >= 0; i--) if (moves(fromStored(d.pins[i]))) d.pins.splice(i, 1);
    });
  } catch {
    // No account yet (e.g. the demo): device pins were carried above.
  }
  emit();
}

/** Whether a collapsible rail section is open. */
export function useSectionOpen(id: string): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribe, () => read<boolean>(`section:${id}`, true));
  return [open, (v) => write(`section:${id}`, v)];
}
