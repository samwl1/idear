// Two pages side by side in one window. Purely a way of looking: nothing
// about it is saved in the workspace or synced, only the divider's position
// is remembered on this device.
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { NavContext, type Nav } from "../lib/nav";
import type { WorkspaceSession } from "../lib/session";
import { useTree } from "../lib/useTree";

export type Half = "main" | "side";

const RATIO_KEY = "split:ratio";
const MIN = 0.2;
const MAX = 0.8;
const clamp = (r: number) => Math.min(MAX, Math.max(MIN, r));

/** The left half's share of the width, remembered on this device. */
export function useSplitRatio(): [number, (r: number) => void] {
  const [ratio, setRatioState] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(RATIO_KEY));
      return saved ? clamp(saved) : 0.5;
    } catch {
      return 0.5;
    }
  });
  const setRatio = useCallback((r: number) => {
    const next = clamp(r);
    setRatioState(next);
    try {
      localStorage.setItem(RATIO_KEY, String(next));
    } catch {
      // storage unavailable: keep it for this session
    }
  }, []);
  return [ratio, setRatio];
}

/** The bar between the halves: drag it, or use the arrow keys. Double-click evens them out. */
export function SplitDivider({ ratio, onRatio }: { ratio: number; onRatio: (r: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = (e: React.PointerEvent) => {
    const box = ref.current?.parentElement?.getBoundingClientRect();
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    document.body.dataset.resizing = "";
    const move = (ev: PointerEvent) => onRatio((ev.clientX - box.left) / box.width);
    const up = () => {
      delete document.body.dataset.resizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  return (
    <div
      ref={ref}
      className="split-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the two panes"
      aria-valuemin={MIN * 100}
      aria-valuemax={MAX * 100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      title="Drag to resize, double-click to even out"
      onPointerDown={start}
      onDoubleClick={() => onRatio(0.5)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onRatio(ratio - 0.02);
        else if (e.key === "ArrowRight") onRatio(ratio + 0.02);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** Panes narrower than this get the tighter layout a shrunk window gets. */
const NARROW_PX = 640;

interface PaneProps {
  half: Half;
  /** Whether two panes are showing: adds the title bar with its close button. */
  split: boolean;
  focused: boolean;
  title: ReactNode;
  icon: IconName;
  /** Links followed inside this pane open in this pane. */
  nav: Nav;
  onFocus: () => void;
  onClose: () => void;
  children: ReactNode;
}

/** One half of the window (or all of it, when there's no split). */
export function Pane({ half, split, focused, title, icon, nav, onFocus, onClose, children }: PaneProps) {
  const ref = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const Body = half === "main" ? "main" : "div";
  return (
    <section
      ref={ref}
      className="pane"
      aria-label={split ? (half === "main" ? "Left pane" : "Right pane") : undefined}
      data-half={half}
      data-focused={split && focused ? true : undefined}
      data-narrow={narrow || undefined}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      {/* Always the first child, so the page below keeps its place (and its
          editor) when the split opens and closes. */}
      {split && (
        <header className="pane-bar">
          <Icon name={icon} />
          <span className="pane-title">{title}</span>
          <button className="tool" aria-label="Close this pane" title="Close this pane" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
      )}
      <Body className="main">
        <NavContext.Provider value={nav}>{children}</NavContext.Provider>
      </Body>
    </section>
  );
}

/** In a page's top bar: split the window, or go back to one pane. Hidden where there's no split to make (pop-outs). */
export function SplitButton() {
  const { split } = useContext(NavContext);
  if (!split) return null;
  const mod = navigator.platform.includes("Mac") ? "⌘⇧\\" : "Ctrl+Shift+\\";
  const label = split.open ? "Close the split" : "Split the window";
  return (
    <button className="tool" aria-label={label} title={`${label} (${mod})`} aria-pressed={split.open} onClick={split.toggle}>
      <Icon name="split" />
    </button>
  );
}

/** A page's current title, for a pane's title bar. */
export function PageTitle({ session, id, onError }: { session: WorkspaceSession; id: string; onError: (err: unknown) => void }) {
  const tree = useTree(session, onError);
  return <>{tree.byId.get(id)?.title || "Untitled"}</>;
}
