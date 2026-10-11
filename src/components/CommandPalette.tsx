// Cmd/Ctrl+K: find pages, tasks, and views, or run an action, from anywhere.
// Titles match instantly from the tree; full text comes from the index (FTS5)
// after a short pause, so typing stays responsive.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ViewRow, type WorkspaceInfo } from "../lib/api";
import type { ItemKind, WorkspaceSession } from "../lib/session";
import { DEFAULT_QUERY } from "../lib/session";
import { useTree, ancestors } from "../lib/useTree";
import { Icon, iconName, type IconName } from "./Icon";
import type { ViewsPane } from "./ViewsNav";

type Hit =
  | { id: string; group: "Pages"; icon: IconName; title: string; detail: string; run: () => void }
  | { id: string; group: "Tasks"; icon: IconName; title: string; detail: string; run: () => void }
  | { id: string; group: "Views"; icon: IconName; title: string; detail: string; run: () => void }
  | { id: string; group: "Actions"; icon: IconName; title: string; detail: string; run: () => void };

const GROUPS: Hit["group"][] = ["Actions", "Pages", "Tasks", "Views"];
const KIND_ICON: Record<string, IconName> = { note: "note", whiteboard: "whiteboard", tracker: "project", folder: "folder", task: "check" };
const MOD = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

interface Props {
  session: WorkspaceSession;
  workspaces: WorkspaceInfo[];
  canEdit: boolean;
  onClose: () => void;
  onOpenItem: (id: string, opts?: { task?: string }) => void;
  onOpenPane: (pane: ViewsPane | { type: "settings"; tab: "workspaces" | "devices" | "appearance" | "help" }) => void;
  onCreate: (kind: ItemKind) => void;
  onNewFolder: () => void;
  onSwitchWorkspace: (id: string) => void;
  onToggleSidebar: () => void;
  onError: (err: unknown) => void;
}

export function CommandPalette(p: Props) {
  const { session, onClose, onError } = p;
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [fts, setFts] = useState<ViewRow[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const tree = useTree(session, onError);

  useEffect(() => input.current?.focus(), []);

  // Full-text results, debounced. Title-only matches are handled below without waiting.
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setFts([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .runView(session.id, { ...DEFAULT_QUERY, types: ["note", "whiteboard", "tracker", "task"], text, sort: "updated" })
        .then((rows) => live && setFts(rows.slice(0, 30)), () => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, session.id]);

  const hits = useMemo<Hit[]>(() => {
    const text = q.trim().toLowerCase();
    const words = text.split(/\s+/).filter(Boolean);
    const matches = (s: string) => {
      const l = s.toLowerCase();
      return words.every((w) => l.includes(w));
    };
    const done = (f: () => void) => () => {
      onClose();
      f();
    };
    const out: Hit[] = [];

    // Actions. All of them when the box is empty; otherwise the ones whose name matches.
    const actions: { title: string; detail: string; icon: IconName; run: () => void; when?: boolean }[] = [
      { title: "New note", detail: "At the top level", icon: "note", run: () => p.onCreate("note"), when: p.canEdit },
      { title: "New whiteboard", detail: "At the top level", icon: "whiteboard", run: () => p.onCreate("whiteboard"), when: p.canEdit },
      { title: "New project", detail: "At the top level", icon: "project", run: () => p.onCreate("tracker"), when: p.canEdit },
      { title: "New folder", detail: "At the top level", icon: "folder", run: p.onNewFolder, when: p.canEdit },
      { title: "Notes Hub", detail: "Every note in a grid", icon: "note", run: () => p.onOpenPane({ type: "hub" }) },
      { title: "Activity", detail: "Who changed what", icon: "log", run: () => p.onOpenPane({ type: "activity" }) },
      { title: "Toggle sidebar", detail: `${MOD}\\`, icon: "sidebar", run: p.onToggleSidebar },
      { title: "Settings", detail: `${MOD},`, icon: "gear", run: () => p.onOpenPane({ type: "settings", tab: "workspaces" }) },
      { title: "Devices and sync", detail: "Settings", icon: "bolt", run: () => p.onOpenPane({ type: "settings", tab: "devices" }) },
      { title: "Appearance", detail: "Settings", icon: "eye", run: () => p.onOpenPane({ type: "settings", tab: "appearance" }) },
      { title: "Help", detail: "Guides and shortcuts", icon: "book", run: () => p.onOpenPane({ type: "settings", tab: "help" }) },
      ...p.workspaces
        .filter((w) => w.id !== session.id)
        .map((w) => ({ title: `Switch to ${w.name}`, detail: "Workspace", icon: "users" as IconName, run: () => p.onSwitchWorkspace(w.id) })),
    ];
    for (const a of actions) {
      if (a.when === false) continue;
      if (!text || matches(a.title)) out.push({ id: `action:${a.title}`, group: "Actions", icon: a.icon, title: a.title, detail: a.detail, run: done(a.run) });
    }

    // Pages: title matches from the tree, instantly. Empty box: nothing (the sidebar already lists them).
    const seen = new Set<string>();
    if (text) {
      for (const n of tree.nodes) {
        if (n.kind === "folder") continue;
        const title = n.title || "Untitled";
        if (!matches(title)) continue;
        seen.add(n.id);
        out.push({ id: n.id, group: "Pages", icon: KIND_ICON[n.kind], title, detail: path(tree, n.id), run: done(() => p.onOpenItem(n.id)) });
      }
      for (const v of session.views()) {
        const title = v.def.name || "Untitled view";
        if (matches(title)) out.push({ id: `view:${v.id}`, group: "Views", icon: iconName(v.def.icon), title, detail: "Saved view", run: done(() => p.onOpenPane({ type: "view", id: v.id })) });
      }
    }

    // Full-text hits: pages whose body matched, and tasks.
    for (const r of fts) {
      if (r.kind === "task") {
        if (!r.tracker) continue;
        const tracker = r.tracker;
        out.push({
          id: `task:${r.id}`,
          group: "Tasks",
          icon: "check",
          title: `${r.key ? `${r.key} ` : ""}${r.title || "Untitled task"}`,
          detail: [r.trackerTitle, r.status].filter(Boolean).join(" · "),
          run: done(() => p.onOpenItem(tracker, { task: r.id })),
        });
      } else if (r.kind === "note" || r.kind === "whiteboard" || r.kind === "tracker") {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, group: "Pages", icon: KIND_ICON[r.kind], title: r.title || "Untitled", detail: `${path(tree, r.id)} · matched in text`, run: done(() => p.onOpenItem(r.id)) });
      }
    }

    // Actions lead only when the box is empty; a search puts pages first.
    const order = text ? ["Pages", "Tasks", "Views", "Actions"] : GROUPS;
    out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    return out.slice(0, 40);
  }, [q, fts, tree, session, p, onClose]);

  useEffect(() => setCursor(0), [q, hits.length]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, hits.length - 1));
    else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
    else if (e.key === "Enter") hits[cursor]?.run();
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
  };

  let lastGroup: Hit["group"] | null = null;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Search and commands">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            placeholder="Search pages and tasks, or type a command"
            aria-label="Search"
            aria-activedescendant={hits[cursor] ? `pal-${cursor}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {hits.length === 0 && <p className="palette-empty muted">{q.trim() ? "Nothing matches." : "Type to search."}</p>}
          {hits.map((h, i) => {
            const head = h.group !== lastGroup;
            lastGroup = h.group;
            return (
              <div key={h.id}>
                {head && <div className="palette-group">{h.group}</div>}
                <button
                  id={`pal-${i}`}
                  role="option"
                  aria-selected={i === cursor}
                  data-i={i}
                  className="palette-item"
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={h.run}
                >
                  <Icon name={h.icon} />
                  <span className="palette-title">{h.title}</span>
                  <span className="palette-detail muted">{h.detail}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** "Folder / Parent page" for a page, or "Top level". */
function path(tree: ReturnType<typeof useTree>, id: string): string {
  const up = ancestors(tree, id);
  return up.length ? up.map((n) => n.title || "Untitled").join(" / ") : "Top level";
}
