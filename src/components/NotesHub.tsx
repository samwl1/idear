import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type React from "react";
import { api, type HubRow } from "../lib/api";
import type { WorkspaceSession } from "../lib/session";
import { NavContext } from "../lib/nav";
import { useDebounced } from "../lib/useDebounced";
import { ItemLinks } from "./Links";
import { Icon } from "./Icon";
import { useCanEdit } from "../lib/access";
import { PinButton } from "./PinnedNav";
import { isPinned, usePins } from "../lib/pins";

type ColId = "title" | "summary" | "links" | "tags" | "folder" | "updated" | "created" | "words";

interface ColDef {
  id: ColId;
  label: string;
  width: number;
  min: number;
  /** The note column can't be hidden. */
  locked?: boolean;
  sort: (r: HubRow) => string | number;
}

const COLUMNS: ColDef[] = [
  { id: "title", label: "Note", width: 260, min: 140, locked: true, sort: (r) => r.title.toLowerCase() },
  { id: "summary", label: "Summary", width: 320, min: 160, sort: (r) => r.summary.toLowerCase() || "￿" },
  { id: "links", label: "Linked to", width: 300, min: 160, sort: (r) => -(r.links.outgoing.length + r.links.incoming.length) },
  { id: "tags", label: "Tags", width: 170, min: 90, sort: (r) => r.tags.join(" ") || "￿" },
  { id: "folder", label: "Parent", width: 150, min: 90, sort: (r) => (r.folder ?? "").toLowerCase() },
  { id: "updated", label: "Updated", width: 130, min: 100, sort: (r) => -r.updatedAt },
  { id: "created", label: "Created", width: 130, min: 100, sort: (r) => -r.createdAt },
  { id: "words", label: "Words", width: 90, min: 70, sort: (r) => -r.words },
];
const BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));

interface Layout {
  order: ColId[];
  hidden: ColId[];
  widths: Partial<Record<ColId, number>>;
}

const DEFAULT_LAYOUT: Layout = {
  order: COLUMNS.map((c) => c.id),
  hidden: ["created", "words"],
  widths: {},
};

/** Saved per workspace on this device. Unknown or missing columns are repaired. */
function loadLayout(workspaceId: string): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(`hub:${workspaceId}`) ?? "null") as Layout | null;
    if (!saved) return DEFAULT_LAYOUT;
    const order = saved.order.filter((id) => BY_ID.has(id));
    for (const c of COLUMNS) if (!order.includes(c.id)) order.push(c.id);
    return { order, hidden: saved.hidden.filter((id) => BY_ID.has(id) && !BY_ID.get(id)!.locked), widths: saved.widths ?? {} };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

const DRAG_THRESHOLD = 5;
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

interface Props {
  session: WorkspaceSession;
  onError: (err: unknown) => void;
}

export function NotesHub({ session, onError }: Props) {
  const { openItem } = useContext(NavContext);
  const canEdit = useCanEdit();
  const pins = usePins(session.id);
  const [rows, setRows] = useState<HubRow[] | null>(null);
  const [layout, setLayout] = useState<Layout>(() => loadLayout(session.id));
  const [sort, setSort] = useState<{ col: ColId; dir: 1 | -1 }>({ col: "updated", dir: 1 });
  const [filter, setFilter] = useState("");
  const [colDrag, setColDrag] = useState<{ id: ColId; before: ColId | null } | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => api.notesHub(session.id).then((r) => live && setRows(r), onError);
    refresh();
    const unsubscribe = session.subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [session, onError]);

  useEffect(() => {
    try {
      localStorage.setItem(`hub:${session.id}`, JSON.stringify(layout));
    } catch {
      // storage unavailable: the layout lasts for this session only
    }
  }, [session.id, layout]);

  const visible = layout.order.filter((id) => !layout.hidden.includes(id)).map((id) => BY_ID.get(id)!);
  const width = (c: ColDef) => layout.widths[c.id] ?? c.width;

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = filter.trim().toLowerCase();
    const matches = (r: HubRow) =>
      !q ||
      r.title.toLowerCase().includes(q) ||
      r.summary.toLowerCase().includes(q) ||
      (r.folder ?? "").toLowerCase().includes(q) ||
      r.tags.some((t) => t.includes(q)) ||
      [...r.links.outgoing, ...r.links.incoming].some((l) => l.title.toLowerCase().includes(q));
    const key = BY_ID.get(sort.col)!.sort;
    return rows.filter(matches).sort((a, b) => {
      const va = key(a);
      const vb = key(b);
      return (va < vb ? -1 : va > vb ? 1 : a.title.localeCompare(b.title)) * sort.dir;
    });
  }, [rows, filter, sort]);

  // ---- header interactions --------------------------------------------------------

  const headRef = useRef<HTMLTableRowElement>(null);

  /** Press on a header: a short click sorts, a drag reorders. */
  const onHeaderDown = (e: React.PointerEvent, col: ColId) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let before: ColId | null = null;

    const targetAt = (x: number): ColId | null => {
      for (const th of headRef.current?.querySelectorAll<HTMLElement>("th[data-col]") ?? []) {
        const r = th.getBoundingClientRect();
        if (x < r.left + r.width / 2) return th.dataset.col as ColId;
      }
      return null;
    };

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
      }
      before = targetAt(ev.clientX);
      setColDrag({ id: col, before });
    };

    const finish = (apply: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", esc);
      setColDrag(null);
      if (!apply) return;
      if (!dragging) {
        setSort((s) => ({ col, dir: s.col === col ? (-s.dir as 1 | -1) : 1 }));
        return;
      }
      if (before === col) return;
      setLayout((l) => {
        const order = l.order.filter((id) => id !== col);
        const i = before ? order.indexOf(before) : order.length;
        order.splice(i < 0 ? order.length : i, 0, col);
        return { ...l, order };
      });
    };
    const up = () => finish(true);
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", esc);
  };

  /** Drag a header's right edge to resize the column. */
  const onResizeDown = (e: React.PointerEvent, c: ColDef) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(c);
    const move = (ev: PointerEvent) => {
      const w = Math.max(c.min, Math.round(startW + ev.clientX - startX));
      setLayout((l) => ({ ...l, widths: { ...l.widths, [c.id]: w } }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const newNote = async () => {
    try {
      openItem(await session.createItem("note", null));
    } catch (e) {
      onError(e);
    }
  };

  // ---- cells ----------------------------------------------------------------------

  const cell = (c: ColDef, r: HubRow): ReactNode => {
    switch (c.id) {
      case "title":
        return (
          <button className="hub-title" onClick={() => openItem(r.id)}>
            <Icon name="note" />
            <span>{r.title || "Untitled"}</span>
          </button>
        );
      case "summary":
        return <SummaryCell session={session} id={r.id} value={r.summary} onError={onError} />;
      case "links":
        return <ItemLinks session={session} itemId={r.id} links={r.links} compact onError={onError} />;
      case "tags":
        return r.tags.length ? (
          <span className="hub-tags">
            {r.tags.map((t) => (
              <span className="tag" key={t}>
                {t}
              </span>
            ))}
          </span>
        ) : (
          <span className="muted">None</span>
        );
      case "folder":
        return r.folder ? r.folder : <span className="muted">Top level</span>;
      case "updated":
        return dateFmt.format(r.updatedAt);
      case "created":
        return dateFmt.format(r.createdAt);
      case "words":
        return r.words.toLocaleString();
    }
  };

  return (
    <section className="hub">
      <header className="hub-head">
        <div>
          <h1>
            <Icon name="note" /> Notes Hub
          </h1>
          <p className="muted">
            Every note in this workspace. Drag a column header to move it, drag its edge to resize, click to sort.
          </p>
        </div>
        <PinButton workspace={session.id} pin={{ kind: "hub" }} pinned={isPinned(pins, { kind: "hub" })} />
        {canEdit && (
          <button className="primary" onClick={newNote}>
            <Icon name="plus" /> New note
          </button>
        )}
      </header>

      <div className="hub-bar">
        <input
          className="field hub-filter"
          placeholder="Filter by title, summary, tag, parent, or link"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ColumnsMenu layout={layout} onChange={setLayout} />
        {rows && (
          <span className="muted small">
            {shown.length === rows.length
              ? `${rows.length} ${rows.length === 1 ? "note" : "notes"}`
              : `${shown.length} of ${rows.length} notes`}
          </span>
        )}
      </div>

      {rows === null ? null : rows.length === 0 ? (
        <p className="muted">No notes yet. Create one with New note.</p>
      ) : (
        <div className="hub-scroll">
          <table className="hub-table" data-dragging={colDrag ? true : undefined}>
            <colgroup>
              {visible.map((c) => (
                <col key={c.id} style={{ width: width(c) }} />
              ))}
            </colgroup>
            <thead>
              <tr ref={headRef}>
                {visible.map((c, i) => {
                  const dropBefore = colDrag && colDrag.id !== c.id && colDrag.before === c.id;
                  const dropAfter = colDrag && colDrag.before === null && i === visible.length - 1;
                  return (
                    <th
                      key={c.id}
                      data-col={c.id}
                      scope="col"
                      aria-sort={sort.col === c.id ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                      data-moving={colDrag?.id === c.id || undefined}
                      data-drop-before={dropBefore || undefined}
                      data-drop-after={dropAfter || undefined}
                    >
                      <button
                        className="hub-th"
                        onPointerDown={(e) => onHeaderDown(e, c.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSort((s) => ({ col: c.id, dir: s.col === c.id ? (-s.dir as 1 | -1) : 1 }));
                          }
                        }}
                      >
                        {c.label}
                        {sort.col === c.id && <span aria-hidden="true">{sort.dir === 1 ? " ▲" : " ▼"}</span>}
                      </button>
                      <span
                        className="hub-resize"
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${c.label}`}
                        onPointerDown={(e) => onResizeDown(e, c)}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  {visible.map((c) => (
                    <td key={c.id} data-col={c.id}>
                      {cell(c, r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="muted hub-none">No notes match.</p>}
        </div>
      )}
    </section>
  );
}

/** Editable summary. Keeps what's being typed even as the hub refreshes. */
function SummaryCell({
  session,
  id,
  value,
  onError,
}: {
  session: WorkspaceSession;
  id: string;
  value: string;
  onError: (err: unknown) => void;
}) {
  const [text, setText] = useState(value);
  const canEdit = useCanEdit();
  const focused = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const save = useDebounced((t: string) => session.setSummary(id, t).catch(onError), 500);

  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  // Grow to fit the text.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  return (
    <textarea
      ref={ref}
      className="hub-summary"
      rows={1}
      value={text}
      readOnly={!canEdit}
      placeholder={canEdit ? "Write a summary" : ""}
      aria-label="Summary"
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
      onChange={(e) => {
        setText(e.target.value);
        save(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

function ColumnsMenu({ layout, onChange }: { layout: Layout; onChange: (l: Layout) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="picker" ref={root}>
      <button className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="view" /> Columns
      </button>
      {open && (
        <div className="menu hub-cols" role="group" aria-label="Columns">
          {layout.order.map((id) => {
            const c = BY_ID.get(id)!;
            return (
              <label key={id} className="check">
                <input
                  type="checkbox"
                  checked={!layout.hidden.includes(id)}
                  disabled={c.locked}
                  onChange={(e) =>
                    onChange({
                      ...layout,
                      hidden: e.target.checked ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id],
                    })
                  }
                />
                <span>{c.label}</span>
              </label>
            );
          })}
          <div className="switcher-sep" />
          <button className="menu-item" onClick={() => onChange(DEFAULT_LAYOUT)}>
            Reset layout
          </button>
        </div>
      )}
    </div>
  );
}
