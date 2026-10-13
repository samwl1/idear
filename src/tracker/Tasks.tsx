// The Tasks tab: every task in a sortable table, filtered, scoped to On
// board / Backlog / Archived / All by pills, with multi-select for mass changes.
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BACKLOG, PRIORITIES, type Priority, type Task, type TrackerOps, type TrackerView } from "./model";
import { archiveWithUndo, ChecklistCount, ConfirmDelete, DeleteTaskButton, deleteManyWithUndo, DueDate, TaskDot, taskMenuItems, unarchiveWithUndo } from "./bits";
import { useCanEdit } from "../lib/access";
import { isPinned, usePins } from "../lib/pins";
import { PinButton } from "../components/PinnedNav";
import { BranchButton } from "../components/GitButton";
import { Icon } from "../components/Icon";
import { useContextMenu, type MenuItem } from "../components/ContextMenu";
import { useAccount } from "../lib/account";

interface Props {
  /** Workspace id, for pins. */
  workspace: string;
  view: TrackerView;
  ops: TrackerOps;
  /** The task open in the panel, highlighted. */
  openTask?: string | null;
  onOpenTask: (id: string) => void;
  onError: (err: unknown) => void;
}

type SortKey = "key" | "title" | "status" | "priority" | "assignee" | "phase" | "due";
/** Which tasks the list shows. */
type Scope = "board" | "backlog" | "archived" | "all";

const SCOPES: { id: Scope; label: string; hint: string; color: string }[] = [
  { id: "board", label: "On board", hint: "In a column, done or not", color: "blue" },
  { id: "backlog", label: "Backlog", hint: "Waiting, off the board", color: "grey" },
  { id: "archived", label: "Archived", hint: "Put away: done and off the board", color: "green" },
  { id: "all", label: "All", hint: "Every task", color: "" },
];

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

/** What the tab remembers per project on this device. */
interface Prefs {
  sort: { key: SortKey; dir: 1 | -1 };
  q: string;
  /** "" any, "none" no phase, or a phase id. */
  phase: string;
  /** "" any, BACKLOG, or a column id. */
  status: string;
  priority: "" | Priority;
  /** "" any, "none" unassigned, or a name. */
  assignee: string;
  tag: string;
  scope: Scope;
}

const DEFAULT_PREFS: Prefs = {
  sort: { key: "key", dir: 1 },
  q: "",
  phase: "",
  status: "",
  priority: "",
  assignee: "",
  tag: "",
  scope: "board",
};

function loadPrefs(projectId: string): Prefs {
  try {
    const raw = localStorage.getItem(`tasks:${projectId}`);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function Tasks({ workspace, view, ops, openTask, onOpenTask, onError }: Props) {
  const pins = usePins(workspace);
  const canEdit = useCanEdit();
  const me = useAccount().account?.name ?? "";
  const ctx = useContextMenu();
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs(ops.id));
  const set = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Where a shift-click range starts. */
  const anchor = useRef<string | null>(null);
  const run = (p: Promise<unknown>) => p.catch(onError);

  useEffect(() => {
    try {
      localStorage.setItem(`tasks:${ops.id}`, JSON.stringify(prefs));
    } catch {
      // storage unavailable: the tab just won't be remembered
    }
  }, [ops.id, prefs]);

  // Drop selections of tasks that no longer exist.
  useEffect(() => {
    if (![...selected].some((id) => !view.tasks.has(id))) return;
    setSelected((s) => new Set([...s].filter((id) => view.tasks.has(id))));
  }, [view, selected]);

  const phaseName = (t: Task) => view.phases.find((p) => p.id === t.phase)?.name ?? "";
  const colIndex = (t: Task) => {
    const i = view.columns.findIndex((c) => c.id === t.column);
    return i < 0 ? 0 : i;
  };
  const scopeOf = (id: string): Exclude<Scope, "all"> => (view.archived(id) ? "archived" : view.inBacklog(id) ? "backlog" : "board");

  // Values the filter selects offer.
  const assignees = useMemo(() => [...new Set([...view.tasks.values()].map((t) => t.assignee).filter(Boolean))].sort(), [view]);
  const tags = useMemo(() => [...new Set([...view.tasks.values()].flatMap((t) => t.tags))].sort(), [view]);

  // Everything the filters allow, before the scope pills split it; the pills show these counts.
  const filtered = useMemo(() => {
    const q = prefs.q.trim().toLowerCase();
    return view.sortedByNumber().filter((id) => {
      const t = view.tasks.get(id)!;
      if (prefs.phase === "none" ? t.phase && view.phases.some((p) => p.id === t.phase) : prefs.phase && t.phase !== prefs.phase) return false;
      if (prefs.status && view.taskColumn(id) !== prefs.status) return false;
      if (prefs.priority && t.priority !== prefs.priority) return false;
      if (prefs.assignee === "none" ? t.assignee : prefs.assignee && t.assignee !== prefs.assignee) return false;
      if (prefs.tag && !t.tags.includes(prefs.tag)) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        view.key(id).toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        t.assignee.toLowerCase().includes(q)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, prefs.q, prefs.phase, prefs.status, prefs.priority, prefs.assignee, prefs.tag]);

  const counts = useMemo(() => {
    const c: Record<Scope, number> = { board: 0, backlog: 0, archived: 0, all: filtered.length };
    for (const id of filtered) c[scopeOf(id)]++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, view]);

  const rows = useMemo(() => {
    const ids = filtered.filter((id) => prefs.scope === "all" || scopeOf(id) === prefs.scope);
    const value = (id: string): string | number => {
      const t = view.tasks.get(id)!;
      switch (prefs.sort.key) {
        case "key":
          return `${view.prefixOf(id)}-${String(t.number).padStart(9, "0")}`;
        case "title":
          return t.title.toLowerCase();
        case "status":
          return view.archived(id) ? view.columns.length + 1 : view.inBacklog(id) ? -1 : colIndex(t);
        case "priority":
          return PRIORITY_RANK[t.priority] ?? 4;
        case "assignee":
          return t.assignee.toLowerCase() || "￿";
        case "phase": {
          const i = view.phases.findIndex((p) => p.id === t.phase);
          return i < 0 ? Infinity : i;
        }
        case "due":
          return t.due || "￿";
      }
    };
    return ids.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (va < vb ? -1 : va > vb ? 1 : view.tasks.get(a)!.number - view.tasks.get(b)!.number) * prefs.sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, view, prefs.scope, prefs.sort]);

  const filtering = !!(prefs.q.trim() || prefs.phase || prefs.status || prefs.priority || prefs.assignee || prefs.tag);

  // ---- selection ------------------------------------------------------------

  const visible = rows;
  const toggle = (id: string, e?: ReactMouseEvent) => {
    setSelected((s) => {
      const next = new Set(s);
      if (e?.shiftKey && anchor.current && visible.includes(anchor.current)) {
        const a = visible.indexOf(anchor.current);
        const b = visible.indexOf(id);
        for (const x of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!e?.shiftKey) anchor.current = id;
  };
  const selectAll = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  const clear = () => {
    setSelected(new Set());
    anchor.current = null;
  };
  const picked = [...selected].filter((id) => view.tasks.has(id));

  useEffect(() => {
    if (!picked.length) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement)?.closest("input, select, textarea")) clear();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [picked.length]);

  // A row's right-click menu: the row alone, or the whole selection when it's part of one.
  const rowMenu = (id: string): MenuItem[] => {
    if (!(selected.has(id) && picked.length > 1)) {
      const items = taskMenuItems(ops, view, id, canEdit, onOpenTask, onError);
      if (canEdit && rows.length > 1) items.splice(1, 0, { label: "Select all shown", onSelect: () => selectAll(rows, true) });
      return items;
    }
    const n = picked.length;
    const items: MenuItem[] = [];
    if (canEdit) {
      items.push({ label: `Archive ${n} tasks`, onSelect: () => void archiveWithUndo(ops, view, picked, onError).then(clear) });
      if (picked.some((x) => view.archived(x))) items.push({ label: "Restore archived", onSelect: () => void unarchiveWithUndo(ops, view, picked, onError).then(clear) });
      items.push({ label: `Delete ${n} tasks`, onSelect: () => void deleteManyWithUndo(ops, picked, onError).then(clear), danger: true, separator: true });
    }
    items.push({ label: "Clear selection", onSelect: clear, separator: items.length > 0 });
    return items;
  };

  // ---- render ---------------------------------------------------------------

  const header = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={prefs.sort.key === key ? (prefs.sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button
        className="th-sort"
        onClick={() => set({ sort: { key, dir: prefs.sort.key === key ? ((-prefs.sort.dir) as 1 | -1) : 1 } })}
      >
        {label}
        {prefs.sort.key === key && <span aria-hidden="true">{prefs.sort.dir === 1 ? " ▲" : " ▼"}</span>}
      </button>
    </th>
  );

  const row = (id: string) => {
    const t = view.tasks.get(id)!;
    const colId = view.taskColumn(id);
    const archived = view.archived(id);
    const isSel = selected.has(id);
    return (
      <tr
        key={id}
        data-open={openTask === id || undefined}
        data-selected={isSel || undefined}
        data-archived={archived || undefined}
        onContextMenu={(e) => ctx.open(e, rowMenu(id))}
        onClick={(e) => {
          // Plain clicks on the row's blank space (not its controls) select it.
          const el = e.target as HTMLElement;
          if (el.closest("button, select, input, a, .cell-select")) return;
          toggle(id, e);
        }}
      >
        {canEdit && (
          <td className="tasks-check">
            <input
              type="checkbox"
              aria-label={`Select ${view.key(id)}`}
              checked={isSel}
              onClick={(e) => {
                e.stopPropagation();
                toggle(id, e);
              }}
              onChange={() => undefined}
            />
          </td>
        )}
        <td className="nowrap task-key">{view.key(id)}</td>
        <td>
          <button className="link-btn" data-done={view.category(id) === "done" || undefined} onClick={() => onOpenTask(id)}>
            {t.title || "Untitled task"}
          </button>{" "}
          <ChecklistCount view={view} id={id} />
        </td>
        <td className="nowrap">
          {archived ? (
            <span className="cell-select">
              <TaskDot view={view} id={id} />
              <span className="archived-pill" title="Archived: done and off the board">
                Archived
              </span>
              {canEdit && (
                <button className="link-btn small tasks-restore" onClick={() => void unarchiveWithUndo(ops, view, [id], onError)}>
                  Restore
                </button>
              )}
            </span>
          ) : (
            <span className="cell-select">
              <TaskDot view={view} id={id} />
              <select aria-label="Status" disabled={!canEdit} value={colId} onChange={(e) => run(ops.move(id, e.target.value, null))}>
                <option value={BACKLOG}>Backlog</option>
                {view.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </span>
          )}
        </td>
        <td className="nowrap">
          <select
            className="cell-plain"
            aria-label="Priority"
            disabled={!canEdit}
            data-empty={t.priority === "none" || undefined}
            value={t.priority}
            onChange={(e) => run(ops.update(id, { priority: e.target.value as Priority }))}
          >
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </td>
        <td>{t.assignee || <span className="muted">Unassigned</span>}</td>
        <td>{phaseName(t) || <span className="muted">None</span>}</td>
        <td className="nowrap">
          <DueDate due={t.due} done={view.category(id) === "done"} />
        </td>
        <td className="backlog-pin">
          <span className="backlog-tools">
            {(t.branches?.length ?? 0) > 0 && (
              <BranchButton repos={view.repos()} branches={t.branches!} onChange={canEdit ? (b) => ops.setBranches(id, b).catch(onError) : undefined} onError={onError} />
            )}
            <PinButton workspace={workspace} pin={{ kind: "task", id, project: ops.id }} pinned={isPinned(pins, { kind: "task", id, project: ops.id })} />
            <DeleteTaskButton ops={ops} view={view} id={id} onError={onError} />
          </span>
        </td>
      </tr>
    );
  };

  return (
    <div className="backlog tasks">
      {picked.length > 0 && canEdit ? (
        <ActionBar view={view} ops={ops} ids={picked} assignees={assignees} me={me} onDone={clear} onError={onError} />
      ) : (
        <div className="backlog-filters tasks-filters">
          <label className="tasks-search">
            <Icon name="search" />
            <input
              className="field"
              type="search"
              placeholder="Search"
              aria-label="Search tasks by title, key, tag, or assignee"
              value={prefs.q}
              onChange={(e) => set({ q: e.target.value })}
            />
          </label>
                      <select className="field backlog-phase" aria-label="Phase" data-active={!!prefs.phase || undefined} value={prefs.phase} onChange={(e) => set({ phase: e.target.value })}>
              <option value="">Any phase</option>
              {view.phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || "Untitled phase"}
                </option>
              ))}
              <option value="none">No phase</option>
            </select>
          <select className="field backlog-phase" aria-label="Status" data-active={!!prefs.status || undefined} value={prefs.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Any status</option>
            <option value={BACKLOG}>Backlog</option>
            {view.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="field backlog-phase" aria-label="Priority" data-active={!!prefs.priority || undefined} value={prefs.priority} onChange={(e) => set({ priority: e.target.value as Prefs["priority"] })}>
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
                      <select className="field backlog-phase" aria-label="Assignee" data-active={!!prefs.assignee || undefined} value={prefs.assignee} onChange={(e) => set({ assignee: e.target.value })}>
              <option value="">Anyone</option>
              {assignees.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
              <option value="none">Unassigned</option>
            </select>
                      <select className="field backlog-phase" aria-label="Tag" data-active={!!prefs.tag || undefined} value={prefs.tag} onChange={(e) => set({ tag: e.target.value })}>
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          {filtering && (
            <button className="link-btn small" onClick={() => set({ q: "", phase: "", status: "", priority: "", assignee: "", tag: "" })}>
              Clear
            </button>
          )}
        </div>
      )}

      <div className="tasks-scopes" role="tablist" aria-label="Which tasks">
        {SCOPES.map((sc) => (
          <button
            key={sc.id}
            type="button"
            role="tab"
            aria-selected={prefs.scope === sc.id}
            className="tasks-scope"
            title={sc.hint}
            onClick={() => {
              set({ scope: sc.id });
              clear();
            }}
          >
            {sc.color && <i className="tasks-scope-dot" style={{ background: `var(--col-${sc.color})` }} aria-hidden="true" />}
            {sc.label}
            <span className="tasks-scope-n">{counts[sc.id]}</span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="muted">
          {view.tasks.size === 0
            ? "No tasks yet. Add one from the board or with New task."
            : filtering || prefs.scope === "all"
              ? "No tasks match."
              : prefs.scope === "archived"
                ? "Nothing archived. Right-click a done task, or use Clear done on a done column."
                : prefs.scope === "backlog"
                  ? "The backlog is empty."
                  : "Nothing on the board."}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="backlog-table tasks-table">
            <thead>
              <tr>
                {canEdit && (
                  <th className="tasks-check" scope="col">
                    <input
                      type="checkbox"
                      aria-label="Select every task shown"
                      checked={rows.length > 0 && rows.every((id) => selected.has(id))}
                      onChange={(e) => selectAll(rows, e.target.checked)}
                    />
                  </th>
                )}
                {header("key", "Key")}
                {header("title", "Title")}
                {header("status", "Status")}
                {header("priority", "Priority")}
                {header("assignee", "Assignee")}
                {header("phase", "Phase")}
                {header("due", "Due")}
                <th className="backlog-pin" aria-label="Tools" />
              </tr>
            </thead>
            <tbody>{rows.map(row)}</tbody>
          </table>
        </div>
      )}
      {ctx.menu}
    </div>
  );
}

/** The bar that replaces the filters while tasks are selected: one change for all of them. */
function ActionBar({
  view,
  ops,
  ids,
  assignees,
  me,
  onDone,
  onError,
}: {
  view: TrackerView;
  ops: TrackerOps;
  ids: string[];
  assignees: string[];
  me: string;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const [tag, setTag] = useState("");
  const run = (p: Promise<unknown>) => p.catch(onError);
  const n = ids.length;
  const anyArchived = ids.some((id) => view.archived(id));
  const allArchived = ids.every((id) => view.archived(id));

  return (
    <div className="backlog-filters tasks-actions" role="toolbar" aria-label={`${n} selected`}>
      <span className="tasks-actions-count">
        {n} selected
      </span>
      <select className="field backlog-phase" aria-label="Move to" value="" onChange={(e) => e.target.value && run(ops.moveMany(ids, e.target.value))}>
        <option value="">Move to…</option>
        <option value={BACKLOG}>Backlog</option>
        {view.columns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {view.phases.length > 0 && (
        <select className="field backlog-phase" aria-label="Set phase" value="" onChange={(e) => e.target.value && run(ops.updateMany(ids, { phase: e.target.value === "none" ? "" : e.target.value }))}>
          <option value="">Phase…</option>
          {view.phases.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || "Untitled phase"}
            </option>
          ))}
          <option value="none">No phase</option>
        </select>
      )}
      <select className="field backlog-phase" aria-label="Set priority" value="" onChange={(e) => e.target.value && run(ops.updateMany(ids, { priority: e.target.value as Priority }))}>
        <option value="">Priority…</option>
        {PRIORITIES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <select className="field backlog-phase" aria-label="Assign" value="" onChange={(e) => e.target.value && run(ops.updateMany(ids, { assignee: e.target.value === "none" ? "" : e.target.value === "@me" ? me || "@me" : e.target.value }))}>
        <option value="">Assign…</option>
        <option value="@me">Me{me ? ` (${me})` : ""}</option>
        {assignees.filter((a) => a !== me).map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
        <option value="none">Unassigned</option>
      </select>
      <input
        className="field tasks-tag"
        placeholder="Add tag, Enter"
        aria-label="Add a tag to the selected tasks"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && tag.trim()) {
            run(ops.addTagMany(ids, tag));
            setTag("");
          }
        }}
      />
      <span className="tasks-actions-gap" />
      {!allArchived && (
        <button className="ghost" title="They count as done and leave the board" onClick={() => void archiveWithUndo(ops, view, ids, onError).then(onDone)}>
          <Icon name="archive" /> Archive
        </button>
      )}
      {anyArchived && (
        <button className="ghost" onClick={() => void unarchiveWithUndo(ops, view, ids, onError).then(onDone)}>
          Restore
        </button>
      )}
      <ConfirmDelete label={`Delete ${n} ${n === 1 ? "task" : "tasks"}`} onConfirm={() => void deleteManyWithUndo(ops, ids, onError).then(onDone)} />
      <button className="tool" aria-label="Clear selection" title="Clear selection (Esc)" onClick={onDone}>
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
