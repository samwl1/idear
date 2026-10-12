import { useEffect, useRef, useState } from "react";
import type { ColumnColor, ColumnIcon, Priority, TrackerOps, TrackerView } from "./model";
import { Icon } from "../components/Icon";
import type { MenuItem } from "../components/ContextMenu";
import { useCanEdit } from "../lib/access";
import { showToast } from "../lib/toast";

/** A column's color and dot style: empty, half, or full. */
export function StatusDot({ icon, color }: { icon: ColumnIcon; color: ColumnColor }) {
  return (
    <span
      className="status-dot"
      data-icon={icon}
      style={{ ["--dot" as string]: `var(--col-${color})` }}
      aria-hidden="true"
    />
  );
}

/** Status dot for a task's current column. */
export function TaskDot({ view, id }: { view: TrackerView; id: string }) {
  return <StatusDot icon={view.icon(id)} color={view.color(id)} />;
}

const PRIORITY_LABEL: Record<Priority, string> = {
  none: "",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export function PriorityPill({ priority }: { priority: Priority }) {
  if (!priority || priority === "none") return null;
  return (
    <span className="priority" data-priority={priority}>
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

/** Due date, flagged when it has passed and the task isn't done. */
export function DueDate({ due, done }: { due: string; done: boolean }) {
  if (!due) return null;
  const today = new Date().toISOString().slice(0, 10);
  const late = !done && due < today;
  const label = new Date(`${due}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <span className="due" data-late={late || undefined} title={late ? "Overdue" : "Due"}>
      {label}
    </span>
  );
}

/** Delete a task right away; the toast offers Undo. */
export async function deleteWithUndo(ops: TrackerOps, view: TrackerView, id: string, onError: (err: unknown) => void) {
  const key = view.key(id);
  try {
    const removed = await ops.deleteTask(id);
    if (!removed) return;
    showToast(`Deleted ${key}`, {
      action: { label: "Undo", run: () => ops.restoreTask(id, removed).catch(onError) },
    });
  } catch (e) {
    onError(e);
  }
}

/** Delete several tasks in one step; the toast offers Undo. */
export async function deleteManyWithUndo(ops: TrackerOps, ids: string[], onError: (err: unknown) => void) {
  if (!ids.length) return;
  try {
    const removed = await ops.deleteTasks(ids);
    const n = Object.keys(removed).length;
    if (!n) return;
    showToast(`Deleted ${n} ${n === 1 ? "task" : "tasks"}`, {
      action: { label: "Undo", run: () => ops.restoreTasks(removed).catch(onError) },
    });
  } catch (e) {
    onError(e);
  }
}

/** Archive tasks (they count as done and leave the board); the toast offers Undo. */
export async function archiveWithUndo(ops: TrackerOps, view: TrackerView, ids: string[], onError: (err: unknown) => void, what?: string) {
  const live = ids.filter((id) => view.tasks.has(id) && !view.archived(id));
  if (!live.length) return;
  try {
    await ops.archiveTasks(live);
    const label = what ?? (live.length === 1 ? view.key(live[0]) : `${live.length} tasks`);
    showToast(`Archived ${label}`, {
      action: { label: "Undo", run: () => ops.unarchiveTasks(live).catch(onError) },
    });
  } catch (e) {
    onError(e);
  }
}

/** Bring archived tasks back; the toast offers Undo. */
export async function unarchiveWithUndo(ops: TrackerOps, view: TrackerView, ids: string[], onError: (err: unknown) => void) {
  const gone = ids.filter((id) => view.archived(id));
  if (!gone.length) return;
  try {
    await ops.unarchiveTasks(gone);
    showToast(`Restored ${gone.length === 1 ? view.key(gone[0]) : `${gone.length} tasks`}`, {
      action: { label: "Undo", run: () => ops.archiveTasks(gone).catch(onError) },
    });
  } catch (e) {
    onError(e);
  }
}

/**
 * The right-click menu for one task, shared by cards and rows: open, archive
 * or restore, delete.
 */
export function taskMenuItems(
  ops: TrackerOps,
  view: TrackerView,
  id: string,
  canEdit: boolean,
  onOpen: (id: string) => void,
  onError: (err: unknown) => void,
): MenuItem[] {
  const archived = view.archived(id);
  const done = view.category(id) === "done";
  const items: MenuItem[] = [{ label: "Open", onSelect: () => onOpen(id) }];
  if (!canEdit) return items;
  if (archived) items.push({ label: "Restore to board", onSelect: () => void unarchiveWithUndo(ops, view, [id], onError) });
  else items.push({ label: done ? "Archive" : "Archive (marks done)", onSelect: () => void archiveWithUndo(ops, view, [id], onError) });
  items.push({ label: "Delete", onSelect: () => void deleteWithUndo(ops, view, id, onError), danger: true, separator: true });
  return items;
}

/**
 * A trash button that asks once: the first click turns it into a red "Delete?",
 * the second deletes. It goes back to the icon on Escape, a click elsewhere, or
 * after a few seconds.
 */
export function ConfirmDelete({ label, title, onConfirm }: { label: string; title?: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!asking) return;
    const reset = () => setAsking(false);
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) reset();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && reset();
    const timer = window.setTimeout(reset, 4000);
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [asking]);

  return (
    <button
      ref={ref}
      type="button"
      className={asking ? "tool confirm" : "tool"}
      aria-label={asking ? `Confirm: ${label}` : label}
      title={asking ? "Click again to delete" : title ?? label}
      onClick={(e) => {
        e.stopPropagation();
        if (!asking) {
          setAsking(true);
          return;
        }
        setAsking(false);
        onConfirm();
      }}
    >
      {asking ? "Delete?" : <Icon name="trash" />}
    </button>
  );
}

/** The trash button on a card or row. */
export function DeleteTaskButton({ ops, view, id, onError }: { ops: TrackerOps; view: TrackerView; id: string; onError: (err: unknown) => void }) {
  if (!useCanEdit()) return null;
  return (
    <ConfirmDelete
      label={`Delete ${view.key(id)}`}
      title="Delete (undo from the message)"
      onConfirm={() => deleteWithUndo(ops, view, id, onError)}
    />
  );
}

/** A "+ Add …" button that turns into a text field; Enter adds, Escape cancels. */
/** `suggest`: shown in the box, and used when Enter is pressed with nothing typed. */
export function InlineAdd({ label, suggest, onAdd }: { label: string; suggest?: string; onAdd: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!useCanEdit()) return null;
  if (!open) {
    return (
      <button className="ghost inline-add" onClick={() => setOpen(true)}>
        <Icon name="plus" /> {label}
      </button>
    );
  }
  return (
    <input
      className="field inline-add-input"
      autoFocus
      placeholder={suggest || label}
      aria-label={label}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        if (v) onAdd(v);
        setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.currentTarget.value = "";
          setOpen(false);
        }
        if (e.key === "Enter") {
          const v = e.currentTarget.value.trim();
          if (v || suggest) onAdd(v);
          e.currentTarget.value = "";
        }
      }}
    />
  );
}

/** Text that turns into an input on double-click (or when `editing` is set). */
export function EditableText({
  value,
  onSave,
  className,
  label,
}: {
  value: string;
  onSave: (v: string) => void;
  className?: string;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const canEdit = useCanEdit();
  if (!editing || !canEdit) {
    return (
      <span
        className={className}
        onDoubleClick={() => canEdit && setEditing(true)}
        title={canEdit ? "Double-click to rename" : undefined}
      >
        {value || "Untitled"}
      </span>
    );
  }
  return (
    <input
      className="field editable-input"
      autoFocus
      defaultValue={value}
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        setEditing(false);
        if (v && v !== value) onSave(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

/** "2/3" checklist count for a card or row. */
export function ChecklistCount({ view, id }: { view: TrackerView; id: string }) {
  const c = view.checklist(id);
  if (!c) return null;
  return (
    <span className="subtask-count" title="Checklist items done">
      <Icon name="check" /> {c.done}/{c.total}
    </span>
  );
}

/** A thin progress bar, 0..1. */
export function ProgressBar({ value, label, className, ...rest }: { value: number; label: string; className?: string; "data-late"?: true }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className={className ? `progress ${className}` : "progress"} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label} title={`${label}: ${pct}%`} {...rest}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}
