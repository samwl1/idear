// The sidebar's width and whether it's collapsed, remembered on this device.
import { useCallback, useEffect, useState } from "react";

export const RAIL_MIN = 200;
export const RAIL_MAX = 520;
export const RAIL_DEFAULT = 268;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: lasts for this session
  }
}

export const clampWidth = (w: number) => Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, w)));

/**
 * `remember`: keep the collapsed state across launches. A pop-out window
 * passes false: it never shows the sidebar, and must not write a collapsed
 * state that the main window would pick up next time.
 */
export function useSidebar(remember = true, startCollapsed = false) {
  const [width, setWidthState] = useState(() => clampWidth(load("sidebar:width", RAIL_DEFAULT)));
  const [collapsed, setCollapsedState] = useState(() => (remember ? load("sidebar:collapsed", startCollapsed) : startCollapsed));
  const persist = useCallback((c: boolean) => remember && save("sidebar:collapsed", c), [remember]);

  const setWidth = useCallback((w: number) => {
    const c = clampWidth(w);
    setWidthState(c);
    save("sidebar:width", c);
  }, []);

  const setCollapsed = useCallback(
    (c: boolean) => {
      setCollapsedState(c);
      persist(c);
    },
    [persist],
  );

  // Cmd+\ (Ctrl+\ on Linux) shows and hides it, like most editors. Not in a
  // pop-out, which has no sidebar to show.
  useEffect(() => {
    if (!remember) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCollapsedState((c) => {
          persist(!c);
          return !c;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [persist, remember]);

  return { width, setWidth, collapsed, setCollapsed };
}

/** Drag the sidebar's edge to resize it. */
export function startResize(e: React.PointerEvent, width: number, setWidth: (w: number) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  document.body.dataset.resizing = "";
  const move = (ev: PointerEvent) => setWidth(width + ev.clientX - startX);
  const up = () => {
    delete document.body.dataset.resizing;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
