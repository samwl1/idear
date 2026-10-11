import { useContext, useEffect, useRef, useState } from "react";
import { BACKLOG, DEFAULT_PREFIX, PRIORITIES, cleanPrefix, type Priority, type TrackerView } from "./model";
import { batchSize, expand, hasTokens, parseDue, type Template, type TokenContext } from "./tokens";
import { Icon } from "../components/Icon";
import { useAccount } from "../lib/account";
import { NavContext } from "../lib/nav";

/**
 * What every new task starts from, whichever way it's created: the New task
 * button, a column's Add task, or the Create button in this menu. Kept per
 * project on this device.
 */
export interface TaskDefaults {
  prefix: string;
  /** Base name. Repeats get "(2)", "(3)"… Empty: tasks start untitled. */
  name: string;
  tags: string[];
  phase: string; // phase name; a new name creates the phase
  priority: Priority;
  assignee: string;
  /** Due date rule: "2026-10-17", "{date+7}", "+2w", with "every 1w" to space a batch. Empty: none. */
  due: string;
  /** Column id; empty means the first column. */
  column: string;
  /** Set once the key is typed by hand; until then it follows the project name. */
  customPrefix?: boolean;
}

/** Tokens read the project through this. */
export function tokenContext(view: TrackerView, prefix: string): TokenContext {
  const p = cleanPrefix(prefix) || view.doc.prefix || DEFAULT_PREFIX;
  return {
    project: String(view.doc.title || "Untitled project"),
    prefix: p,
    nextNumber: view.nextNumber(p),
    taken: [...view.tasks.values()].map((t) => t.title),
  };
}

/** The defaults as a token template. */
export function templateOf(d: TaskDefaults): Template {
  return { name: d.name, tags: d.tags, phase: d.phase, due: d.due };
}

interface Props {
  view: TrackerView;
  defaults: TaskDefaults;
  onChange: (d: TaskDefaults) => void;
  /** Create `count` tasks from the defaults. */
  onCreate: (count: number) => Promise<unknown>;
  /** Back to a blank slate: key DEFAULT, nothing else set. */
  onReset: () => void;
}

/** A "Defaults" button with a popover: the fields above, plus Create N. */
export function TaskDefaultsMenu({ view, defaults, onChange, onCreate, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(1);
  const [draftTag, setDraftTag] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { account } = useAccount();
  const { openHelp } = useContext(NavContext);
  const set = (patch: Partial<TaskDefaults>) => onChange({ ...defaults, ...patch });

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

  const prefix = cleanPrefix(defaults.prefix);
  const dueRule = parseDue(defaults.due ?? "", tokenContext(view, defaults.prefix));
  const dueLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const size = batchSize(templateOf(defaults), count);
  const listed = size !== Math.max(1, count); // lists decide the count
  const preview = defaults.name.trim() ? expand(templateOf(defaults), tokenContext(view, defaults.prefix), count) : [];
  const tokensInUse = hasTokens(defaults.name) || defaults.tags.some(hasTokens) || hasTokens(defaults.phase) || !!dueRule.every;
  // The phase as it will be created for the first task (tokens filled in).
  const firstPhase = (preview[0]?.phase ?? defaults.phase).trim();
  const phaseIsNew = firstPhase !== "" && !view.phaseByName(firstPhase);
  const summary = [
    prefix,
    defaults.name.trim() ? `“${defaults.name.trim()}”` : null,
    defaults.phase.trim() || null,
    dueRule.base ? `due ${dueRule.base}` : null,
    ...defaults.tags,
  ]
    .filter(Boolean)
    .join(" · ");

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    setDraftTag("");
    if (tag && !defaults.tags.includes(tag)) set({ tags: [...defaults.tags, tag] });
  };

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onCreate(Math.max(1, Math.min(99, count)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="defaults" ref={root}>
      <button className="ghost defaults-btn" aria-expanded={open} title={`New tasks: ${summary}`} onClick={() => setOpen(!open)}>
        <Icon name="sparkle" /> Defaults
      </button>

      {open && (
        <form
          className="defaults-menu"
          aria-label="Task defaults"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <p className="defaults-lead muted small">Every new task starts from these, however you add it.</p>

          <label className="defaults-field">
            <span>Name</span>
            <input
              className="field"
              value={defaults.name}
              placeholder="Untitled"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <p className="defaults-hint muted small">
            {defaults.name.trim() ? (
              <>Next: {preview[0]?.title}. </>
            ) : (
              <>
                <code>#</code> counts up (“Chapter #”), <code>@</code> letters, <code>%</code> roman numerals, <code>{"{a,b,c}"}</code> one task per item,{" "}
                <code>{"{date}"}</code> today.{" "}
              </>
            )}
            <button type="button" className="link-btn" onClick={() => openHelp("tasks", "tokens")}>
              All tokens
            </button>
          </p>

          <div className="defaults-row">
            <label className="defaults-field">
              <span>Key</span>
              <input
                className="field"
                value={defaults.prefix}
                list="defaults-prefixes"
                maxLength={8}
                onChange={(e) => set({ prefix: e.target.value.toUpperCase(), customPrefix: true })}
                onBlur={() => set({ prefix })}
              />
              <datalist id="defaults-prefixes">
                {view.prefixes().map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>
            <label className="defaults-field">
              <span>Column</span>
              <select className="field" value={defaults.column} onChange={(e) => set({ column: e.target.value })}>
                <option value={BACKLOG}>Backlog (off the board)</option>
                {view.columns.map((c, i) => (
                  <option key={c.id} value={i === 0 ? "" : c.id}>
                    {c.name || "Untitled"}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="defaults-row">
            <label className="defaults-field">
              <span>Priority</span>
              <select className="field" value={defaults.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="defaults-field">
              <span>
                Phase{phaseIsNew && <em className="defaults-new"> new</em>}
              </span>
              <input className="field" value={defaults.phase} list="defaults-phases" placeholder="None" onChange={(e) => set({ phase: e.target.value })} />
              <datalist id="defaults-phases">
                {view.phases.map((p) => (
                  <option key={p.id} value={p.name} />
                ))}
              </datalist>
            </label>
          </div>

          <div className="defaults-row">
            <label className="defaults-field">
              <span>Assignee</span>
              <input
                className="field"
                value={defaults.assignee}
                list="defaults-people"
                placeholder="Unassigned"
                onChange={(e) => set({ assignee: e.target.value })}
              />
              <datalist id="defaults-people">
                <option value="@me" />
                {account?.name && <option value={account.name} />}
              </datalist>
            </label>
            <label className="defaults-field">
              <span>
                Due
                {dueRule.invalid && <em className="defaults-new defaults-bad"> not a date</em>}
              </span>
              <input
                className="field"
                value={defaults.due ?? ""}
                list="defaults-dues"
                placeholder="None"
                aria-invalid={dueRule.invalid || undefined}
                onChange={(e) => set({ due: e.target.value })}
              />
              <datalist id="defaults-dues">
                <option value="+7" label="A week from today" />
                <option value="+1m" label="A month from today" />
                <option value="{date+7} every 1w" label="A week apart" />
                <option value="+2w every 2w" label="Two weeks apart" />
              </datalist>
            </label>
          </div>
          <p className="defaults-hint muted small">
            {dueRule.base ? (
              <>
                Due {dueLabel(dueRule.base)}
                {dueRule.every && `, then every ${dueRule.every.n === 1 ? "" : `${dueRule.every.n} `}${({ d: "day", w: "week", m: "month" })[dueRule.every.unit]}${dueRule.every.n === 1 ? "" : "s"}`}.
              </>
            ) : (
              <>
                Due: <code>+7</code> days out, <code>+2w</code>, <code>{"{date+7}"}</code>, or a date. Add <code>every 1w</code> to space a batch.
              </>
            )}
          </p>

          <div className="defaults-field">
            <span id="defaults-tags-label">Tags</span>
            <div className="tags inline" aria-labelledby="defaults-tags-label">
              {defaults.tags.map((t) => (
                <span className="tag" key={t}>
                  {t}
                  <button type="button" aria-label={`Remove tag ${t}`} onClick={() => set({ tags: defaults.tags.filter((x) => x !== t) })}>
                    ×
                  </button>
                </span>
              ))}
              <input
                className="tag-input"
                value={draftTag}
                placeholder={defaults.tags.length ? "" : "None"}
                aria-label="Add tag"
                onChange={(e) => setDraftTag(e.target.value)}
                onBlur={() => addTag(draftTag)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    if (draftTag.trim()) {
                      e.preventDefault();
                      addTag(draftTag);
                    } else if (e.key === ",") e.preventDefault();
                  }
                  if (e.key === "Backspace" && !draftTag && defaults.tags.length) set({ tags: defaults.tags.slice(0, -1) });
                }}
              />
            </div>
          </div>

          {(size > 1 || tokensInUse) && preview.length > 0 && (
            <details className="defaults-preview" open={size <= 12}>
              <summary className="small muted">
                {size === 1 ? "This creates 1 task" : `This creates ${size} tasks`}
                {listed ? " (one per list item)" : ""}
              </summary>
              <ol className="defaults-preview-list">
                {preview.slice(0, 60).map((x, i) => (
                  <li key={i}>
                    <span className="defaults-preview-title">{x.title || "Untitled"}</span>
                    {(x.phase || x.tags.length > 0 || x.due) && (
                      <span className="muted small"> {[x.phase, ...x.tags, x.due ? `due ${dueLabel(x.due)}` : ""].filter(Boolean).join(" · ")}</span>
                    )}
                  </li>
                ))}
                {preview.length > 60 && <li className="muted small">…and {preview.length - 60} more</li>}
              </ol>
            </details>
          )}

          <div className="defaults-foot">
            <label className="defaults-count">
              <span>Create</span>
              <input
                className="field"
                type="number"
                min={1}
                max={99}
                value={listed ? size : count}
                disabled={listed}
                title={listed ? "Lists in the name decide how many" : undefined}
                aria-label="How many tasks"
                onChange={(e) => setCount(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
              />
              <span>{size === 1 ? "task" : "tasks"}</span>
            </label>
            <button type="button" className="ghost" title="Clear every default; the key goes back to DEFAULT" onClick={onReset}>
              Reset
            </button>
            <button className="primary" type="submit" disabled={busy}>
              Create
            </button>
          </div>
          {phaseIsNew && <p className="defaults-hint muted small">Creating also adds the phase “{firstPhase}”{preview.some((x) => x.phase !== firstPhase) ? " and the others listed" : ""}.</p>}
        </form>
      )}
    </div>
  );
}
