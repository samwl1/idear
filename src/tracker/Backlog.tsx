import { useMemo, useState } from "react";
import { BACKLOG, PRIORITIES, type Priority, type Task, type TrackerOps, type TrackerView } from "./model";
import { ChecklistCount, DeleteTaskButton, DueDate, TaskDot } from "./bits";
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

type SortKey = "key" | "title" | "status" | "priority" | "assignee" | "phase" | "due";

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export function Backlog({ workspace, view, ops, openTask, onOpenTask, onError }: Props) {
  const pins = usePins(workspace);
  const canEdit = useCanEdit();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "key", dir: 1 });
  const [filter, setFilter] = useState("");
  /** "" any phase, "none" no phase, or a phase id. */
  const [phaseFilter, setPhaseFilter] = useState("");
  const run = (p: Promise<unknown>) => p.catch(onError);

  const phaseName = (t: Task) => view.phases.find((p) => p.id === t.phase)?.name ?? "";
  const colIndex = (t: Task) => {
    const i = view.columns.findIndex((c) => c.id === t.column);
    return i < 0 ? 0 : i;
  };

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const ids = view.sortedByNumber().filter((id) => {
      const t = view.tasks.get(id)!;
      if (phaseFilter === "none" ? t.phase && view.phases.some((p) => p.id === t.phase) : phaseFilter && t.phase !== phaseFilter) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        view.key(id).toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.includes(q)) ||
        t.assignee.toLowerCase().includes(q)
      );
    });
    const value = (id: string): string | number => {
      const t = view.tasks.get(id)!;
      switch (sort.key) {
        case "key":
          return `${view.prefixOf(id)}-${String(t.number).padStart(9, "0")}`;
        case "title":
          return t.title.toLowerCase();
        case "status":
          return colIndex(t);
        case "priority":
          return PRIORITY_RANK[t.priority] ?? 4;
        case "assignee":
          return t.assignee.toLowerCase() || "\uffff";
        case "phase": {
          const i = view.phases.findIndex((p) => p.id === t.phase);
          return i < 0 ? Infinity : i;
        }
        case "due":
          return t.due || "\uffff";
      }
    };
    return ids.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (va < vb ? -1 : va > vb ? 1 : view.tasks.get(a)!.number - view.tasks.get(b)!.number) * sort.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sort, filter, phaseFilter]);

  const header = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button
        className="th-sort"
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}
      >
        {label}
        {sort.key === key && <span aria-hidden="true">{sort.dir === 1 ? " ▲" : " ▼"}</span>}
      </button>
    </th>
  );

  return (
    <div className="backlog">
      <div className="backlog-filters">
        <input
          className="field backlog-filter"
          placeholder="Filter by title, key, tag, or assignee"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {view.phases.length > 0 && (
          <select className="field backlog-phase" aria-label="Phase" value={phaseFilter} onChange={(e) => setPhaseFilter(e.target.value)}>
            <option value="">Any phase</option>
            {view.phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || "Untitled phase"}
              </option>
            ))}
            <option value="none">No phase</option>
          </select>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="muted">{view.tasks.size ? "No tasks match." : "No tasks yet. Add one from the board or with New task."}</p>
      ) : (
        <div className="table-wrap">
          <table className="backlog-table">
            <thead>
              <tr>
                {header("key", "Key")}
                {header("title", "Title")}
                {header("status", "Status")}
                {header("priority", "Priority")}
                {header("assignee", "Assignee")}
                {header("phase", "Phase")}
                {header("due", "Due")}
                <th className="backlog-pin" aria-label="Pin" />
              </tr>
            </thead>
            <tbody>
              {rows.map((id) => {
                const t = view.tasks.get(id)!;
                const colId = view.taskColumn(id);
                return (
                  <tr key={id} data-open={openTask === id || undefined}>
                    <td className="nowrap task-key">{view.key(id)}</td>
                    <td>
                      <button className="link-btn" onClick={() => onOpenTask(id)}>
                        {t.title || "Untitled task"}
                      </button>
                      {" "}
                      <ChecklistCount view={view} id={id} />
                    </td>
                    <td className="nowrap">
                      <span className="cell-select">
                        <TaskDot view={view} id={id} />
                        <select
                          aria-label="Status"
                          disabled={!canEdit}
                          value={colId}
                          onChange={(e) => run(ops.move(id, e.target.value, null))}
                        >
                          <option value={BACKLOG}>Backlog</option>
                          {view.columns.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </span>
                    </td>
                    <td className="nowrap">
                      <select
                        className="cell-plain"
                        aria-label="Priority"
                        disabled={!canEdit}
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
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
