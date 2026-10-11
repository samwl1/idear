import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorkspaceSession } from "../lib/session";
import { useItemLookup } from "../lib/useItemLookup";
import { BACKLOG, DEFAULT_PREFIX, TrackerOps, TrackerView, cleanPrefix, defaultPrefix, type NewTask, type TrackerDoc } from "./model";
import { TaskDefaultsMenu, templateOf, tokenContext, type TaskDefaults } from "./TaskDefaults";
import { Gantt } from "./Gantt";
import { expand } from "./tokens";
import { Kanban } from "./Kanban";
import { Backlog } from "./Backlog";
import { Roadmap } from "./Roadmap";
import { TaskDrawer } from "./TaskDrawer";
import { Icon } from "../components/Icon";
import { RepoButton } from "../components/GitButton";
import { PinButton } from "../components/PinnedNav";
import { PopOutButton } from "../components/PopOutButton";
import { isPinned, usePins } from "../lib/pins";
import { useCanEdit } from "../lib/access";

type Tab = "board" | "backlog" | "phases" | "roadmap";
const TABS: { id: Tab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "backlog", label: "Backlog" },
  { id: "phases", label: "Phases" },
  { id: "roadmap", label: "Roadmap" },
];

interface Props {
  session: WorkspaceSession;
  id: string;
  initial: TrackerDoc;
  /** Task to open on arrival, e.g. from a view. */
  task?: string;
  /** Tab to show on arrival, e.g. the roadmap when a phase link is opened. */
  tab?: Tab;
  /** Changes on every open, so the task or tab applies again. */
  at?: number;
  /** The title block; gets what sits beside the title (location, pin, Git). */
  header: (aside: ReactNode) => ReactNode;
  onOpenItem: (id: string) => void;
  onError: (err: unknown) => void;
}

export function TrackerPage({ session, id, initial, task, tab: tabProp, at, header, onOpenItem, onError }: Props) {
  const [doc, setDoc] = useState<TrackerDoc>(initial);
  const [tab, setTab] = useState<Tab>(() => {
    if (tabProp) return tabProp;
    try {
      return (localStorage.getItem(`tab:${id}`) as Tab) || "board";
    } catch {
      return "board";
    }
  });
  const [openTask, setOpenTask] = useState<string | null>(task ?? null);
  // The task drawer can grow to fill the page; remembered per device.
  const [drawerWide, setDrawerWide] = useState<boolean>(() => {
    try {
      return localStorage.getItem("task-drawer") === "wide";
    } catch {
      return false;
    }
  });
  const setWide = (wide: boolean) => {
    setDrawerWide(wide);
    try {
      localStorage.setItem("task-drawer", wide ? "wide" : "narrow");
    } catch {
      // storage unavailable
    }
  };
  const canEdit = useCanEdit();
  const pins = usePins(session.id);
  const lookup = useItemLookup(session, onError);
  const [hot, setHot] = useState<TaskDefaults>(() => loadDefaults(id, initial));

  useEffect(() => {
    try {
      localStorage.setItem(`hot:${id}`, JSON.stringify(hot));
    } catch {
      // storage unavailable: settings last for this session only
    }
  }, [id, hot]);

  // Follow the doc as it changes.
  useEffect(
    () =>
      session.subscribe(() => {
        const latest = session.peekItem<TrackerDoc>(id);
        if (latest) setDoc(latest);
      }),
    [session, id],
  );

  useEffect(() => {
    if (task) setOpenTask(task);
    if (tabProp) setTab(tabProp);
  }, [task, tabProp, at]);

  useEffect(() => {
    try {
      localStorage.setItem(`tab:${id}`, tab);
    } catch {
      // storage unavailable: the tab just won't be remembered
    }
  }, [id, tab]);

  const view = useMemo(() => new TrackerView(doc), [doc]);

  // Until a key is chosen by hand, a project with no tasks keys them after its name.
  const title = String(doc.title);
  useEffect(() => {
    if (hot.customPrefix || view.tasks.size > 0) return;
    const p = doc.prefix || defaultPrefix(title);
    if (p !== hot.prefix) setHot((h) => ({ ...h, prefix: p }));
  }, [title, doc.prefix, view.tasks.size, hot.customPrefix, hot.prefix]);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Ops read the freshest doc, so several creates in a row (Create 5) never reuse a key number.
  const ops = useMemo(
    () =>
      new TrackerOps(session, id, () => {
        const latest = session.peekItem<TrackerDoc>(id);
        return latest && latest !== viewRef.current.doc ? new TrackerView(latest) : viewRef.current;
      }),
    [session, id],
  );

  // Subtasks from older versions become checklist items on their parent, once.
  const converted = useRef(false);
  useEffect(() => {
    if (view.nested.length && !converted.current && canEdit) {
      converted.current = true;
      ops.convertNested().catch(onError);
    }
  }, [view, ops, onError, canEdit]);

  /** The defaults expanded for `count` tasks against the latest project state. */
  const expanded = (count: number) => {
    const latest = session.peekItem<TrackerDoc>(id);
    const v = latest ? new TrackerView(latest) : viewRef.current;
    return expand(templateOf(hot), tokenContext(v, hot.prefix), count);
  };

  /**
   * Every new task starts from the defaults; `init` overrides them. An empty
   * title takes the next name in the series, and tags and phase follow its tokens.
   */
  const create = (raw: NewTask) => {
    const x = expanded(1)[0];
    // "SYNC: Own relay" typed into an Add task box picks the key for that task.
    const init = { ...raw };
    const keyed = /^([A-Za-z][A-Za-z0-9]{0,7}):\s+(.+)$/.exec(init.title ?? "");
    if (keyed) {
      init.prefix = keyed[1].toUpperCase();
      init.title = keyed[2];
    }
    return ops.createTask({
      prefix: cleanPrefix(hot.prefix),
      tags: x.tags,
      priority: hot.priority,
      phaseName: x.phase,
      assignee: hot.assignee,
      column: hot.column || undefined,
      due: x.due,
      ...init,
      title: init.title?.trim() ? init.title : x.title,
    });
  };

  /** New task: created from the defaults and opened right away. */
  const newTask = async () => {
    try {
      setOpenTask(await create({}));
    } catch (e) {
      onError(e);
    }
  };

  /** A batch, worked out up front so series and lists stay in order. */
  const createMany = async (count: number) => {
    const batch = expanded(count);
    try {
      for (const x of batch) {
        await ops.createTask({
          prefix: cleanPrefix(hot.prefix),
          tags: x.tags,
          priority: hot.priority,
          phaseName: x.phase,
          assignee: hot.assignee,
          column: hot.column || undefined,
          due: x.due,
          title: x.title,
        });
      }
    } catch (e) {
      onError(e);
    }
  };

  /** What a column's Add task box offers when left empty. */
  const nextName = hot.name.trim() ? expand(templateOf(hot), tokenContext(view, hot.prefix), 1)[0].title : "";

  return (
    <article className="tracker-page">
      <div className="tracker-head">
        <div className="tracker-head-main">
          {header(
            <>
              <PinButton workspace={session.id} pin={{ kind: "node", id }} pinned={isPinned(pins, { kind: "node", id })} />
              <PopOutButton session={session} id={id} />
              <RepoButton repos={doc.repos ?? []} onChange={canEdit ? (repos) => ops.setRepos(repos).catch(onError) : undefined} onError={onError} align="left" withLabel />
            </>,
          )}
        </div>
        <div className="tracker-bar">
          <div className="tabs" role="tablist" aria-label="Project views">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className="tab"
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {canEdit && (
            <span className="tracker-bar-right">
              <TaskDefaultsMenu view={view} defaults={hot} onChange={setHot} onCreate={createMany} onReset={() => setHot(blankDefaults())} />
              <button className="primary" onClick={newTask}>
                <Icon name="plus" /> New task
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="tracker-body" role="tabpanel">
        {tab === "board" && (
          <Kanban workspace={session.id} view={view} ops={ops} openTask={openTask} onOpenTask={setOpenTask} onError={onError} />
        )}
        {tab === "backlog" && <Backlog workspace={session.id} view={view} ops={ops} openTask={openTask} onOpenTask={setOpenTask} onError={onError} />}
        {tab === "phases" && (
          <Roadmap session={session} view={view} ops={ops} create={create} nextName={nextName} openTask={openTask} onOpenTask={setOpenTask} onError={onError} />
        )}
        {tab === "roadmap" && <Gantt projectId={id} view={view} ops={ops} openTask={openTask} onOpenTask={setOpenTask} onError={onError} />}
      </div>

      {openTask && view.tasks.has(openTask) && (
        <TaskDrawer
          key={openTask}
          session={session}
          view={view}
          ops={ops}
          taskId={openTask}
          lookup={lookup}
          onOpenTask={setOpenTask}
          onOpenItem={onOpenItem}
          onClose={() => setOpenTask(null)}
          wide={drawerWide}
          onWide={setWide}
          onError={onError}
        />
      )}
    </article>
  );
}

/** Nothing set: tasks come out as DEFAULT-n, untitled, in the backlog. */
function blankDefaults(): TaskDefaults {
  return { prefix: DEFAULT_PREFIX, name: "", tags: [], phase: "", priority: "none", assignee: "", due: "", column: BACKLOG, customPrefix: true };
}

function loadDefaults(id: string, doc: TrackerDoc): TaskDefaults {
  const fallback: TaskDefaults = { ...blankDefaults(), prefix: doc.prefix || defaultPrefix(String(doc.title)), customPrefix: false };
  try {
    // Same key the old hot task creation panel used, so its settings carry over.
    const saved = JSON.parse(localStorage.getItem(`hot:${id}`) ?? "null");
    return saved ? { ...fallback, ...saved } : fallback;
  } catch {
    return fallback;
  }
}
