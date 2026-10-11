import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { NewTask, TrackerOps, TrackerView } from "./model";
import { ChecklistCount, ConfirmDelete, DueDate, EditableText, InlineAdd, TaskDot } from "./bits";
import { Icon } from "../components/Icon";
import { References } from "../components/Links";
import type { WorkspaceSession } from "../lib/session";
import { useLinks } from "../lib/useLinks";
import { useCanEdit } from "../lib/access";

interface Props {
  session: WorkspaceSession;
  view: TrackerView;
  ops: TrackerOps;
  create: (init: NewTask) => Promise<unknown>;
  /** The name an empty Add task box gets, from the project's task defaults. */
  nextName: string;
  /** The task open in the panel, highlighted. */
  openTask?: string | null;
  onOpenTask: (id: string) => void;
  onError: (err: unknown) => void;
}

const NO_PHASE = "";

/** Pixels the pointer must travel before a press on a task becomes a drag. */
const DRAG_THRESHOLD = 5;

export function Roadmap({ session, view, ops, create, nextName, openTask, onOpenTask, onError }: Props) {
  const canEdit = useCanEdit();
  // Dragging a task between phases. Pointer events rather than native drag and
  // drop, which WebKit handles unreliably for non-button elements.
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  const [target, setTarget] = useState<string | null>(null); // phase id, "" for no phase
  const targetRef = useRef<string | null>(null);
  const run = (p: Promise<unknown>) => p.catch(onError);
  const phaseIds = new Set(view.phases.map((p) => p.id));

  // Tasks in a phase; tasks pointing at a deleted phase count as having none.
  const inPhase = (phase: string) =>
    view
      .sortedByNumber()
      .filter((id) => {
        const p = view.tasks.get(id)!.phase;
        return phase === NO_PHASE ? !p || !phaseIds.has(p) : p === phase;
      });

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (!canEdit || e.button !== 0 || (e.target as HTMLElement).closest("[data-no-drag]")) return;
    // Stops the press from starting a text selection that would follow the drag.
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    const phaseAt = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-phase-drop]");
      return el ? (el.dataset.phaseDrop ?? "") : null;
    };

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        window.getSelection()?.removeAllRanges();
      }
      setDrag({ id, x: ev.clientX, y: ev.clientY });
      const t = phaseAt(ev.clientX, ev.clientY);
      targetRef.current = t;
      setTarget(t);
    };

    const finish = (apply: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", esc);
      const t = targetRef.current;
      targetRef.current = null;
      setDrag(null);
      setTarget(null);
      if (!dragging) return;
      // The release lands on the row's title; don't let it open the task.
      window.addEventListener("click", (ev) => ev.stopPropagation(), { capture: true, once: true });
      if (apply && t !== null && t !== (view.tasks.get(id)?.phase ?? "")) run(ops.setPhase(id, t));
    };
    const up = () => finish(true);
    const esc = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", esc);
  };

  const renderRows = (ids: string[]) =>
    ids.map((id) => {
      const t = view.tasks.get(id)!;
      const category = view.category(id);
      const list = view.checklist(id);
      return (
        <li key={id}>
          <div className="rm-row" data-open={openTask === id || undefined} data-dragging={drag?.id === id || undefined} onPointerDown={(e) => startDrag(e, id)}>
            <TaskDot view={view} id={id} />
            <span className="task-key">{view.key(id)}</span>
            <button className="link-btn rm-title" data-done={category === "done" || undefined} onClick={() => onOpenTask(id)}>
              {t.title || "Untitled task"}
            </button>
            <span className="rm-meta">
              {list && <ChecklistCount view={view} id={id} />}
              {t.assignee && <span className="assignee">{t.assignee}</span>}
              <DueDate due={t.due} done={category === "done"} />
            </span>
          </div>
        </li>
      );
    });

  const section = (phase: { id: string; name: string; start?: string; end?: string } | null, index: number) => {
    const ids = inPhase(phase?.id ?? NO_PHASE);
    // The no-phase section only shows when it has tasks, or as a drop target mid-drag.
    if (!phase && ids.length === 0 && !drag) return null;
    const { done, total } = view.progress(ids);
    const pct = total ? Math.round((done / total) * 100) : 0;

    return (
      <section
        key={phase?.id ?? "none"}
        className="phase"
        aria-label={phase?.name ?? "No phase"}
        data-phase-drop={phase?.id ?? NO_PHASE}
        data-drop-target={(drag && target === (phase?.id ?? NO_PHASE)) || undefined}
      >
        <header className="phase-head">
          {phase ? (
            <EditableText
              className="phase-name"
              value={phase.name}
              label="Phase name"
              onSave={(name) => run(ops.renamePhase(phase.id, name))}
            />
          ) : (
            <span className="phase-name muted">No phase</span>
          )}
          <span className="phase-progress" title={`${done} of ${total} done`}>
            <span className="bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            {done}/{total}
          </span>
          {phase && (
            <span className="phase-dates">
              <input
                type="date"
                className="field phase-date"
                aria-label="Phase start"
                title="Planned start"
                value={phase.start ?? ""}
                max={phase.end || undefined}
                disabled={!canEdit}
                onChange={(e) => run(ops.setPhaseDates(phase.id, { start: e.target.value }))}
              />
              <span className="muted small" aria-hidden="true">
                to
              </span>
              <input
                type="date"
                className="field phase-date"
                aria-label="Phase end"
                title="Planned end"
                value={phase.end ?? ""}
                min={phase.start || undefined}
                disabled={!canEdit}
                onChange={(e) => run(ops.setPhaseDates(phase.id, { end: e.target.value }))}
              />
            </span>
          )}
          {phase && (
            <span className="phase-tools">
              <PhaseNotes session={session} phaseId={phase.id} onError={onError} />
              {canEdit && <>
              <button className="tool" aria-label="Move phase up" disabled={index === 0} onClick={() => run(ops.shiftPhase(phase.id, -1))}>
                <Icon name="chevron" className="chev up" />
              </button>
              <button
                className="tool"
                aria-label="Move phase down"
                disabled={index === view.phases.length - 1}
                onClick={() => run(ops.shiftPhase(phase.id, 1))}
              >
                <Icon name="chevron" className="chev down" />
              </button>
              <ConfirmDelete
                label="Delete phase"
                title="Delete phase (its tasks stay, without a phase)"
                onConfirm={() => run(ops.deletePhase(phase.id))}
              />
              </>}
            </span>
          )}
        </header>
        {ids.length ? (
          <ul className="rm-tree">{renderRows(ids)}</ul>
        ) : (
          <p className="muted small rm-empty">{drag ? "Drop here" : "No tasks in this phase yet."}</p>
        )}
        {phase && (
          <InlineAdd label="Add task" suggest={nextName} onAdd={(title) => run(create({ title, phase: phase.id }))} />
        )}
      </section>
    );
  };

  const dragged = drag && view.tasks.get(drag.id);

  return (
    <div className="roadmap" data-dragging={drag ? true : undefined}>
      {drag && dragged && (
        <div className="drag-ghost" style={{ left: drag.x + 12, top: drag.y + 8 }} aria-hidden="true">
          <span className="task-key">{view.key(drag.id)}</span>
          {dragged.title || "Untitled task"}
        </div>
      )}
      {view.phases.length === 0 && (
        <p className="muted">Phases group tasks into ordered stages, like Research, Build, Launch. Add your first one.</p>
      )}
      {view.phases.map((p, i) => section(p, i))}
      <InlineAdd label="Add phase" onAdd={(name) => run(ops.addPhase(name))} />
      {section(null, -1)}
    </div>
  );
}

/** A phase's references (notes and whiteboards): a count in the header that opens the list. */
function PhaseNotes({
  session,
  phaseId,
  onError,
}: {
  session: WorkspaceSession;
  phaseId: string;
  onError: (err: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const links = useLinks(session, phaseId, onError);
  const count = links?.incoming.filter((l) => l.kind === "note" || l.kind === "whiteboard").length ?? 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      // The note picker renders inside; only clicks fully outside close the popover.
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <span className="phase-notes" ref={root}>
      <button
        className="tool phase-notes-btn"
        aria-expanded={open}
        aria-label={count ? `${count} references` : "Add a reference"}
        title={count ? `${count} ${count === 1 ? "reference" : "references"}` : "Add a reference"}
        onClick={() => setOpen(!open)}
      >
        <Icon name="note" />
        {count > 0 && <span className="phase-notes-count">{count}</span>}
      </button>
      {open && (
        <div className="menu phase-notes-menu" role="dialog" aria-label="Phase references">
          <p className="menu-label">Notes on this phase</p>
          <References session={session} targetId={phaseId} onError={onError} />
        </div>
      )}
    </span>
  );
}
