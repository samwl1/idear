// Project tracker: the shape of the doc, read helpers, and every write.
// One Automerge doc per project holds its columns, phases, and tasks.
import { generateKeyBetween } from "fractional-indexing";
import { v7 as uuidv7 } from "uuid";
import { A } from "../lib/automerge";
import type { Category } from "../lib/api";
import type { ItemBase, WorkspaceSession } from "../lib/session";

export type { Category };
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export type ColumnColor = "grey" | "blue" | "violet" | "teal" | "green" | "yellow" | "orange" | "red" | "pink";

export const COLUMN_COLORS: { value: ColumnColor; label: string }[] = [
  { value: "grey", label: "Grey" },
  { value: "blue", label: "Blue" },
  { value: "violet", label: "Violet" },
  { value: "teal", label: "Teal" },
  { value: "green", label: "Green" },
  { value: "yellow", label: "Yellow" },
  { value: "orange", label: "Orange" },
  { value: "red", label: "Red" },
  { value: "pink", label: "Pink" },
];

/** How a column's status dot is drawn. */
export type ColumnIcon = "empty" | "half" | "full";

export const COLUMN_ICONS: { value: ColumnIcon; label: string }[] = [
  { value: "empty", label: "Empty" },
  { value: "half", label: "Half" },
  { value: "full", label: "Full" },
];

/** A task's `column` when it's off the board, waiting in the backlog. */
export const BACKLOG = "backlog";

export interface Column {
  id: string;
  name: string;
  order: string;
  color?: ColumnColor;
  /** Dot style. Unset follows the column's status: empty, half, or full when done. */
  icon?: ColumnIcon;
  /**
   * What the column means: "todo" does nothing, "doing" shows progress bars,
   * "done" marks its tasks done. Set by the column's settings; older docs
   * only have `done` (or nothing), read as a fallback.
   */
  category?: Category;
  /** Kept in step with `category` for older readers. */
  done?: boolean;
}

export const COLUMN_MODES: { value: Category; label: string; hint: string }[] = [
  { value: "todo", label: "To do", hint: "Nothing special: tasks here haven't started." },
  { value: "doing", label: "In progress", hint: "Shows each task's checklist progress, and the column's overall." },
  { value: "done", label: "Done", hint: "Tasks here count as done." },
];

export interface Phase {
  name: string;
  order: string;
  /** Planned window, YYYY-MM-DD or "". The board's progress bar runs between them. */
  start?: string;
  end?: string;
}

/**
 * A repository linked to a project: on a code host, or a folder on a device.
 * The list is shared; where a local folder lives on each device is kept on
 * that device (see lib/git.ts).
 */
export interface Repo {
  id: string;
  kind: "remote" | "local";
  /** Remote kind: the repository's page. */
  url?: string;
  /** "owner/repo" for a remote, the folder's name for a local one. */
  name: string;
  /** Local kind: the folder's git remote, used only to check a folder picked on another device. */
  origin?: string;
  /** Local kind: where it was first linked, so other devices can look for the same folder. */
  addedOn?: { device: string; path: string };
}

/** A branch of one of the project's repositories, linked from a task. */
export interface BranchRef {
  repo: string; // Repo id
  branch: string;
}

/** One line of a task's checklist. */
export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  /** Key prefix this task was created with, e.g. "BUG". Older tasks use the project default. */
  prefix?: string;
  number: number;
  title: string;
  description: string; // markdown
  column: string;
  order: string; // position within its column
  assignee: string;
  priority: Priority;
  /** Planned start, YYYY-MM-DD, or "". Older tasks have none; the roadmap then uses the creation day. */
  start?: string;
  due: string; // YYYY-MM-DD, or ""
  phase: string; // phase id, or ""
  /** Older docs only: subtasks used to be nested tasks. Converted into checklist items on first edit. */
  parent?: string;
  tags: string[];
  links: string[]; // other items in the workspace
  /** Steps within the task; progress comes from how many are done. */
  checklist?: ChecklistItem[];
  /** Branches this task is worked on. */
  branches?: BranchRef[];
  /**
   * When the task was put away (ms). An archived task counts as done wherever
   * it was, leaves the board, and keeps its column so it can come back.
   */
  archived?: number;
  created: number;
}

export type TrackerDoc = ItemBase & {
  prefix?: string;
  /** Repositories this project's code lives in. */
  repos?: Repo[];
  /** The phase the board shows; "" or unset shows every task. */
  activePhase?: string;
  columns: Column[];
  phases: Record<string, Phase>;
  tasks: Record<string, Task>;
};

export const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "none", label: "No priority" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];


const byOrder = <T extends { order: string }>(a: T, b: T) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);

// ---- reads ----------------------------------------------------------------------

/** A snapshot of the doc with everything the views need precomputed. */
export class TrackerView {
  readonly columns: Column[];
  readonly phases: ({ id: string } & Phase)[];
  readonly tasks: Map<string, Task>;
  /** Tasks from older docs still nested under a parent; converted on first edit. */
  readonly nested: string[];
  readonly prefix: string;

  constructor(readonly doc: TrackerDoc) {
    this.columns = [...(doc.columns ?? [])].map((c) => ({ ...c })).sort(byOrder);
    this.phases = Object.entries(doc.phases ?? {})
      .map(([id, p]) => ({ id, name: p.name, order: p.order, start: p.start ?? "", end: p.end ?? "" }))
      .sort(byOrder);
    this.tasks = new Map(Object.entries(doc.tasks ?? {}));
    this.nested = this.sortedByNumber().filter((id) => {
      const p = this.tasks.get(id)!.parent;
      return !!p && this.tasks.has(p);
    });
    this.prefix = doc.prefix || DEFAULT_PREFIX;
  }

  prefixOf(id: string): string {
    return this.tasks.get(id)?.prefix || this.prefix;
  }

  key(id: string): string {
    const t = this.tasks.get(id);
    return t ? `${this.prefixOf(id)}-${t.number}` : "";
  }

  /** Next free number for a key prefix: AL-1, AL-2 and BUG-1 count separately. */
  nextNumber(prefix: string): number {
    let max = 0;
    for (const id of this.tasks.keys()) {
      if (this.prefixOf(id) === prefix) max = Math.max(max, this.tasks.get(id)!.number);
    }
    return max + 1;
  }

  /** Every prefix in use, most used first. */
  prefixes(): string[] {
    const counts = new Map<string, number>();
    for (const id of this.tasks.keys()) counts.set(this.prefixOf(id), (counts.get(this.prefixOf(id)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  }

  phaseByName(name: string): string | undefined {
    const n = name.trim().toLowerCase();
    return this.phases.find((p) => p.name.trim().toLowerCase() === n)?.id;
  }

  column(id: string): Column | undefined {
    return this.columns.find((c) => c.id === id);
  }

  isDone(columnId: string): boolean {
    return this.columnCategory(columnId) === "done";
  }

  /**
   * A column's mode. Set by its settings; older docs only have `done` (done
   * columns are done, the first is to do, the rest in progress), or nothing
   * (the last column is done).
   */
  columnCategory(columnId: string): Category {
    if (columnId === BACKLOG) return "todo";
    const i = this.columns.findIndex((c) => c.id === columnId);
    const col = this.columns[i];
    if (!col) return "todo";
    if (col.category === "todo" || col.category === "doing" || col.category === "done") return col.category;
    const done = typeof col.done === "boolean" ? col.done : i === this.columns.length - 1 && i > 0;
    return done ? "done" : i <= 0 ? "todo" : "doing";
  }

  columnColor(columnId: string): ColumnColor {
    const col = this.column(columnId);
    if (col?.color) return col.color;
    const fallback: Record<Category, ColumnColor> = { todo: "grey", doing: "blue", done: "green" };
    return fallback[this.columnCategory(col?.id ?? "")];
  }

  columnIcon(columnId: string): ColumnIcon {
    const icon = this.column(columnId)?.icon;
    if (icon === "empty" || icon === "half" || icon === "full") return icon;
    const fallback: Record<Category, ColumnIcon> = { todo: "empty", doing: "half", done: "full" };
    return fallback[this.columnCategory(columnId)];
  }

  icon(taskId: string): ColumnIcon {
    if (this.archived(taskId)) return "full";
    return this.columnIcon(this.taskColumn(taskId));
  }

  /** The column a task is shown in: BACKLOG when it's off the board; tasks in a deleted column land in the first. */
  taskColumn(taskId: string): string {
    const t = this.tasks.get(taskId);
    if (!t) return this.columns[0]?.id ?? "";
    if (t.column === BACKLOG) return BACKLOG;
    return this.column(t.column) ? t.column : (this.columns[0]?.id ?? "");
  }

  inBacklog(taskId: string): boolean {
    return this.tasks.get(taskId)?.column === BACKLOG;
  }

  archived(taskId: string): boolean {
    return !!this.tasks.get(taskId)?.archived;
  }

  /** On the board: in a column, not archived. */
  onBoard(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    return !!t && t.column !== BACKLOG && !t.archived;
  }

  /** An archived task is done wherever it was. */
  category(taskId: string): Category {
    if (this.archived(taskId)) return "done";
    return this.columnCategory(this.taskColumn(taskId));
  }

  /** Tasks whose column is done, or that are archived, in this order of the id list. */
  doneTasks(ids: string[]): string[] {
    return ids.filter((id) => this.category(id) === "done");
  }

  color(taskId: string): ColumnColor {
    return this.columnColor(this.taskColumn(taskId));
  }

  /** Tasks in a column (or BACKLOG), top to bottom, archived ones left out. Tasks in a deleted column land in the first one. */
  columnTasks(columnId: string): string[] {
    const first = this.columns[0]?.id;
    return [...this.tasks.entries()]
      .filter(([, t]) => !t.archived && (t.column === columnId || (columnId === first && t.column !== BACKLOG && !this.column(t.column))))
      .sort(([ia, a], [ib, b]) => (a.order < b.order ? -1 : a.order > b.order ? 1 : ia < ib ? -1 : 1))
      .map(([id]) => id);
  }

  sortedByNumber(): string[] {
    return [...this.tasks.entries()].sort(([, a], [, b]) => a.number - b.number).map(([id]) => id);
  }

  /** Done / total for a set of tasks. */
  progress(ids: string[]): { done: number; total: number } {
    return { done: ids.filter((id) => this.category(id) === "done").length, total: ids.length };
  }

  /** A task's checklist progress, or null when it has no checklist. */
  checklist(taskId: string): { done: number; total: number } | null {
    const list = this.tasks.get(taskId)?.checklist ?? [];
    if (!list.length) return null;
    return { done: list.filter((i) => i.done).length, total: list.length };
  }

  /** 0..1 for a task: its checklist, or 1 when done, else 0. */
  taskProgress(taskId: string): number {
    if (this.category(taskId) === "done") return 1;
    const c = this.checklist(taskId);
    return c ? c.done / c.total : 0;
  }

  /** The project's repositories. */
  repos(): Repo[] {
    return this.doc.repos ?? [];
  }

  repo(id: string): Repo | undefined {
    return this.repos().find((r) => r.id === id);
  }
}

/**
 * Keep a task's dates inside its phase's planned window, when the phase has
 * one. Called after any write that touches dates or the phase.
 */
function boundToPhase(d: TrackerDoc, taskId: string) {
  const t = d.tasks[taskId];
  const p = t?.phase ? d.phases?.[t.phase] : undefined;
  if (!t || !p) return;
  const lo = p.start || "";
  const hi = p.end || "";
  if (lo) {
    if (t.start && t.start < lo) t.start = lo;
    if (t.due && t.due < lo) t.due = lo;
  }
  if (hi) {
    if (t.start && t.start > hi) t.start = hi;
    if (t.due && t.due > hi) t.due = hi;
  }
  if (t.start && t.due && t.due < t.start) t.due = t.start;
}

/** A plain copy of a task for putting back into a doc; a column that no longer exists becomes the first. */
function cloneTask(d: TrackerDoc, t: Task): Task {
  const task: Task = {
    prefix: t.prefix,
    number: t.number,
    title: t.title,
    description: t.description,
    column: t.column === BACKLOG || d.columns?.some((c) => c.id === t.column) ? t.column : (d.columns?.[0]?.id ?? t.column),
    order: t.order,
    assignee: t.assignee,
    priority: t.priority,
    start: t.start ?? "",
    due: t.due,
    phase: t.phase,
    tags: [...t.tags],
    links: [...t.links],
    checklist: (t.checklist ?? []).map((i) => ({ ...i })),
    branches: (t.branches ?? []).map((b) => ({ ...b })),
    created: t.created,
  };
  if (t.archived) task.archived = t.archived;
  return task;
}

/** The key new tasks get until one is chosen: DEFAULT-1, DEFAULT-2… */
export const DEFAULT_PREFIX = "DEFAULT";

/** The key prefix for a project that hasn't picked one. */
export function defaultPrefix(_title: string): string {
  return DEFAULT_PREFIX;
}

/** Uppercase letters and digits, at most 8. */
export function cleanPrefix(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || DEFAULT_PREFIX;
}

/** What a new task starts with. Anything left out uses the project's defaults. */
export interface NewTask {
  title?: string;
  column?: string;
  prefix?: string;
  tags?: string[];
  priority?: Priority;
  /** A phase id. */
  phase?: string;
  /** A phase by name; created if no phase has that name. Ignored when `phase` is set. */
  phaseName?: string;
  assignee?: string;
  /** YYYY-MM-DD. */
  due?: string;
}

// ---- writes ---------------------------------------------------------------------

/** Every write to a project goes through here, logged with a precise action and subject. */
export class TrackerOps {
  constructor(
    private session: WorkspaceSession,
    readonly id: string,
    private view: () => TrackerView,
  ) {}

  private change(action: string, subject: string, fn: A.ChangeFn<TrackerDoc>) {
    return this.session.changeItem<TrackerDoc>(this.id, "edit", fn, { action, subject });
  }

  // tasks

  async createTask(init: NewTask = {}) {
    const v = this.view();
    const id = uuidv7();
    const column = init.column === BACKLOG ? BACKLOG : init.column && v.column(init.column) ? init.column : (v.columns[0]?.id ?? "");
    const inColumn = v.columnTasks(column);
    const last = inColumn[inColumn.length - 1];
    const prefix = cleanPrefix(init.prefix || v.doc.prefix || defaultPrefix(String(v.doc.title)));
    const number = v.nextNumber(prefix);
    // A typed phase name that doesn't exist yet becomes a new phase.
    const named = init.phaseName?.trim();
    const existingPhase = named ? v.phaseByName(named) : undefined;
    const newPhaseId = named && !existingPhase ? uuidv7() : undefined;
    const lastPhase = v.phases[v.phases.length - 1]?.order ?? null;
    const phase = init.phase ?? existingPhase ?? newPhaseId ?? "";

    await this.change("task.create", id, (d) => {
      if (!d.prefix) d.prefix = prefix;
      if (!d.tasks) d.tasks = {};
      if (newPhaseId && named) {
        if (!d.phases) d.phases = {};
        d.phases[newPhaseId] = { name: named, order: generateKeyBetween(lastPhase, null) };
      }
      d.tasks[id] = {
        prefix,
        number,
        title: init.title ?? "",
        description: "",
        column,
        order: generateKeyBetween(last ? v.tasks.get(last)!.order : null, null),
        assignee: init.assignee ?? "",
        priority: init.priority ?? "none",
        due: init.due ?? "",
        phase,
        tags: [...(init.tags ?? [])],
        links: [],
        created: Date.now(),
      };
    });
    return id;
  }

  /** Set simple fields. Title and description go through setText. */
  update(taskId: string, patch: Partial<Pick<Task, "assignee" | "priority" | "due" | "phase" | "start">>) {
    return this.change("task.edit", taskId, (d) => {
      const t = d.tasks[taskId];
      if (!t) return;
      for (const [k, v] of Object.entries(patch)) (t as unknown as Record<string, unknown>)[k] = v;
      // Setting one date schedules the task: the other date comes on at the same day.
      if (patch.start && !t.due) t.due = patch.start;
      if (patch.due && !t.start) t.start = patch.due;
      if ("start" in patch || "due" in patch || "phase" in patch) boundToPhase(d, taskId);
    });
  }

  /** Move a task to another key series: it takes the next free number there. */
  setPrefix(taskId: string, raw: string) {
    const v = this.view();
    const prefix = cleanPrefix(raw);
    if (!prefix || prefix === v.prefixOf(taskId)) return Promise.resolve();
    const number = v.nextNumber(prefix);
    return this.change("task.rekey", taskId, (d) => {
      const t = d.tasks[taskId];
      if (!t) return;
      t.prefix = prefix;
      t.number = number;
    });
  }

  setText(taskId: string, field: "title" | "description", value: string) {
    return this.change("task.edit", taskId, (d) => {
      if (d.tasks[taskId]) A.updateText(d, ["tasks", taskId, field], value);
    });
  }

  /** Put a task in a phase ("" for none). */
  setPhase(taskId: string, phase: string) {
    return this.change("task.move", taskId, (d) => {
      if (!d.tasks[taskId]) return;
      d.tasks[taskId].phase = phase;
      boundToPhase(d, taskId);
    });
  }

  // checklist

  setChecklist(taskId: string, items: ChecklistItem[]) {
    return this.change("task.checklist", taskId, (d) => {
      const t = d.tasks[taskId];
      if (t) t.checklist = items.map((i) => ({ id: i.id, text: i.text, done: i.done }));
    });
  }

  addChecklistItem(taskId: string, text: string) {
    return this.change("task.checklist", taskId, (d) => {
      const t = d.tasks[taskId];
      if (!t) return;
      if (!t.checklist) t.checklist = [];
      t.checklist.push({ id: uuidv7(), text, done: false });
    });
  }

  /** Tick, rename, or remove (text null) one item. */
  editChecklistItem(taskId: string, itemId: string, patch: { done?: boolean; text?: string | null }) {
    return this.change("task.checklist", taskId, (d) => {
      const list = d.tasks[taskId]?.checklist;
      if (!list) return;
      const i = list.findIndex((x) => x.id === itemId);
      if (i < 0) return;
      if (patch.text === null) list.splice(i, 1);
      else {
        if (patch.text !== undefined) list[i].text = patch.text;
        if (patch.done !== undefined) list[i].done = patch.done;
      }
    });
  }

  // git

  setRepos(repos: Repo[]) {
    return this.change("project.repos", this.id, (d) => void (d.repos = repos.map((r) => JSON.parse(JSON.stringify(r)) as Repo)));
  }

  setBranches(taskId: string, branches: BranchRef[]) {
    return this.change("task.branches", taskId, (d) => {
      const t = d.tasks[taskId];
      if (t) t.branches = branches.map((b) => ({ repo: b.repo, branch: b.branch }));
    });
  }

  /**
   * Older docs nested subtasks under a parent. Fold each one into its parent's
   * checklist (ticked if it was done) and remove it. A subtask's description,
   * if any, is kept at the end of the parent's.
   */
  convertNested() {
    const v = this.view();
    if (!v.nested.length) return Promise.resolve();
    // Deepest first, so a subtask's own subtasks fold into it before it folds into its parent.
    const depth = (id: string, seen = new Set<string>()): number => {
      const p = v.tasks.get(id)?.parent;
      if (!p || !v.tasks.has(p) || seen.has(id)) return 0;
      seen.add(id);
      return 1 + depth(p, seen);
    };
    const order = [...v.nested].sort((a, b) => depth(b) - depth(a) || v.tasks.get(a)!.number - v.tasks.get(b)!.number);
    return this.change("task.checklist", this.id, (d) => {
      for (const id of order) {
        const t = d.tasks[id];
        const parent = t?.parent ? d.tasks[t.parent] : undefined;
        if (!t || !parent) continue;
        if (!parent.checklist) parent.checklist = [];
        const key = `${t.prefix || d.prefix || DEFAULT_PREFIX}-${t.number}`;
        parent.checklist.push({ id: uuidv7(), text: t.title ? `${t.title} (${key})` : key, done: v.category(id) === "done" });
        for (const item of t.checklist ?? []) parent.checklist.push({ id: uuidv7(), text: `${t.title || key}: ${item.text}`, done: item.done });
        if (String(t.description).trim()) {
          const extra = `\n\n## From ${key} ${t.title}\n\n${String(t.description).trim()}\n`;
          A.updateText(d, ["tasks", t.parent!, "description"], String(parent.description) + extra);
        }
        delete d.tasks[id];
      }
    });
  }

  /** Move to a column, before `beforeId` (or to the end). */
  move(taskId: string, column: string, beforeId: string | null) {
    const v = this.view();
    const ids = v.columnTasks(column).filter((x) => x !== taskId);
    const found = beforeId ? ids.indexOf(beforeId) : -1;
    const i = found >= 0 ? found : ids.length;
    const lo = i > 0 ? v.tasks.get(ids[i - 1])!.order : null;
    const hi = i < ids.length ? v.tasks.get(ids[i])!.order : null;
    // Equal keys can appear after offline edits merge; fall back to "after lo".
    const order = lo !== null && hi !== null && lo >= hi ? generateKeyBetween(lo, null) : generateKeyBetween(lo, hi);
    return this.change("task.move", taskId, (d) => {
      const t = d.tasks[taskId];
      if (!t) return;
      if (t.column !== column) t.column = column;
      t.order = order;
    });
  }

  setTags(taskId: string, tags: string[]) {
    return this.change("task.tag", taskId, (d) => {
      const t = d.tasks[taskId];
      if (t) t.tags = [...tags];
    });
  }

  setLinks(taskId: string, links: string[]) {
    return this.change("task.edit", taskId, (d) => {
      const t = d.tasks[taskId];
      if (t) t.links = [...links];
    });
  }

  /**
   * Put tasks away: they count as done, leave the board, and show under Done
   * in the Tasks tab. One change, so Undo is one step.
   */
  archiveTasks(ids: string[]) {
    const now = Date.now();
    return this.change("task.archive", ids.length === 1 ? ids[0] : this.id, (d) => {
      for (const id of ids) {
        const t = d.tasks[id];
        if (t && !t.archived) t.archived = now;
      }
    });
  }

  /** Bring archived tasks back to the column they were in. */
  unarchiveTasks(ids: string[]) {
    return this.change("task.unarchive", ids.length === 1 ? ids[0] : this.id, (d) => {
      for (const id of ids) {
        const t = d.tasks[id];
        if (t && t.archived) delete t.archived;
      }
    });
  }

  /** Every task that is done and not yet archived, on the board (or in a column). */
  archiveDone(columnId?: string) {
    const v = this.view();
    const ids = [...v.tasks.keys()].filter(
      (id) => !v.archived(id) && v.category(id) === "done" && (!columnId || v.taskColumn(id) === columnId),
    );
    return this.archiveTasks(ids).then(() => ids);
  }

  /** Archive every task in a phase (Close phase). Returns the ids archived. */
  archivePhase(phaseId: string) {
    const v = this.view();
    const ids = [...v.tasks.entries()].filter(([id, t]) => t.phase === phaseId && !v.archived(id)).map(([id]) => id);
    return this.archiveTasks(ids).then(() => ids);
  }

  /** Several tasks' simple fields at once: one change, one Undo. */
  updateMany(ids: string[], patch: Partial<Pick<Task, "assignee" | "priority" | "due" | "phase" | "start">>) {
    return this.change("task.edit", this.id, (d) => {
      for (const id of ids) {
        const t = d.tasks[id];
        if (!t) continue;
        for (const [k, v] of Object.entries(patch)) (t as unknown as Record<string, unknown>)[k] = v;
        if (patch.start && !t.due) t.due = patch.start;
        if (patch.due && !t.start) t.start = patch.due;
        if ("start" in patch || "due" in patch || "phase" in patch) boundToPhase(d, id);
      }
    });
  }

  /** Move several tasks to the end of a column (or the backlog) in one change. */
  moveMany(ids: string[], column: string) {
    const v = this.view();
    const inColumn = v.columnTasks(column).filter((id) => !ids.includes(id));
    let lo = inColumn.length ? v.tasks.get(inColumn[inColumn.length - 1])!.order : null;
    const orders = ids.map(() => (lo = generateKeyBetween(lo, null)));
    return this.change("task.move", this.id, (d) => {
      ids.forEach((id, i) => {
        const t = d.tasks[id];
        if (!t) return;
        if (t.column !== column) t.column = column;
        t.order = orders[i];
        if (t.archived) delete t.archived;
      });
    });
  }

  /** Add a tag to several tasks. */
  addTagMany(ids: string[], tag: string) {
    const clean = tag.trim();
    if (!clean) return Promise.resolve();
    return this.change("task.tag", this.id, (d) => {
      for (const id of ids) {
        const t = d.tasks[id];
        if (t && !t.tags.includes(clean)) t.tags.push(clean);
      }
    });
  }

  /** Delete several tasks in one change. Returns them for Undo. */
  async deleteTasks(ids: string[]): Promise<Record<string, { task: Task }>> {
    const v = this.view();
    const removed: Record<string, { task: Task }> = {};
    for (const id of ids) {
      const t = v.tasks.get(id);
      if (t) removed[id] = { task: JSON.parse(JSON.stringify(t)) as Task };
    }
    await this.change("task.delete", this.id, (d) => {
      for (const id of Object.keys(removed)) delete d.tasks[id];
    });
    return removed;
  }

  /** Put several deleted tasks back in one change. */
  restoreTasks(removed: Record<string, { task: Task }>) {
    return this.change("task.restore", this.id, (d) => {
      for (const [id, r] of Object.entries(removed)) {
        if (d.tasks[id]) continue;
        d.tasks[id] = cloneTask(d, r.task);
      }
    });
  }

  /** Delete a task. Returns it so `restoreTask` can put it back (Undo in the toast). */
  async deleteTask(taskId: string): Promise<{ task: Task } | null> {
    const v = this.view();
    const t = v.tasks.get(taskId);
    if (!t) return null;
    const task = JSON.parse(JSON.stringify(t)) as Task;
    await this.change("task.delete", taskId, (d) => {
      delete d.tasks[taskId];
    });
    return { task };
  }

  /** Put a deleted task back. */
  restoreTask(taskId: string, removed: { task: Task }) {
    return this.change("task.restore", taskId, (d) => {
      if (d.tasks[taskId]) return;
      d.tasks[taskId] = cloneTask(d, removed.task);
    });
  }

  // columns

  addColumn(name: string) {
    const cols = this.view().columns;
    const last = cols[cols.length - 1]?.order ?? null;
    const used = new Set(cols.map((c) => c.color));
    const color = COLUMN_COLORS.find((c) => !used.has(c.value))?.value ?? "grey";
    return this.change("column.create", this.id, (d) => {
      d.columns.push({ id: uuidv7(), name, color, done: false, order: generateKeyBetween(last, null) });
    });
  }

  updateColumn(columnId: string, patch: { name?: string; color?: ColumnColor; icon?: ColumnIcon; mode?: Category }) {
    return this.change("column.edit", this.id, (d) => {
      const c = d.columns.find((x) => x.id === columnId);
      if (!c) return;
      if (patch.name !== undefined) c.name = patch.name;
      if (patch.color !== undefined) c.color = patch.color;
      if (patch.icon !== undefined) c.icon = patch.icon;
      if (patch.mode !== undefined) {
        c.category = patch.mode;
        c.done = patch.mode === "done";
      }
    });
  }

  /** Move a column to sit before `beforeId`, or to the end. */
  moveColumn(columnId: string, beforeId: string | null) {
    const cols = this.view().columns.filter((c) => c.id !== columnId);
    const found = beforeId ? cols.findIndex((c) => c.id === beforeId) : -1;
    const i = found >= 0 ? found : cols.length;
    const lo = i > 0 ? cols[i - 1].order : null;
    const hi = i < cols.length ? cols[i].order : null;
    const order = lo !== null && hi !== null && lo >= hi ? generateKeyBetween(lo, null) : generateKeyBetween(lo, hi);
    return this.change("column.move", this.id, (d) => {
      const c = d.columns.find((x) => x.id === columnId);
      if (c) c.order = order;
    });
  }

  /** Delete a column, moving its tasks to `into`. */
  deleteColumn(columnId: string, into: string) {
    return this.change("column.delete", this.id, (d) => {
      for (const t of Object.values(d.tasks)) if (t.column === columnId) t.column = into;
      const i = d.columns.findIndex((x) => x.id === columnId);
      if (i >= 0) d.columns.splice(i, 1);
    });
  }

  // phases

  addPhase(name: string) {
    const phases = this.view().phases;
    const last = phases[phases.length - 1]?.order ?? null;
    return this.change("phase.create", this.id, (d) => {
      if (!d.phases) d.phases = {};
      d.phases[uuidv7()] = { name, order: generateKeyBetween(last, null) };
    });
  }

  /** Set a phase's planned window. */
  setPhaseDates(phaseId: string, patch: { start?: string; end?: string }) {
    return this.change("phase.edit", this.id, (d) => {
      const p = d.phases[phaseId];
      if (!p) return;
      if (patch.start !== undefined) p.start = patch.start;
      if (patch.end !== undefined) p.end = patch.end;
      if (p.start && p.end && p.end < p.start) [p.start, p.end] = [p.end, p.start];
      for (const id of Object.keys(d.tasks ?? {})) if (d.tasks[id].phase === phaseId) boundToPhase(d, id);
    });
  }

  /** The phase the board shows ("" for all). */
  setActivePhase(phaseId: string) {
    return this.change("project.edit", this.id, (d) => void (d.activePhase = phaseId));
  }

  /** Move several tasks' dates by `days` in one change (dragging a group on the roadmap); a phase's window moves with it. */
  shiftTasks(ids: string[], days: number, phaseId?: string) {
    const move = (iso: string) => {
      if (!iso) return iso;
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    return this.change("task.edit", this.id, (d) => {
      for (const id of ids) {
        const t = d.tasks[id];
        if (!t) continue;
        if (t.start) t.start = move(t.start);
        if (t.due) t.due = move(t.due);
      }
      const p = phaseId ? d.phases?.[phaseId] : undefined;
      if (p) {
        if (p.start) p.start = move(p.start);
        if (p.end) p.end = move(p.end);
      }
      for (const id of ids) boundToPhase(d, id);
    });
  }

  renamePhase(phaseId: string, name: string) {
    return this.change("phase.edit", this.id, (d) => {
      if (d.phases[phaseId]) A.updateText(d, ["phases", phaseId, "name"], name);
    });
  }

  shiftPhase(phaseId: string, dir: -1 | 1) {
    const phases = this.view().phases;
    const i = phases.findIndex((p) => p.id === phaseId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= phases.length) return Promise.resolve();
    const [a, b] = [phases[i], phases[j]];
    return this.change("phase.move", this.id, (d) => {
      [d.phases[a.id].order, d.phases[b.id].order] = [b.order, a.order];
    });
  }

  /** Delete a phase. Its tasks become unassigned. */
  deletePhase(phaseId: string) {
    return this.change("phase.delete", this.id, (d) => {
      for (const t of Object.values(d.tasks)) if (t.phase === phaseId) t.phase = "";
      delete d.phases[phaseId];
    });
  }
}
