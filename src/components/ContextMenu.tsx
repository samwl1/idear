// A right-click menu: opens at the pointer, closes on a click elsewhere,
// Escape, or scrolling. One per page is enough; it holds whatever items the
// thing under the pointer offers.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A thin rule above this item. */
  separator?: boolean;
}

interface State {
  x: number;
  y: number;
  items: MenuItem[];
}

export function useContextMenu() {
  const [state, setState] = useState<State | null>(null);
  const open = (e: ReactMouseEvent | MouseEvent, items: MenuItem[]) => {
    if (!items.length) return;
    e.preventDefault();
    e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  };
  const close = () => setState(null);
  const menu = state ? <ContextMenu {...state} onClose={close} /> : null;
  return { menu, open, close, isOpen: !!state };
}

function ContextMenu({ x, y, items, onClose }: State & { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top = Math.min(y, window.innerHeight - r.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("contextmenu", outside);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("contextmenu", outside);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  return (
    <div ref={ref} className="menu context-menu" role="menu" style={{ left: pos.left, top: pos.top }}>
      {items.map((item, i) => (
        <div key={i}>
          {item.separator && i > 0 && <div className="switcher-sep" />}
          <button
            role="menuitem"
            className={`menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
