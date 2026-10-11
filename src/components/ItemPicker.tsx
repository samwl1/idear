import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useCanEdit } from "../lib/access";

interface Props {
  items: [string, { title: string; detail?: string }][];
  label?: string;
  /** Shorter button: just a plus, with the label as its tooltip. */
  compact?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onPick: (id: string) => void;
  /** Offer a "create" row at the top, e.g. a new note named after what's typed. */
  onCreate?: { label: (typed: string) => string; run: (typed: string) => void };
}

/** Matches `.picker-menu` width in styles.css (18rem). */
const MENU_WIDTH = 288;

/** A button that opens a searchable list of workspace items. */
/** Pickers add links or cards, so they're hidden where you can only view. */
export function ItemPicker(props: Props) {
  return useCanEdit() ? <Picker {...props} /> : null;
}

function Picker({
  items,
  label = "Link an item",
  compact,
  disabled,
  placeholder = "Find a note, whiteboard, or project",
  onPick,
  onCreate,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [alignLeft, setAlignLeft] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // The menu hangs left from the button by default. When that would run past
  // the edge of whatever scrolls around it, hang it right instead.
  const toggle = () => {
    if (!open && root.current) {
      const r = root.current.getBoundingClientRect();
      let edge = 0;
      for (let el = root.current.parentElement; el; el = el.parentElement) {
        const o = getComputedStyle(el).overflowX;
        if (o === "auto" || o === "hidden" || o === "scroll") {
          edge = el.getBoundingClientRect().left;
          break;
        }
      }
      setAlignLeft(r.right - MENU_WIDTH < edge + 8);
    }
    setOpen(!open);
  };

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const q = filter.trim().toLowerCase();
  const shown = items.filter(
    ([, it]) => it.title.toLowerCase().includes(q) || (it.detail ?? "").toLowerCase().includes(q),
  );
  const done = () => {
    setOpen(false);
    setFilter("");
  };

  return (
    <div className="picker" ref={root}>
      <button
        className={compact ? "tool" : "ghost"}
        disabled={disabled}
        onClick={toggle}
        aria-expanded={open}
        aria-label={label}
        title={compact ? label : undefined}
      >
        <Icon name="plus" />
        {!compact && ` ${label}`}
      </button>
      {open && (
        <div className="picker-menu" data-align={alignLeft ? "left" : undefined}>
          <input
            className="field"
            autoFocus
            placeholder={placeholder}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          />
          <ul>
            {onCreate && (
              <li>
                <button
                  className="switcher-item picker-create"
                  onClick={() => {
                    const typed = filter.trim();
                    done();
                    onCreate.run(typed);
                  }}
                >
                  <span>{onCreate.label(filter.trim())}</span>
                  <Icon name="plus" />
                </button>
              </li>
            )}
            {shown.length === 0 && !onCreate && <li className="muted picker-empty">Nothing to link.</li>}
            {shown.map(([itemId, it]) => (
              <li key={itemId}>
                <button
                  className="switcher-item picker-row"
                  onClick={() => {
                    done();
                    onPick(itemId);
                  }}
                >
                  <span className="picker-title">{it.title || "Untitled"}</span>
                  {it.detail && <span className="picker-detail">{it.detail}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
