// App-wide toasts: a short message, optionally with one action (Undo, Open…).
// One toast shows at a time; a new one replaces the old.
import { useSyncExternalStore } from "react";

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  /** Milliseconds before it goes away on its own. */
  ttl: number;
  kind: "info" | "error";
}

let current: Toast | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function set(t: Toast | null) {
  current = t;
  if (timer) clearTimeout(timer);
  timer = t ? setTimeout(() => set(null), t.ttl) : null;
  listeners.forEach((l) => l());
}

export function showToast(message: string, opts: Partial<Omit<Toast, "id" | "message">> = {}) {
  set({ id: ++seq, message, ttl: opts.action ? 8000 : 5000, kind: "info", ...opts });
}

export function showError(message: string) {
  set({ id: ++seq, message, ttl: 8000, kind: "error" });
}

export function dismissToast(id?: number) {
  if (id === undefined || current?.id === id) set(null);
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
