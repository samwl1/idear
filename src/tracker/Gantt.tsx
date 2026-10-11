// Roadmap: tasks on a time axis, grouped by phase, task, tag, or person. A
// task runs from its start (or the day it was created) to its due date. A group
// row spans its tasks and fills by how many are done; open it to see them.
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { PRIORITIES, type Category, type Priority, type Task, type TrackerOps, type TrackerView } from "./model";
import { useCanEdit } from "../lib/access";
import { Icon } from "../components/Icon";

type GroupBy = "phase" | "task" | "tag" | "person";
type Zoom = "day" | "week" | "month";

const GROUPS: { id: GroupBy; label: string }[] = [
  { id: "phase", label: "Phases" },
  { id: "task", label: "Tasks" },
  { id: "tag", label: "Tags" },
  { id: "person", label: "People" },
];
/** Pixels per day at each scale. */
const ZOOMS: { id: Zoom; label: string; px: number }[] = [
  { id: "day", label: "Days", px: 34 },
  { id: "week", label: "Weeks", px: 11 },
  { id: "month", label: "Months", px: 3.2 },
];
const DAY = 86_400_000;
const ROW = 36;

interface Props {
  projectId: string;
  view: TrackerView;
  ops: TrackerOps;
  /** The task open in the panel, highlighted. */
  openTask?: string | null;
  onOpenTask: (id: string) => void;
  onError: (err: unknown) => void;
}

/** A task being dragged over the chart: an undated chip, or a bar being moved. */
interface DragState {
  /** A task id, or the ids of every dated task in a group being moved together. */
  id: string;
  group?: string[];
  /** Days between the pointer and the task's start, so a bar keeps its grip point. */
  offset: number;
  /** Length in days (a week for a task with no dates yet). */
  length: number;
}

interface Span {
  id: string;
  task: Task;
  /** Day indexes from the epoch, inclusive. Null: undated. */
  from: number | null;
  to: number | null;
  category: Category;
  /** 0..1: checklist items done, or the task's own state. */
  progress: number;
  /** What the progress number means, for the tooltip. */
  progressText: string;
}

interface Group {
  key: string;
  label: string;
  icon?: "folder" | "tag" | "users" | "check";
  spans: Span[];
  from: number | null;
  to: number | null;
  done: number;
  total: number;
}

const dayOf = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00`) / DAY);
const dayOfMs = (ms: number) => Math.floor(ms / DAY);

const todayDay = () => dayOfMs(Date.now() - new Date().getTimezoneOffset() * 60_000);

function spanOf(view: TrackerView, id: string, today: number): Span {
  const task = view.tasks.get(id)!;
  const category = view.category(id);
  const due = task.due ? dayOf(task.due) : null;
  const start = task.start ? dayOf(task.start) : null;
  let from: number | null = start;
  let to: number | null = due;
  // Only a due date: the bar is that day, not a stretch back to when it was created.
  if (from === null && to !== null) from = to;
  if (to === null && from !== null) to = category === "done" ? from : Math.max(from, today);
  if (from !== null && to !== null && to < from) to = from;

  const list = view.checklist(id);
  let progress: number;
  let progressText: string;
  if (category === "done") {
    progress = 1;
    progressText = "Done";
  } else if (list) {
    progress = list.done / list.total;
    progressText = `${list.done} of ${list.total} checklist items done`;
  } else if (category === "doing" && from !== null && to !== null && to > from) {
    progress = Math.max(0.05, Math.min(1, (today - from) / (to - from)));
    progressText = `In progress, ${Math.max(0, Math.min(today, to) - from)} of ${to - from} days gone`;
  } else {
    progress = 0;
    progressText = category === "doing" ? "In progress" : "To do";
  }
  return { id, task, from, to, category, progress, progressText };
}

function groupOf(key: string, label: string, spans: Span[], icon?: Group["icon"], window?: { start: string; end: string }): Group {
  const dated = spans.filter((s) => s.from !== null);
  // A phase with a planned window is drawn as exactly that window; otherwise a
  // group spans its tasks.
  const planned = window?.start && window?.end;
  const froms = planned ? [dayOf(window!.start)] : dated.map((s) => s.from!);
  const tos = planned ? [dayOf(window!.end)] : dated.map((s) => s.to!);
  return {
    key,
    label,
    icon,
    spans: [...spans].sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity) || a.task.number - b.task.number),
    from: froms.length ? Math.min(...froms) : null,
    to: tos.length ? Math.max(...tos) : null,
    done: spans.filter((s) => s.category === "done").length,
    total: spans.length,
  };
}

function buildGroups(view: TrackerView, ids: string[], by: GroupBy, today: number): Group[] {
  const spans = ids.map((id) => spanOf(view, id, today));
  if (by === "task") return [groupOf("all", "Tasks", spans)];
  if (by === "phase") {
    const out = view.phases.map((p) => groupOf(`phase:${p.id}`, p.name || "Untitled phase", spans.filter((s) => s.task.phase === p.id), "folder", { start: p.start ?? "", end: p.end ?? "" }));
    const none = spans.filter((s) => !s.task.phase || !view.phases.some((p) => p.id === s.task.phase));
    if (none.length) out.push(groupOf("phase:", "No phase", none, "folder"));
    return out;
  }
  if (by === "tag") {
    const tags = [...new Set(spans.flatMap((s) => s.task.tags))].sort();
    const out = tags.map((t) => groupOf(`tag:${t}`, t, spans.filter((s) => s.task.tags.includes(t)), "tag"));
    const none = spans.filter((s) => s.task.tags.length === 0);
    if (none.length) out.push(groupOf("tag:", "Untagged", none, "tag"));
    return out;
  }
  const people = [...new Set(spans.map((s) => s.task.assignee.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const out = people.map((p) => groupOf(`person:${p}`, p, spans.filter((s) => s.task.assignee.trim() === p), "users"));
  const none = spans.filter((s) => !s.task.assignee.trim());
  if (none.length) out.push(groupOf("person:", "Unassigned", none, "users"));
  return out;
}

const isoOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const utc = (day: number) => new Date(day * DAY);
const monthStart = (day: number, shiftMonths = 0) => {
  const d = utc(day);
  return dayOfMs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + shiftMonths, 1));
};

/**
 * The default time frame: one unit of the scale before the earliest task and
 * after the latest. Days: a day each side. Weeks: a week. Months: the whole
 * month before and after. With nothing dated, a few units around today.
 */
function autoRange(spans: Span[], groups: Group[], zoom: Zoom, today: number): { first: number; last: number } {
  const dated: { from: number; to: number }[] = [
    ...spans.filter((s) => s.from !== null).map((s) => ({ from: s.from!, to: s.to! })),
    ...groups.filter((g) => g.from !== null).map((g) => ({ from: g.from!, to: g.to! })),
  ];
  if (!dated.length) {
    if (zoom === "day") return { first: today - 7, last: today + 7 };
    if (zoom === "week") return { first: today - 28, last: today + 28 };
    return { first: monthStart(today, -1), last: monthStart(today, 2) - 1 };
  }
  const min = Math.min(...dated.map((s) => s.from));
  const max = Math.max(...dated.map((s) => s.to));
  if (zoom === "day") return { first: min - 1, last: max + 1 };
  if (zoom === "week") return { first: min - 7, last: max + 7 };
  return { first: monthStart(min, -1), last: monthStart(max, 2) - 1 };
}

interface Filters {
  /** Key prefix, or "" for all. */
  key: string;
  /** Priority, or "" for any. */
  priority: Priority | "";
  /** A time frame set by hand (ISO dates), or null for the automatic one. */
  range: { from: string; to: string } | null;
}

const NO_FILTERS: Filters = { key: "", priority: "", range: null };

function load<T>(key: string, fallback: T, ok: (v: unknown) => boolean): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function Gantt({ projectId, view, ops, openTask, onOpenTask, onError }: Props) {
  const [by, setBy] = useState<GroupBy>(() => load(`gantt:${projectId}:by`, "phase", (v) => GROUPS.some((g) => g.id === v)));
  const [zoom, setZoom] = useState<Zoom>(() => load(`gantt:${projectId}:zoom`, "week", (v) => ZOOMS.some((z) => z.id === v)));
  const [open, setOpen] = useState<Set<string>>(() => new Set(load<string[]>(`gantt:${projectId}:open`, [], Array.isArray)));
  const [filters, setFilters] = useState<Filters>(() =>
    load<Filters>(`gantt:${projectId}:filters`, NO_FILTERS, (v) => typeof v === "object" && v !== null && "key" in v && "priority" in v && "range" in v),
  );
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const corner = useRef<HTMLDivElement>(null);
  const today = todayDay();
  const canEdit = useCanEdit();
  const [drag, setDrag] = useState<DragState | null>(null);
  // Dragging a bar's edge: the bar is drawn with these dates until the pointer is released.
  const [resize, setResize] = useState<{ key: string; from: number; to: number } | null>(null);
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const setFilter = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  useEffect(() => {
    try {
      localStorage.setItem(`gantt:${projectId}:by`, JSON.stringify(by));
      localStorage.setItem(`gantt:${projectId}:zoom`, JSON.stringify(zoom));
      localStorage.setItem(`gantt:${projectId}:open`, JSON.stringify([...open]));
      localStorage.setItem(`gantt:${projectId}:filters`, JSON.stringify(filters));
    } catch {
      // storage unavailable: the choice lasts for this session
    }
  }, [projectId, by, zoom, open, filters]);

  // Which tasks are on the chart: by key and priority.
  const prefixes = view.prefixes();
  const keyFilter = prefixes.includes(filters.key) ? filters.key : "";
  const ids = useMemo(
    () =>
      [...view.tasks.keys()].filter((id) => {
        if (keyFilter && view.prefixOf(id) !== keyFilter) return false;
        if (filters.priority && (view.tasks.get(id)!.priority || "none") !== filters.priority) return false;
        return true;
      }),
    [view, keyFilter, filters.priority],
  );
  const groups = useMemo(() => buildGroups(view, ids, by, today), [view, ids, by, today]);
  const zoomDef = ZOOMS.find((x) => x.id === zoom)!;
  // The chart's available width, so a short time frame stretches to fill the window.
  const root = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The axis: the time frame set by hand, or one unit around the dated tasks.
  const allSpans = groups.flatMap((g) => g.spans);
  const auto = autoRange(allSpans, groups, zoom, today);
  let { first, last } = auto;
  if (filters.range) {
    const a = dayOf(filters.range.from);
    const b = dayOf(filters.range.to);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      first = Math.min(a, b);
      last = Math.max(a, b);
    }
  }
  // The frame moves in whole units of the scale: Monday to Sunday in Weeks,
  // first to last of the month in Months.
  if (zoom === "week") {
    first -= (utc(first).getUTCDay() + 6) % 7;
    last += (7 - utc(last).getUTCDay()) % 7;
  } else if (zoom === "month") {
    first = monthStart(first);
    last = monthStart(last, 1) - 1;
  }
  const days = last - first + 1;
  // At least the scale's pixels per day; more when the frame is narrower than the window.
  const labelW = corner.current?.offsetWidth || 256;
  const z = { ...zoomDef, px: Math.max(zoomDef.px, avail ? (avail - labelW - 1) / days : 0) };
  const x = (day: number) => (day - first) * z.px;
  const width = days * z.px;
  const inRange = (d: number) => d >= first && d <= last;

  // Column headers: months across the top, then days or weeks. A month or week
  // cut off by the edge of the frame gets a short label, or none if it's a sliver.
  const months: { label: string; left: number; width: number }[] = [];
  for (let m = monthStart(first); m <= last; m = monthStart(m, 1)) {
    const from = Math.max(first, m);
    const to = Math.min(last + 1, monthStart(m, 1));
    const w = (to - from) * z.px;
    const date = utc(m);
    const label =
      w >= 120
        ? date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
        : w >= 64
          ? date.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" })
          : w >= 30
            ? date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })
            : "";
    months.push({ label, left: x(from), width: w });
  }
  const ticks: { label: string; left: number; width: number; weekend?: boolean }[] = [];
  if (zoom === "day") {
    for (let d = first; d <= last; d++) {
      const dow = utc(d).getUTCDay();
      ticks.push({ label: `${utc(d).getUTCDate()}`, left: x(d), width: z.px, weekend: dow === 0 || dow === 6 });
    }
  } else if (zoom === "week") {
    // Monday on or before the first day, then every Monday.
    const dow = (utc(first).getUTCDay() + 6) % 7;
    for (let m = first - dow; m <= last; m += 7) {
      const from = Math.max(first, m);
      const to = Math.min(last + 1, m + 7);
      ticks.push({ label: to - from >= 3 ? `${utc(from).getUTCDate()}` : "", left: x(from), width: (to - from) * z.px });
    }
  }

  // Scroll so today sits a third of the way in, on first paint and when the zoom changes.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = inRange(today) ? Math.max(0, x(today) - el.clientWidth / 3) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, by, first, last]);

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const undated = groups.flatMap((g) => g.spans.filter((s) => s.from === null));
  const undatedUnique = [...new Map(undated.map((s) => [s.id, s])).values()];
  const flat = by === "task";

  // Rows in order: a group, then its tasks when open (always, in Tasks mode).
  // Tasks that lie entirely outside the frame are left out and counted.
  const visible = (s: Span) => s.from !== null && s.to! >= first && s.from <= last;
  const outside = new Set(allSpans.filter((s) => s.from !== null && !visible(s)).map((s) => s.id));
  const rows: ({ kind: "group"; group: Group } | { kind: "task"; span: Span; depth: number })[] = [];
  for (const g of groups) {
    if (!flat) rows.push({ kind: "group", group: g });
    if (flat || open.has(g.key)) for (const s of g.spans) if (visible(s)) rows.push({ kind: "task", span: s, depth: flat ? 0 : 1 });
  }

  const fmt = (day: number) => utc(day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const filtered = keyFilter !== "" || filters.priority !== "";

  // Dropping on the chart: the day under the pointer becomes the task's start.
  const dayAt = (clientX: number): number | null => {
    const g = grid.current;
    if (!g) return null;
    const left = g.getBoundingClientRect().left + (corner.current?.offsetWidth ?? 0);
    const d = first + Math.floor((clientX - left) / z.px);
    return d < first || d > last ? null : d;
  };
  const startDrag = (e: React.DragEvent, id: string, from: number | null, to: number | null, group?: string[]) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    const pointer = dayAt(e.clientX);
    const offset = from !== null && pointer !== null ? pointer - from : 0;
    setDrag({ id, group, offset, length: from !== null && to !== null ? to - from : 6 });
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const d = dayAt(e.clientX);
    const start = d === null ? null : Math.max(first, Math.min(last, d - drag.offset));
    if (start !== hoverDay) setHoverDay(start);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const d = drag;
    const start = hoverDay;
    setDrag(null);
    setHoverDay(null);
    if (!d || start === null) return;
    if (d.group) {
      // The whole group slides by the same number of days.
      const g = groups.find((x) => x.key === d.id);
      const phase = d.id.startsWith("phase:") ? d.id.slice(6) : undefined;
      if (g && g.from !== null && start !== g.from) ops.shiftTasks(d.group, start - g.from, phase || undefined).catch(onError);
      return;
    }
    ops.update(d.id, { start: isoOf(start), due: isoOf(start + d.length) }).catch(onError);
  };
  /**
   * Start resizing a task or phase bar from one edge. Pointer events rather
   * than native drag and drop, so the bar follows the pointer exactly.
   */
  const startResize = (
    e: React.PointerEvent,
    key: string,
    side: "left" | "right",
    from: number,
    to: number,
    commit: (from: number, to: number) => void,
    bounds?: { lo: number | null; hi: number | null },
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const g = grid.current;
    if (!g) return;
    const left = g.getBoundingClientRect().left + (corner.current?.offsetWidth ?? 0);
    const dayUnder = (clientX: number) => first + Math.floor((clientX - left) / z.px);
    let cur = { from, to };
    setResize({ key, ...cur });
    const move = (ev: PointerEvent) => {
      let d = Math.max(first, Math.min(last, dayUnder(ev.clientX)));
      // A task stays inside its phase's planned window.
      if (bounds?.lo !== null && bounds?.lo !== undefined) d = Math.max(bounds.lo, d);
      if (bounds?.hi !== null && bounds?.hi !== undefined) d = Math.min(bounds.hi, d);
      cur = side === "left" ? { from: Math.min(d, to), to } : { from, to: Math.max(d, from) };
      setResize({ key, ...cur });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResize(null);
      if (cur.from !== from || cur.to !== to) commit(cur.from, cur.to);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The planned window of a task's phase, as day numbers. */
  const phaseBounds = (phaseId: string) => {
    const p = view.phases.find((x) => x.id === phaseId);
    return { lo: p?.start ? dayOf(p.start) : null, hi: p?.end ? dayOf(p.end) : null };
  };

  const endDrag = () => {
    setDrag(null);
    setHoverDay(null);
  };

  return (
    <div className="gantt" ref={root}>
      <div className="gantt-bar">
        <div className="segmented" role="radiogroup" aria-label="Group by">
          {GROUPS.map((g) => (
            <button key={g.id} role="radio" aria-checked={by === g.id} aria-pressed={by === g.id} onClick={() => setBy(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="gantt-bar-right">
          <select className="field gantt-select" aria-label="Key" value={keyFilter} onChange={(e) => setFilter({ key: e.target.value })}>
            <option value="">All keys</option>
            {prefixes.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select className="field gantt-select" aria-label="Priority" value={filters.priority} onChange={(e) => setFilter({ priority: e.target.value as Priority | "" })}>
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="gantt-bar gantt-bar-2">
        <div className="gantt-range">
          <label>
            <span className="muted small">From</span>
            <input
              className="field gantt-date"
              type="date"
              value={isoOf(first)}
              step={zoom === "week" ? 7 : undefined}
              title={zoom === "week" ? "Weeks start on Monday" : zoom === "month" ? "Whole months" : undefined}
              onChange={(e) => e.target.value && setFilter({ range: { from: e.target.value, to: isoOf(last) } })}
            />
          </label>
          <label>
            <span className="muted small">To</span>
            <input
              className="field gantt-date"
              type="date"
              value={isoOf(last)}
              step={zoom === "week" ? 7 : undefined}
              title={zoom === "week" ? "Weeks end on Sunday" : zoom === "month" ? "Whole months" : undefined}
              onChange={(e) => e.target.value && setFilter({ range: { from: isoOf(first), to: e.target.value } })}
            />
          </label>
          {filters.range && (
            <button className="ghost" title={`Back to ${fmt(auto.first)} to ${fmt(auto.last)}`} onClick={() => setFilter({ range: null })}>
              Auto
            </button>
          )}
        </div>
        <div className="gantt-bar-right">
          <div className="segmented" role="radiogroup" aria-label="Scale">
            {ZOOMS.map((o) => (
              <button key={o.id} role="radio" aria-checked={zoom === o.id} aria-pressed={zoom === o.id} onClick={() => setZoom(o.id)}>
                {o.label}
              </button>
            ))}
          </div>
          <button
            className="ghost"
            disabled={!inRange(today)}
            title={inRange(today) ? undefined : "Today is outside the time frame"}
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTo({ left: Math.max(0, x(today) - el.clientWidth / 3), behavior: "smooth" });
            }}
          >
            Today
          </button>
        </div>
      </div>

      {rows.length === 0 && (
        <p className="muted gantt-empty">
          {view.tasks.size === 0
            ? "No tasks yet."
            : filtered && ids.length === 0
              ? "No tasks match these filters."
              : outside.size
                ? `No tasks in this time frame (${outside.size} outside it).`
                : canEdit
                  ? "No dated tasks yet. Drag one from the list below onto the chart, or give it a start or due date."
                  : "No dated tasks. Give a task a start or due date and it appears here."}
        </p>
      )}
      {(rows.length > 0 || (canEdit && undatedUnique.length > 0)) && (
        <div className="gantt-scroll" ref={scroller} data-dragging={drag ? true : undefined}>
          <div
            className="gantt-grid"
            ref={grid}
            style={{ gridTemplateColumns: `16rem ${width}px`, ["--row" as string]: `${ROW}px` }}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={endDrag}
            onDragLeave={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              if (e.clientX <= r.left || e.clientX >= r.right || e.clientY <= r.top || e.clientY >= r.bottom) setHoverDay(null);
            }}
          >
            {/* header */}
            <div className="gantt-corner" ref={corner} />
            <div className="gantt-head" style={{ width }}>
              <div className="gantt-months">
                {months.map((m) => (
                  <span key={m.left} style={{ left: m.left, width: m.width }}>
                    {m.label}
                  </span>
                ))}
              </div>
              <div className="gantt-ticks">
                {ticks.map((t) => (
                  <span key={t.left} style={{ left: t.left, width: t.width }} data-weekend={t.weekend || undefined}>
                    {t.label}
                  </span>
                ))}
              </div>
            </div>

            {/* rows */}
            {rows.map((r) =>
              r.kind === "group" ? (
                <GroupRow
                  key={r.group.key}
                  group={r.group}
                  open={open.has(r.group.key)}
                  onToggle={() => toggle(r.group.key)}
                  x={x}
                  px={z.px}
                  width={width}
                  fmt={fmt}
                  draggable={canEdit && r.group.from !== null}
                  dragging={drag?.id === r.group.key}
                  live={resize?.key === r.group.key ? resize : null}
                  onResize={
                    canEdit && r.group.key.startsWith("phase:") && r.group.from !== null
                      ? (e, side) =>
                          startResize(e, r.group.key, side, r.group.from!, r.group.to!, (from, to) =>
                            ops.setPhaseDates(r.group.key.slice(6), { start: isoOf(from), end: isoOf(to) }).catch(onError),
                          )
                      : undefined
                  }
                  onDragStart={(e) =>
                    startDrag(
                      e,
                      r.group.key,
                      r.group.from,
                      r.group.to,
                      r.group.spans.filter((sp) => sp.from !== null && (sp.task.start || sp.task.due)).map((sp) => sp.id),
                    )
                  }
                />
              ) : (
                <TaskRow
                  key={`${r.span.id}:${r.depth}`}
                  span={r.span}
                  depth={r.depth}
                  view={view}
                  x={x}
                  px={z.px}
                  width={width}
                  fmt={fmt}
                  open={openTask === r.span.id}
                  draggable={canEdit}
                  dragging={drag?.id === r.span.id}
                  live={resize?.key === r.span.id ? resize : null}
                  onResize={
                    canEdit
                      ? (e, side) =>
                          startResize(
                            e,
                            r.span.id,
                            side,
                            r.span.from!,
                            r.span.to!,
                            (from, to) => ops.update(r.span.id, { start: isoOf(from), due: isoOf(to) }).catch(onError),
                            phaseBounds(r.span.task.phase),
                          )
                      : undefined
                  }
                  onDragStart={(e) => startDrag(e, r.span.id, r.span.from, r.span.to)}
                  onOpen={() => onOpenTask(r.span.id)}
                />
              ),
            )}
            {/* where the dragged task would land */}
            {drag && hoverDay !== null && (
              <div
                className="gantt-ghost"
                style={{ left: `calc(16rem + ${x(hoverDay)}px)`, width: Math.max(z.px, (drag.length + 1) * z.px) }}
                title={`${fmt(hoverDay)} to ${fmt(hoverDay + drag.length)}`}
              >
                <span>{fmt(hoverDay)}</span>
              </div>
            )}

            {/* today, over everything */}
            {inRange(today) && <div className="gantt-today" style={{ left: `calc(16rem + ${x(today)}px)` }} title={`Today, ${fmt(today)}`} />}
            {zoom === "day" &&
              ticks.filter((t) => t.weekend).map((t) => <div key={`w${t.left}`} className="gantt-weekend" style={{ left: `calc(16rem + ${t.left}px)`, width: t.width }} />)}
          </div>
        </div>
      )}

      {(undatedUnique.length > 0 || outside.size > 0) && (
        <details className="gantt-undated" open={rows.length === 0}>
          <summary className="small muted">
            {[
              undatedUnique.length ? `${undatedUnique.length} ${undatedUnique.length === 1 ? "task" : "tasks"} without dates` : "",
              outside.size ? `${outside.size} outside the time frame` : "",
            ]
              .filter(Boolean)
              .join(", ")}
          </summary>
          <div className="gantt-undated-list">
            {[...new Map([...undatedUnique, ...allSpans.filter((s) => outside.has(s.id))].map((s) => [s.id, s])).values()].map((s) => (
              <button
                key={s.id}
                className="gantt-chip"
                data-category={s.category}
                data-open={openTask === s.id || undefined}
                draggable={canEdit}
                onDragStart={(e) => startDrag(e, s.id, null, null)}
                onDragEnd={endDrag}
                onClick={() => onOpenTask(s.id)}
                title={s.from !== null ? `${fmt(s.from)} to ${fmt(s.to!)}` : canEdit ? "No dates. Drag onto the chart to schedule a week." : "No dates"}
              >
                <span className="task-key">{view.key(s.id)}</span>
                {s.task.title || "Untitled task"}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function GroupRow({
  group: g,
  open,
  onToggle,
  x,
  px,
  width,
  fmt,
  draggable,
  dragging,
  onDragStart,
  live,
  onResize,
}: {
  group: Group;
  open: boolean;
  onToggle: () => void;
  x: (d: number) => number;
  px: number;
  width: number;
  fmt: (d: number) => string;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  /** Dates while an edge is being dragged. */
  live: { from: number; to: number } | null;
  /** Set for a phase with a planned window: its edges can be dragged. */
  onResize?: (e: React.PointerEvent, side: "left" | "right") => void;
}) {
  const frac = g.total ? g.done / g.total : 0;
  const dated = g.spans.filter((s) => s.from !== null).length;
  const gf = live?.from ?? g.from;
  const gt = live?.to ?? g.to;
  return (
    <>
      <button className="gantt-label gantt-label-group" aria-expanded={open} onClick={onToggle}>
        <Icon name="chevron" className={open ? "chev open" : "chev"} />
        {g.icon && <Icon name={g.icon} />}
        <span className="gantt-label-text">{g.label}</span>
        <span className="gantt-count">
          {g.done}/{g.total}
        </span>
      </button>
      <div className="gantt-lane" style={{ width }}>
        {gf !== null && gt !== null ? (
          <div
            className="gantt-bar-group"
            data-dragging={dragging || undefined}
            data-resizing={live ? true : undefined}
            draggable={draggable}
            onDragStart={onDragStart}
            style={{ left: x(gf), width: Math.max(px, (gt - gf + 1) * px) }}
            title={`${g.label}: ${fmt(gf)} to ${fmt(gt)}. ${g.done} of ${g.total} done${dated < g.total ? `, ${g.total - dated} without dates` : ""}.${draggable ? " Drag to move every task in it." : ""}${onResize ? " Drag an edge to change its dates." : ""}`}
          >
            <span className="gantt-fill" style={{ width: `${Math.round(frac * 100)}%` }} />
            {onResize && <Handles onResize={onResize} />}
          </div>
        ) : (
          <span className="gantt-nodates muted small">No dates yet</span>
        )}
        {gf !== null && gt !== null && (
          <span className="gantt-after" style={{ left: x(gf) + Math.max(px, (gt - gf + 1) * px) + 6 }}>
            {live ? `${fmt(gf)} to ${fmt(gt)}` : `${Math.round(frac * 100)}%`}
          </span>
        )}
      </div>
    </>
  );
}

function TaskRow({
  span: s,
  depth,
  view,
  x,
  px,
  width,
  fmt,
  open,
  draggable,
  dragging,
  onDragStart,
  live,
  onResize,
  onOpen,
}: {
  span: Span;
  depth: number;
  view: TrackerView;
  x: (d: number) => number;
  px: number;
  width: number;
  fmt: (d: number) => string;
  open: boolean;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  live: { from: number; to: number } | null;
  onResize?: (e: React.PointerEvent, side: "left" | "right") => void;
  onOpen: () => void;
}) {
  const from = live?.from ?? s.from!;
  const to = live?.to ?? s.to!;
  const late = s.category !== "done" && s.task.due && dayOf(s.task.due) < todayDay();
  return (
    <>
      <button className="gantt-label" data-open={open || undefined} style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }} onClick={onOpen} title={s.task.title}>
        <span className="task-key">{view.key(s.id)}</span>
        <span className="gantt-label-text">{s.task.title || "Untitled task"}</span>
      </button>
      <div className="gantt-lane" style={{ width }}>
        <button
          className="gantt-bar-task"
          data-category={s.category}
          data-late={late || undefined}
          data-open={open || undefined}
          data-dragging={dragging || undefined}
          data-resizing={live ? true : undefined}
          draggable={draggable}
          onDragStart={onDragStart}
          style={{ left: x(from), width: Math.max(px, (to - from + 1) * px) }}
          onClick={onOpen}
          title={`${view.key(s.id)} ${s.task.title}: ${fmt(from)} to ${fmt(to)}. ${s.progressText}${late ? ". Overdue" : ""}.${draggable ? " Drag to move, or drag an edge to change its dates." : ""}`}
        >
          <span className="gantt-fill" style={{ width: `${Math.round(s.progress * 100)}%` }} />
          {onResize && <Handles onResize={onResize} />}
        </button>
        {(s.task.assignee || live) && (
          <span className="gantt-after" style={{ left: x(from) + Math.max(px, (to - from + 1) * px) + 6 }}>
            {live ? `${fmt(from)} to ${fmt(to)}` : s.task.assignee}
          </span>
        )}
      </div>
    </>
  );
}


/** The two edge grips on a bar. */
function Handles({ onResize }: { onResize: (e: React.PointerEvent, side: "left" | "right") => void }) {
  return (
    <>
      <span className="gantt-handle" data-side="left" title="Drag to change the start" onPointerDown={(e) => onResize(e, "left")} onClick={(e) => e.stopPropagation()} />
      <span className="gantt-handle" data-side="right" title="Drag to change the end" onPointerDown={(e) => onResize(e, "right")} onClick={(e) => e.stopPropagation()} />
    </>
  );
}
