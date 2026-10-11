import { useEffect, useRef, useState } from "react";
import { api, type Category, type EntityKind, type ViewQuery, type ViewRow, type ViewSort } from "../lib/api";
import { DEFAULT_QUERY, type WorkspaceSession } from "../lib/session";
import { expandMe, useAccount } from "../lib/account";
import { useDebounced } from "../lib/useDebounced";
import { Icon, VIEW_ICONS, iconName, type IconName } from "./Icon";
import { useCanEdit } from "../lib/access";
import { PinButton } from "./PinnedNav";
import { isPinned, usePins } from "../lib/pins";

const TYPE_OPTIONS: { kind: EntityKind; label: string }[] = [
  { kind: "note", label: "Notes" },
  { kind: "whiteboard", label: "Whiteboards" },
  { kind: "tracker", label: "Projects" },
  { kind: "task", label: "Tasks" },
  { kind: "folder", label: "Folders" },
];

const STATUS_OPTIONS: { value: Category; label: string }[] = [
  { value: "todo", label: "To do" },
  { value: "doing", label: "In progress" },
  { value: "done", label: "Done" },
];

const KIND_ICON: Record<EntityKind, IconName> = {
  note: "note",
  whiteboard: "whiteboard",
  tracker: "project",
  folder: "folder",
  task: "check",
  phase: "flag",
};

const KIND_LABEL: Record<EntityKind, string> = {
  note: "Note",
  whiteboard: "Whiteboard",
  tracker: "Project",
  folder: "Folder",
  task: "Task",
  phase: "Phase",
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function ago(ts: number): string {
  const s = (ts - Date.now()) / 1000;
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.35, "week"],
    [12, "month"],
    [Infinity, "year"],
  ];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return "";
}

/** Copy out of the Automerge proxy into a plain object. */
function plainQuery(q: ViewQuery | undefined): ViewQuery {
  if (!q) return { ...DEFAULT_QUERY };
  return {
    types: [...(q.types ?? [])],
    tags: [...(q.tags ?? [])],
    text: String(q.text ?? ""),
    updatedWithinDays: q.updatedWithinDays ?? null,
    sort: (q.sort as ViewSort) ?? "updated",
    statuses: [...(q.statuses ?? [])],
    assignee: String(q.assignee ?? ""),
    keys: [...(q.keys ?? [])],
  };
}

interface Props {
  session: WorkspaceSession;
  viewId: string;
  /** Open an item, or a task inside its project. */
  onOpen: (id: string, task?: string) => void;
  onDeleted: () => void;
  onError: (err: unknown) => void;
}

export function ViewPage({ session, viewId, onOpen, onDeleted, onError }: Props) {
  const def = session.view(viewId);
  const [name, setName] = useState(def?.name ?? "");
  const [query, setQuery] = useState<ViewQuery>(() => plainQuery(def?.query));
  const [draftTag, setDraftTag] = useState("");
  const [keysText, setKeysText] = useState(() => plainQuery(def?.query).keys.join(", "));
  const [rows, setRows] = useState<ViewRow[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [isFresh] = useState(() => (def?.name ?? "") === "Untitled view");
  // New views open with filters showing; saved views open collapsed to their results.
  const [filtersOpen, setFiltersOpen] = useState(isFresh);
  const [icon, setIcon] = useState<IconName>(iconName(def?.icon));

  const saveName = useDebounced((n: string) => {
    session.renameView(viewId, n).catch(onError);
  }, 400);
  const saveQuery = useDebounced((q: ViewQuery) => {
    session.setViewQuery(viewId, q).catch(onError);
  }, 500);

  const canEdit = useCanEdit();
  const pins = usePins(session.id);
  // Where you can only view, filters still work but aren't saved.
  const update = (patch: Partial<ViewQuery>) => {
    const next = { ...query, ...patch };
    setQuery(next);
    if (canEdit) saveQuery(next);
  };

  const myName = useAccount().account?.name ?? "";

  // Results follow the local query immediately and refresh on any workspace change.
  useEffect(() => {
    let live = true;
    const q = { ...query, assignee: expandMe(query.assignee, myName) };
    const refresh = () => api.runView(session.id, q).then((r) => live && setRows(r), onError);
    refresh();
    const unsubscribe = session.subscribe(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [session, query, myName, onError]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const showsTasks = query.types.includes("task");
  const toggleStatus = (c: Category) =>
    update({ statuses: query.statuses.includes(c) ? query.statuses.filter((x) => x !== c) : [...query.statuses, c] });

  const toggleType = (k: EntityKind) =>
    update({ types: query.types.includes(k) ? query.types.filter((t) => t !== k) : [...query.types, k] });

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    setDraftTag("");
    if (tag && !query.tags.includes(tag)) update({ tags: [...query.tags, tag] });
  };

  return (
    <section className="view">
      <header className="view-head">
        {canEdit ? <IconPicker
          value={icon}
          onChange={(next) => {
            setIcon(next);
            session.setViewIcon(viewId, next).catch(onError);
          }}
        /> : <Icon name={icon} />}
        <input
          className="view-title"
          value={name}
          placeholder="Untitled view"
          aria-label="View name"
          readOnly={!canEdit}
          autoFocus={canEdit && isFresh}
          onFocus={(e) => isFresh && e.currentTarget.select()}
          onChange={(e) => {
            setName(e.target.value);
            saveName(e.target.value);
          }}
        />
        <PinButton workspace={session.id} pin={{ kind: "view", id: viewId }} pinned={isPinned(pins, { kind: "view", id: viewId })} />
        {!canEdit ? null : confirming ? (
          <button
            className="danger-btn"
            onClick={() => session.deleteView(viewId).then(onDeleted, onError)}
          >
            Delete view
          </button>
        ) : (
          <button className="ghost" onClick={() => setConfirming(true)}>
            <Icon name="trash" /> Delete
          </button>
        )}
      </header>

      <div className="filters-bar">
        <button
          className="ghost"
          aria-expanded={filtersOpen}
          aria-controls="view-filters"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <Icon name="chevron" className={filtersOpen ? "chev open" : "chev"} /> Filters
        </button>
        {!filtersOpen && <span className="filters-summary">{summarize(query)}</span>}
      </div>

      <div className="filters" id="view-filters" role="group" aria-label="Filters" hidden={!filtersOpen}>
        <div className="filter">
          <span className="filter-label">Show</span>
          <div className="segmented">
            {TYPE_OPTIONS.map((o) => (
              <button
                key={o.kind}
                aria-pressed={query.types.includes(o.kind)}
                onClick={() => toggleType(o.kind)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {query.types.length === 0 && <span className="filter-note">All items</span>}
        </div>

        <div className="filter">
          <span className="filter-label">Tagged</span>
          <div className="tags inline">
            {query.tags.map((t) => (
              <span className="tag" key={t}>
                {t}
                <button
                  aria-label={`Remove tag filter ${t}`}
                  onClick={() => update({ tags: query.tags.filter((x) => x !== t) })}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              className="tag-input"
              value={draftTag}
              placeholder={query.tags.length ? "Or another tag" : "Any tag. Use * to match the rest, like sec*"}
              aria-label="Add tag filter"
              onChange={(e) => setDraftTag(e.target.value)}
              onBlur={() => addTag(draftTag)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag(draftTag);
                }
              }}
            />
          </div>
        </div>

        <div className="filter">
          <span className="filter-label">Contains</span>
          <input
            className="field"
            value={query.text}
            placeholder="Words in the title or text"
            aria-label="Text filter"
            onChange={(e) => update({ text: e.target.value })}
          />
        </div>

        {showsTasks && (
          <div className="filter-row">
            <div className="filter">
              <span className="filter-label">Status</span>
              <div className="segmented">
                {STATUS_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    aria-pressed={query.statuses.includes(o.value)}
                    onClick={() => toggleStatus(o.value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="filter">
              <span className="filter-label">Assignee</span>
              <input
                className="field"
                value={query.assignee}
                placeholder="Anyone. @me for you, * to match the rest"
                onChange={(e) => update({ assignee: e.target.value })}
              />
            </label>
            <label className="filter">
              <span className="filter-label">Keys</span>
              <input
                className="field"
                value={keysText}
                placeholder="Any key. BUG, SYNC* or a list: BUG, IDR"
                onChange={(e) => setKeysText(e.target.value)}
                onBlur={() => update({ keys: splitKeys(keysText) })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
          </div>
        )}

        <div className="filter-row">
          <label className="filter">
            <span className="filter-label">Updated</span>
            <select
              className="field"
              value={query.updatedWithinDays ?? 0}
              onChange={(e) => update({ updatedWithinDays: Number(e.target.value) || null })}
            >
              <option value={0}>Any time</option>
              <option value={1}>Past day</option>
              <option value={7}>Past week</option>
              <option value={30}>Past month</option>
            </select>
          </label>
          <label className="filter">
            <span className="filter-label">Sort by</span>
            <select
              className="field"
              value={query.sort}
              onChange={(e) => update({ sort: e.target.value as ViewSort })}
            >
              <option value="updated">Last updated</option>
              <option value="created">Recently created</option>
              <option value="title">Title</option>
            </select>
          </label>
        </div>
      </div>

      {rows === null ? null : rows.length === 0 ? (
        <p className="muted">Nothing matches these filters.</p>
      ) : (
        <>
          <p className="count muted">
            {rows.length} {rows.length === 1 ? "item" : "items"}
          </p>
          <ul className="results">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  className="result"
                  disabled={r.kind === "folder"}
                  onClick={() => (r.kind === "task" && r.tracker ? onOpen(r.tracker, r.id) : onOpen(r.id))}
                >
                  <Icon name={KIND_ICON[r.kind]} className="kind" />
                  <span className="result-main">
                    <span className="result-title">
                      {r.key && <span className="task-key">{r.key}</span>}
                      {r.title || "Untitled"}
                    </span>
                    <span className="result-meta">
                      {r.kind === "task"
                        ? `Task in ${r.trackerTitle || "a project"}${r.status ? `, ${r.status}` : ""}`
                        : `${KIND_LABEL[r.kind]}${r.parentTitle ? ` in ${r.parentTitle}` : ""}`}
                      , updated {ago(r.updatedAt)}
                    </span>
                  </span>
                  {r.tags.length > 0 && (
                    <span className="result-tags">
                      {r.tags.map((t) => (
                        <span className="tag" key={t}>
                          {t}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const SORT_LABEL: Record<ViewSort, string> = {
  updated: "last updated",
  created: "recently created",
  title: "title",
};

/** One line describing the filters, shown when the panel is collapsed. */
function summarize(q: ViewQuery): string {
  const types = q.types.length
    ? q.types.map((t) => TYPE_OPTIONS.find((o) => o.kind === t)?.label ?? t).join(" and ")
    : "All items";
  const parts = [types];
  if (q.tags.length) parts.push(`tagged ${q.tags.join(" or ")}`);
  if (q.text.trim()) parts.push(`containing "${q.text.trim()}"`);
  if (q.types.includes("task") && q.statuses.length) {
    parts.push(q.statuses.map((c) => STATUS_OPTIONS.find((o) => o.value === c)?.label).join(" or "));
  }
  if (q.types.includes("task") && q.assignee.trim()) parts.push(`assigned to ${q.assignee.trim()}`);
  if (q.types.includes("task") && q.keys.length) parts.push(`keyed ${q.keys.join(" or ")}`);
  if (q.updatedWithinDays) {
    parts.push(
      q.updatedWithinDays === 1 ? "updated today" : `updated in the past ${q.updatedWithinDays === 7 ? "week" : "month"}`,
    );
  }
  parts.push(`sorted by ${SORT_LABEL[q.sort]}`);
  return parts.join(", ");
}

function IconPicker({ value, onChange }: { value: IconName; onChange: (icon: IconName) => void }) {
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
    <div className="icon-picker" ref={root}>
      <button
        className="icon-current"
        aria-label="Change view icon"
        aria-expanded={open}
        title="Change icon"
        onClick={() => setOpen(!open)}
      >
        <Icon name={value} />
      </button>
      {open && (
        <div className="icon-grid" role="listbox" aria-label="View icons">
          {VIEW_ICONS.map((name) => (
            <button
              key={name}
              role="option"
              aria-selected={name === value}
              aria-label={name}
              onClick={() => {
                setOpen(false);
                onChange(name);
              }}
            >
              <Icon name={name} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "bug, sync*" → ["BUG", "SYNC*"]. */
function splitKeys(text: string): string[] {
  return [...new Set(text.split(/[,\s]+/).map((k) => k.trim().toUpperCase()).filter(Boolean))];
}
