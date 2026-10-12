import { useEffect, useRef, useState, type DragEvent } from "react";
import type React from "react";
import { COLUMN_COLORS, COLUMN_ICONS, COLUMN_MODES, type Category, type Column, type ColumnColor, type ColumnIcon, type TrackerOps, type TrackerView } from "./model";
import { archiveWithUndo, ChecklistCount, DeleteTaskButton, DueDate, InlineAdd, PriorityPill, ProgressBar, StatusDot, taskMenuItems } from "./bits";
import { useContextMenu } from "../components/ContextMenu";
import { useCanEdit } from "../lib/access";
import { isPinned, usePins } from "../lib/pins";
import { PinButton } from "../components/PinnedNav";
import { BranchButton } from "../components/GitButton";

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

type Drag = { kind: "task"; id: string } | { kind: "column"; id: string } | null;

/** Pixels the pointer must travel before a press on a column header becomes a drag. */
const DRAG_THRESHOLD = 5;
/** Dragging a card within this many pixels of a column's top or bottom scrolls it. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 10;
type TaskDrop = { column: string; before: string | null } | null;

export function Kanban({ workspace, view, ops, openTask, onOpenTask, onError }: Props) {
  const pins = usePins(workspace);
  const canEdit = useCanEdit();
  const [drag, setDrag] = useState<Drag>(null);
  const [taskDrop, setTaskDrop] = useState<TaskDrop>(null);
  // Column drops are shown as a line before this column (null: after the last).
  const [colDrop, setColDrop] = useState<{ before: string | null } | null>(null);
  const run = (p: Promise<unknown>) => p.catch(onError);
  const ctx = useContextMenu();

  const endDrag = () => {
    setDrag(null);
    setTaskDrop(null);
    setColDrop(null);
  };

  // Columns are dragged with pointer events rather than native drag and drop:
  // WebKit refuses native drops started from a column header.
  const boardRef = useRef<HTMLDivElement>(null);
  const colDropRef = useRef<{ before: string | null } | null>(null);
  const columnsRef = useRef(view.columns);
  columnsRef.current = view.columns;

  const startColumnDrag = (e: React.PointerEvent, columnId: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".col-menu")) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const targetAt = (x: number): { before: string | null } => {
      const sections = [...(boardRef.current?.querySelectorAll<HTMLElement>("[data-column]") ?? [])];
      for (const sec of sections) {
        const r = sec.getBoundingClientRect();
        if (x < r.left + r.width / 2) return { before: sec.dataset.column! };
      }
      return { before: null };
    };

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        window.getSelection()?.removeAllRanges();
        setDrag({ kind: "column", id: columnId });
      }
      const t = targetAt(ev.clientX);
      colDropRef.current = t;
      setColDrop((cur) => (cur?.before === t.before ? cur : t));
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", cancel);
      const t = colDropRef.current;
      colDropRef.current = null;
      if (dragging) {
        endDrag();
        // Dropping right before or after itself changes nothing.
        const cols = columnsRef.current;
        const i = cols.findIndex((c) => c.id === columnId);
        const noop = t && (t.before === columnId || t.before === (cols[i + 1]?.id ?? null));
        if (t && !noop) run(ops.moveColumn(columnId, t.before));
      }
    };

    const cancel = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      colDropRef.current = null;
      dragging = false;
      endDrag();
      up();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", cancel);
  };

  const onColumnDragOver = (e: DragEvent<HTMLElement>, column: Column) => {
    if (drag?.kind !== "task") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    // The whole column is the target, so a card can be dropped into the empty
    // space under a short column. Near the top or bottom edge, scroll the list.
    const list = e.currentTarget.querySelector<HTMLElement>(".kcol-cards");
    if (list) {
      const r = list.getBoundingClientRect();
      if (e.clientY < r.top + SCROLL_EDGE) list.scrollTop -= SCROLL_STEP;
      else if (e.clientY > r.bottom - SCROLL_EDGE) list.scrollTop += SCROLL_STEP;
    }

    // Tasks: insert before the first card whose middle is below the pointer;
    // below every card (or in the empty space) means the end of the column.
    let before: string | null = null;
    for (const card of e.currentTarget.querySelectorAll<HTMLElement>("[data-task]")) {
      const r = card.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        before = card.dataset.task!;
        break;
      }
    }
    if (before === drag.id) return;
    if (taskDrop?.column !== column.id || taskDrop.before !== before) setTaskDrop({ column: column.id, before });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const d = drag;
    const t = taskDrop;
    endDrag();
    if (d?.kind === "task" && t) run(ops.move(d.id, t.column, t.before));
  };

  // The active phase: only its tasks are on the board; the rest wait in the backlog.
  const active = view.doc.activePhase && view.phases.find((p) => p.id === view.doc.activePhase);
  const onBoard = (id: string) => view.onBoard(id) && (!active || view.tasks.get(id)!.phase === active.id);
  const boardIds = [...view.tasks.keys()].filter(onBoard);
  const hidden = [...view.tasks.keys()].filter((id) => !view.archived(id)).length - boardIds.length;
  // Archived tasks have left the board but still count as done in its total (within the phase shown, or overall).
  const archivedIds = [...view.tasks.keys()].filter((id) => view.archived(id) && (!active || view.tasks.get(id)!.phase === active.id));
  const total = view.progress([...boardIds, ...archivedIds]);
  const span = active && active.start && active.end ? phaseWindow(active.start, active.end) : null;

  return (
    <div className="board">
      <div className="board-bar">
          <span className="board-total" title={`${total.done} of ${total.total} tasks are done${archivedIds.length ? ` (${archivedIds.length} archived)` : ""}`}>
            <ProgressBar value={total.total ? total.done / total.total : 0} label="Tasks done" className="board-total-bar" />
            <span className="muted small">
              {total.done}/{total.total} done
            </span>
          </span>
          {hidden > 0 && !active && (
            <span className="muted small">
              {hidden} in the backlog
            </span>
          )}
          {(view.phases.length > 0 || active) && (
          <label className="board-phase">
            <span className="muted small">Phase</span>
            <select className="field" value={active ? active.id : ""} disabled={!canEdit} onChange={(e) => run(ops.setActivePhase(e.target.value))}>
              <option value="">All tasks</option>
              {view.phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || "Untitled phase"}
                </option>
              ))}
            </select>
          </label>
          )}
          {active && (
            <span className="board-window" title={span ? `${span.label}. ${span.text}` : "Set the phase's planned start and end"}>
              <input
                type="date"
                className="field phase-date"
                aria-label="Phase start"
                value={active.start ?? ""}
                disabled={!canEdit}
                onChange={(e) => run(ops.setPhaseDates(active.id, { start: e.target.value }))}
              />
              <span className="muted small" aria-hidden="true">
                to
              </span>
              <input
                type="date"
                className="field phase-date"
                aria-label="Phase end"
                value={active.end ?? ""}
                disabled={!canEdit}
                onChange={(e) => run(ops.setPhaseDates(active.id, { end: e.target.value }))}
              />
              {span ? (
                <>
                  <span className="muted small">{span.text}</span>
                  <ProgressBar value={span.frac} label={`${active.name} time`} className="board-window-bar" data-late={span.late || undefined} />
                  <span className="muted small">{Math.round(span.frac * 100)}%</span>
                </>
              ) : (
                <span className="muted small">No dates yet</span>
              )}
            </span>
          )}
      </div>
    <div className="kanban" ref={boardRef} data-column-drag={drag?.kind === "column" || undefined} onDragEnd={endDrag}>
      {view.columns.map((col, i) => {
        const ids = view.columnTasks(col.id).filter(onBoard);
        const isTarget = drag?.kind === "task" && taskDrop?.column === col.id;
        const color = view.columnColor(col.id);
        const mode = view.columnCategory(col.id);
        // An "In progress" column shows how far along its tasks are, together.
        const colProgress = mode === "doing" && ids.length ? ids.reduce((sum, id) => sum + view.taskProgress(id), 0) / ids.length : null;
        return (
          <section
            key={col.id}
            className="kcol"
            data-done={view.isDone(col.id) || undefined}
            aria-label={col.name}
            data-column={col.id}
            data-dragging={(drag?.kind === "column" && drag.id === col.id) || undefined}
            data-drop-target={isTarget || undefined}
            data-drop-before={(drag?.kind === "column" && colDrop?.before === col.id) || undefined}
            data-drop-after={(drag?.kind === "column" && colDrop?.before === null && i === view.columns.length - 1) || undefined}
            style={{ ["--col" as string]: `var(--col-${color})` }}
            onDragOver={(e) => onColumnDragOver(e, col)}
            onDragLeave={(e) => {
              // Leaving the column (not just moving between its children) clears the target.
              const r = e.currentTarget.getBoundingClientRect();
              const out = e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom;
              if (out && taskDrop?.column === col.id) setTaskDrop(null);
            }}
            onDrop={onDrop}
          >
            <header className="kcol-head" onPointerDown={canEdit ? (e) => startColumnDrag(e, col.id) : undefined}>
              <StatusDot icon={view.columnIcon(col.id)} color={color} />
              <span className="kcol-name">{col.name || "Untitled"}</span>
              <span className="kcol-count">{ids.length}</span>
              {colProgress !== null && <ProgressBar value={colProgress} label={`${col.name || "Column"} progress`} className="kcol-progress" />}
              {canEdit && <ColumnSettings
                column={col}
                color={color}
                icon={view.columnIcon(col.id)}
                mode={mode}
                columns={view.columns}
                doneCount={mode === "done" ? ids.length : 0}
                onClearDone={() => void archiveWithUndo(ops, view, ids, onError, `${ids.length} ${ids.length === 1 ? "task" : "tasks"} from ${col.name || "the column"}`)}
                ops={ops}
                onError={onError}
              />}
            </header>

            <div className="kcol-cards">
              {ids.map((id) => {
                const t = view.tasks.get(id)!;
                const list = view.checklist(id);
                return (
                  <div key={id} className="kcard-slot">
                    {isTarget && taskDrop?.before === id && <div className="drop-line" />}
                    <button
                      className="kcard"
                      data-task={id}
                      data-open={openTask === id || undefined}
                      data-dragging={(drag?.kind === "task" && drag.id === id) || undefined}
                      draggable={canEdit}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", id);
                        setDrag({ kind: "task", id });
                      }}
                      onClick={() => onOpenTask(id)}
                      onContextMenu={(e) => ctx.open(e, taskMenuItems(ops, view, id, canEdit, onOpenTask, onError))}
                    >
                      <span className="kcard-top">
                        <span className="task-key">{view.key(id)}</span>
                      </span>
                      <span className="kcard-title">{t.title || "Untitled task"}</span>
                      <span className="kcard-meta">
                        {t.tags.slice(0, 2).map((tag) => (
                          <span key={tag} className="tag kcard-tag">
                            {tag}
                          </span>
                        ))}
                        <PriorityPill priority={t.priority} />
                        <DueDate due={t.due} done={mode === "done"} />
                        <ChecklistCount view={view} id={id} />
                        {t.assignee && (
                          <span className="avatar" title={t.assignee} aria-label={`Assigned to ${t.assignee}`}>
                            {initials(t.assignee)}
                          </span>
                        )}
                      </span>
                      {mode === "doing" && list && <ProgressBar value={list.done / list.total} label="Checklist" className="kcard-progress" />}
                    </button>
                    <span className="kcard-tools">
                      {(t.branches?.length ?? 0) > 0 && (
                        <BranchButton repos={view.repos()} branches={t.branches!} onChange={canEdit ? (b) => run(ops.setBranches(id, b)) : undefined} onError={onError} />
                      )}
                      <PinButton workspace={workspace} pin={{ kind: "task", id, project: ops.id }} pinned={isPinned(pins, { kind: "task", id, project: ops.id })} />
                      <DeleteTaskButton ops={ops} view={view} id={id} onError={onError} />
                    </span>
                  </div>
                );
              })}
              {isTarget && taskDrop?.before === null && <div className="drop-line" />}
            </div>
          </section>
        );
      })}

      {canEdit && (
        <div className="kcol kcol-new">
          <InlineAdd label="Add column" onAdd={(name) => run(ops.addColumn(name))} />
        </div>
      )}
    </div>
    {ctx.menu}
    </div>
  );
}

/** Where today falls between a phase's planned start and end. */
function phaseWindow(start: string, end: string): { frac: number; text: string; label: string; late: boolean } {
  const day = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
  const now = new Date();
  const today = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000);
  // Swapped dates still make a window.
  const a = Math.min(day(start), day(end));
  const b = Math.max(day(start), day(end));
  const total = b - a + 1;
  const gone = Math.max(0, Math.min(total, today - a + 1));
  const frac = Math.max(0, Math.min(1, gone / total));
  const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const left = b - today;
  const text = today < a ? `Starts in ${a - today} ${a - today === 1 ? "day" : "days"}` : left < 0 ? `Ended ${-left} ${-left === 1 ? "day" : "days"} ago` : left === 0 ? "Ends today" : `${left} ${left === 1 ? "day" : "days"} left of ${total}`;
  return { frac, text, label: `${fmt(a <= day(start) ? start : end)} to ${fmt(b >= day(end) ? end : start)}`, late: left < 0 };
}

function ColumnSettings({
  column,
  color,
  icon,
  mode,
  columns,
  doneCount,
  onClearDone,
  ops,
  onError,
}: {
  column: Column;
  color: ColumnColor;
  icon: ColumnIcon;
  mode: Category;
  columns: Column[];
  /** Tasks a "Clear done" would archive (done columns only). */
  doneCount: number;
  onClearDone: () => void;
  ops: TrackerOps;
  onError: (err: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const others = columns.filter((c) => c.id !== column.id);
  const [into, setInto] = useState(others[0]?.id ?? "");
  const root = useRef<HTMLDivElement>(null);
  const run = (p: Promise<unknown>) => p.catch(onError);

  const close = () => {
    setOpen(false);
    setDeleting(false);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="col-menu" ref={root}>
      <button
        className="tool"
        aria-label={`${column.name} settings`}
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {open && (
        <div className="menu menu-settings" role="dialog" aria-label={`${column.name} settings`}>
          <label className="setting">
            <span>Name</span>
            <input
              className="field"
              autoFocus
              defaultValue={column.name}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v && v !== column.name) run(ops.updateColumn(column.id, { name: v }));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>

          <div className="setting">
            <span>Color</span>
            <div className="swatches" role="radiogroup" aria-label="Column color">
              {COLUMN_COLORS.map((c) => (
                <button
                  key={c.value}
                  role="radio"
                  aria-checked={color === c.value}
                  aria-label={c.label}
                  title={c.label}
                  className="swatch"
                  style={{ background: `var(--col-${c.value})` }}
                  onClick={() => run(ops.updateColumn(column.id, { color: c.value }))}
                />
              ))}
            </div>
          </div>

          <div className="setting">
            <span>Icon</span>
            <div className="icon-choices" role="radiogroup" aria-label="Column icon">
              {COLUMN_ICONS.map((i) => (
                <button
                  key={i.value}
                  role="radio"
                  aria-checked={icon === i.value}
                  aria-label={i.label}
                  title={i.label}
                  className="icon-choice"
                  onClick={() => run(ops.updateColumn(column.id, { icon: i.value }))}
                >
                  <StatusDot icon={i.value} color={color} />
                </button>
              ))}
            </div>
          </div>

          <div className="setting">
            <span>Tasks here are</span>
            <div className="segmented" role="radiogroup" aria-label="Column mode">
              {COLUMN_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.value}
                  aria-pressed={mode === m.value}
                  title={m.hint}
                  onClick={() => run(ops.updateColumn(column.id, { mode: m.value }))}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="check-hint">{COLUMN_MODES.find((m) => m.value === mode)?.hint}</span>
          </div>

          <div className="switcher-sep" />

          {mode === "done" && (
            <button
              className="menu-item"
              disabled={!doneCount}
              title={doneCount ? "Archive every task in this column. They stay in the Tasks tab under Done." : "Nothing to clear"}
              onClick={() => {
                close();
                onClearDone();
              }}
            >
              Clear done{doneCount ? ` (${doneCount})` : ""}
            </button>
          )}

          {!deleting ? (
            <button
              className="menu-item danger"
              disabled={!others.length}
              title={others.length ? undefined : "A board needs at least one column"}
              onClick={() => setDeleting(true)}
            >
              Delete column
            </button>
          ) : (
            <div className="menu-confirm">
              <label>
                Move its tasks to
                <select className="field" value={into} onChange={(e) => setInto(e.target.value)}>
                  {others.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="danger-btn"
                onClick={() => {
                  close();
                  run(ops.deleteColumn(column.id, into));
                }}
              >
                Delete column
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "sl" for "Sam Long", "s" for "sam", "@" for "@me". */
function initials(name: string): string {
  const parts = name.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "@";
  return parts.length === 1 ? parts[0][0].toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
