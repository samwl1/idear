import { useEffect, useMemo, useRef, useState } from "react";
import { BACKLOG, PRIORITIES, cleanPrefix, type Priority, type TrackerOps, type TrackerView } from "./model";
import { TaskDot, archiveWithUndo, deleteWithUndo, unarchiveWithUndo } from "./bits";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { References } from "../components/Links";
import type { WorkspaceSession } from "../lib/session";
import { useAccount } from "../lib/account";
import { Icon } from "../components/Icon";
import { useDebounced } from "../lib/useDebounced";
import type { ItemLookup } from "../lib/useItemLookup";
import { useCanEdit } from "../lib/access";
import { PinButton } from "../components/PinnedNav";
import { BranchButton, BranchList } from "../components/GitButton";
import { Checklist } from "./Checklist";
import { isPinned, usePins } from "../lib/pins";
import { api } from "../lib/api";

interface Props {
  session: WorkspaceSession;
  view: TrackerView;
  ops: TrackerOps;
  taskId: string;
  lookup: ItemLookup | null;
  onOpenTask: (id: string) => void;
  onOpenItem: (id: string) => void;
  onClose: () => void;
  /** Fill the page instead of a side panel. */
  wide: boolean;
  onWide: (wide: boolean) => void;
  onError: (err: unknown) => void;
}

export function TaskDrawer({ session, view, ops, taskId, onOpenItem, onClose, wide, onWide, onError }: Props) {
  const task = view.tasks.get(taskId)!;
  const canEdit = useCanEdit();
  const pins = usePins(session.id);
  // Images in a task's description are stored in the project's doc.
  const page = useMemo(
    () => ({ session, docId: ops.id, pageId: ops.id, onOpen: onOpenItem, onError }),
    [session, ops.id, onOpenItem, onError],
  );
  const [title, setTitle] = useState(task.title);
  const [draftTag, setDraftTag] = useState("");
  const run = (p: Promise<unknown>) => p.catch(onError);

  const saveTitle = useDebounced((t: string) => run(ops.setText(taskId, "title", t)), 400);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest(".ProseMirror")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const colId = view.taskColumn(taskId);
  const progress = view.checklist(taskId);
  // Dates stay inside the phase's planned window.
  const phaseOf = view.phases.find((p) => p.id === task.phase);
  const lo = phaseOf?.start || undefined;
  const hi = phaseOf?.end || undefined;
  const myName = useAccount().account?.name ?? "";
  // Everyone in the workspace, then anyone already assigned.
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    api.shareInfo(session.id).then(
      (i) => setPeople(i.people.filter((p) => p.role !== "removed").map((p) => p.name)),
      () => {},
    );
  }, [session.id]);
  const assignees = [
    ...new Set([myName, ...people, ...[...view.tasks.values()].map((t) => t.assignee)].filter(Boolean)),
  ];

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    setDraftTag("");
    if (tag && !task.tags.includes(tag)) run(ops.setTags(taskId, [...task.tags, tag]));
  };

  return (
    <aside className="drawer" data-wide={wide || undefined} aria-label={`Task ${view.key(taskId)}`}>
      <header className="drawer-head">
        <button className="tool drawer-close" aria-label="Close task" title="Close (Esc)" onClick={onClose}>
          ×
        </button>
        <span className="muted small drawer-where">{wide ? String(view.doc.title || "Untitled project") : ""}</span>
        {canEdit ? (
          <KeyMenu view={view} taskId={taskId} onPick={(p) => run(ops.setPrefix(taskId, p))} />
        ) : (
          <span className="task-key">{view.key(taskId)}</span>
        )}
        <BranchButton repos={view.repos()} branches={task.branches ?? []} onChange={canEdit ? (b) => run(ops.setBranches(taskId, b)) : undefined} onError={onError} />
        <PinButton
          workspace={session.id}
          pin={{ kind: "task", id: taskId, project: ops.id }}
          pinned={isPinned(pins, { kind: "task", id: taskId, project: ops.id })}
        />
        <button
          className="tool"
          aria-pressed={wide}
          aria-label={wide ? "Shrink to a side panel" : "Expand to the full page"}
          title={wide ? "Side panel" : "Full page"}
          onClick={() => onWide(!wide)}
        >
          <Icon name={wide ? "shrink" : "expand"} />
        </button>
      </header>

      <div className="drawer-body">
        <input
          className="drawer-title"
          value={title}
          placeholder="Task title"
          aria-label="Task title"
          readOnly={!canEdit}
          autoFocus={canEdit && !task.title}
          onChange={(e) => {
            setTitle(e.target.value);
            saveTitle(e.target.value);
          }}
        />

        <fieldset className="plain" disabled={!canEdit}>
        <dl className="fields">
          <dt>Status</dt>
          <dd>
            {view.archived(taskId) ? (
              <span className="cell-select archived-cell">
                <TaskDot view={view} id={taskId} />
                <span>Archived</span>
                {canEdit && (
                  <button className="link-btn small" onClick={() => void unarchiveWithUndo(ops, view, [taskId], onError)}>
                    Restore
                  </button>
                )}
              </span>
            ) : (
              <span className="cell-select">
                <TaskDot view={view} id={taskId} />
                <select value={colId} onChange={(e) => run(ops.move(taskId, e.target.value, null))}>
                  <option value={BACKLOG}>Backlog</option>
                  {view.columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </dd>

          <dt>Priority</dt>
          <dd>
            <select
              className="field"
              value={task.priority}
              onChange={(e) => run(ops.update(taskId, { priority: e.target.value as Priority }))}
            >
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </dd>

          <dt>
            <label htmlFor="assignee">Assignee</label>
          </dt>
          <dd>
            <input
              id="assignee"
              className="field"
              list="assignees"
              defaultValue={task.assignee}
              placeholder="Unassigned"
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v !== task.assignee) run(ops.update(taskId, { assignee: v }));
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <datalist id="assignees">
              {assignees.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </dd>

          <dt>
            <label htmlFor="start">Start</label>
          </dt>
          <dd>
            <input
              id="start"
              type="date"
              className="field"
              value={task.start ?? ""}
              min={lo}
              max={task.due || hi}
              title={lo || hi ? `Within the phase: ${lo ?? "…"} to ${hi ?? "…"}` : undefined}
              onChange={(e) => run(ops.update(taskId, { start: e.target.value }))}
            />
          </dd>

          <dt>
            <label htmlFor="due">Due</label>
          </dt>
          <dd>
            <input
              id="due"
              type="date"
              className="field"
              value={task.due}
              min={task.start || lo}
              max={hi}
              title={lo || hi ? `Within the phase: ${lo ?? "…"} to ${hi ?? "…"}` : undefined}
              onChange={(e) => run(ops.update(taskId, { due: e.target.value }))}
            />
          </dd>

          <dt>Phase</dt>
          <dd>
            <select className="field" value={task.phase} onChange={(e) => run(ops.update(taskId, { phase: e.target.value }))}>
              <option value="">No phase</option>
              {view.phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </dd>

          <dt>Tags</dt>
          <dd>
            <div className="tags inline">
              {task.tags.map((t) => (
                <span className="tag" key={t}>
                  {t}
                  {canEdit && <button
                    aria-label={`Remove tag ${t}`}
                    onClick={() => run(ops.setTags(taskId, task.tags.filter((x) => x !== t)))}
                  >
                    ×
                  </button>}
                </span>
              ))}
              {canEdit && <input
                className="tag-input"
                value={draftTag}
                placeholder="Add tag"
                aria-label="Add tag"
                onChange={(e) => setDraftTag(e.target.value)}
                onBlur={() => addTag(draftTag)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag(draftTag);
                  }
                }}
              />}
            </div>
          </dd>
        </dl>
        </fieldset>

        <section className="drawer-section">
          <h3>
            Checklist
            {progress && (
              <span className="muted small drawer-h3-note">
                {progress.done}/{progress.total}
              </span>
            )}
          </h3>
          <Checklist
            items={task.checklist ?? []}
            canEdit={canEdit}
            onAdd={(text) => run(ops.addChecklistItem(taskId, text))}
            onEdit={(id, patch) => run(ops.editChecklistItem(taskId, id, patch))}
          />
        </section>

        <section className="drawer-section">
          <h3>Git</h3>
          <BranchList repos={view.repos()} branches={task.branches ?? []} onChange={canEdit ? (b) => run(ops.setBranches(taskId, b)) : undefined} onError={onError} />
        </section>

        <section className="drawer-section">
          <h3>References</h3>
          <References
            session={session}
            targetId={taskId}
            extra={{ ids: task.links, onChange: (ids) => run(ops.setLinks(taskId, ids)) }}
            onError={onError}
          />
        </section>

        <section className="drawer-section">
          <h3>Description</h3>
          <div className="drawer-desc">
            <MarkdownEditor
              key={taskId}
              initial={task.description}
              label="Task description"
              page={page}
              className="prose compact"
              onChange={(md) => run(ops.setText(taskId, "description", md))}
            />
          </div>
        </section>

        {canEdit && <footer className="drawer-foot">
          {!view.archived(taskId) && (
            <button
              className="ghost"
              title="Counts as done and leaves the board; stays in the Tasks tab under Done"
              onClick={() => void archiveWithUndo(ops, view, [taskId], onError)}
            >
              <Icon name="archive" /> Archive
            </button>
          )}
          <button
            className="ghost"
            title="Deletes right away; undo from the message"
            onClick={() => {
              onClose();
              deleteWithUndo(ops, view, taskId, onError);
            }}
          >
            <Icon name="trash" /> Delete task
          </button>
        </footer>}
      </div>
    </aside>
  );
}

/** The task's key; click to move it to another key series (or start a new one). */
function KeyMenu({ view, taskId, onPick }: { view: TrackerView; taskId: string; onPick: (prefix: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const current = view.prefixOf(taskId);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (p: string) => {
    setOpen(false);
    setDraft("");
    if (cleanPrefix(p) && cleanPrefix(p) !== current) onPick(p);
  };

  return (
    <div className="key-menu" ref={root}>
      <button className="task-key key-btn" aria-expanded={open} title="Change key" onClick={() => setOpen(!open)}>
        {view.key(taskId)}
      </button>
      {open && (
        <div className="tb-menu key-menu-list" role="listbox" aria-label="Key">
          {view.prefixes().map((p) => (
            <button key={p} type="button" role="option" aria-selected={p === current} className="menu-item" onClick={() => pick(p)}>
              <span className="task-key">{p}</span>
              {p === current ? "current" : `next ${p}-${view.nextNumber(p)}`}
            </button>
          ))}
          <input
            className="field"
            value={draft}
            placeholder="New key, e.g. BUG"
            aria-label="New key"
            maxLength={8}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) pick(draft);
            }}
          />
          <p className="muted small key-hint">The task takes the next free number in that series.</p>
        </div>
      )}
    </div>
  );
}
