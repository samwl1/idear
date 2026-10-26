import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { api, canEditRole, type WorkspaceInfo } from "./lib/api";
import { CanEditContext } from "./lib/access";
import { attachPins, detachPins } from "./lib/pins";
import { SharePage } from "./components/SharePage";
import { JoinPage } from "./components/JoinPage";
import { initAutomerge } from "./lib/automerge";
import { WorkspaceSession } from "./lib/session";
import { Tree } from "./components/Tree";
import { ItemPage } from "./components/ItemPage";
import { ActivityLog } from "./components/ActivityLog";
import { ViewPage } from "./components/ViewPage";
import { ViewsNav, type ViewsPane } from "./components/ViewsNav";
import { PinnedNav } from "./components/PinnedNav";
import type { Pin } from "./lib/pins";
import { RAIL_DEFAULT, startResize, useSidebar } from "./lib/sidebar";
import { NotesHub } from "./components/NotesHub";
import { NavContext, type OpenOptions } from "./lib/nav";
import { AccountContext } from "./lib/account";
import type { AccountView, SyncApplied } from "./lib/api";
import { listen } from "@tauri-apps/api/event";
import { DevicesPage } from "./components/DevicesPage";
import { Icon } from "./components/Icon";
import { HelpPage } from "./components/HelpPage";
import { NameInput, WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { SettingsPage, type SettingsTab } from "./components/settings/SettingsPage";
import { AccessibilitySettings, AppearanceSettings } from "./components/settings/PrefsSettings";
import { WorkspacesSettings } from "./components/settings/WorkspacesSettings";
import { ClaudeSettings } from "./components/settings/ClaudeSettings";
import { zoomStep } from "./lib/prefs";
import { dismissToast, showError, showToast, useToast } from "./lib/toast";
import { CommandPalette } from "./components/CommandPalette";
import { SyncIndicator } from "./components/SyncIndicator";
import type { ItemKind } from "./lib/session";
import { rememberLook } from "./lib/looks";
import { popTarget, windowLabel } from "./lib/popout";

/** Set when this window was opened on one page from another window. */
const POP = popTarget();

/** Pages that don't need a workspace open. */
type GlobalPane =
  | { type: "join" }
  | { type: "settings"; tab: SettingsTab; doc?: string; anchor?: string | null; workspace?: string };
/** `at` changes on every open, so reopening the same project still jumps to the task or tab. */
type Pane = ({ type: "item"; id: string; at: number } & OpenOptions) | ViewsPane | GlobalPane | null;

const LAST_WORKSPACE = "lastWorkspace";

export default function App() {
  const [booted, setBooted] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [pane, setPane] = useState<Pane>(null);
  // A pop-out is one page using the whole window: no sidebar, and nothing it
  // does to the sidebar setting reaches the main window.
  const sidebar = useSidebar(!POP, !!POP);
  const toast = useToast();
  const [account, setAccountState] = useState<AccountView | null>(null);
  // The private doc (pins) is named after the account, so the session needs to know it.
  const setAccount = useCallback((a: AccountView) => {
    WorkspaceSession.user = a.userId;
    setAccountState(a);
  }, []);
  const accountCtx = useMemo(() => ({ account, setAccount }), [account, setAccount]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Re-render on workspace changes so a deleted note closes its editor.
  useEffect(() => session?.subscribe(rerender), [session]);
  useEffect(() => {
    if (session) rememberLook(session.id, session.look());
  }, [session]);

  const onError = useCallback((err: unknown) => {
    console.error(err);
    showError(err instanceof Error ? err.message : String(err));
  }, []);

  // Pins live in the account's private doc for the workspace.
  useEffect(() => {
    if (!session) return;
    attachPins(session, onError);
    return () => detachPins(session);
  }, [session, onError]);

  /** `stay` keeps the current page (e.g. Settings) instead of going home. */
  const openWorkspace = useCallback(
    async (id: string, stay = false, item?: string | null) => {
      try {
        const s = await WorkspaceSession.open(id);
        if (!POP) localStorage.setItem(LAST_WORKSPACE, id);
        const kind = item ? s.node(item)?.kind : undefined;
        if (kind && kind !== "folder") setPane({ type: "item", id: item!, at: Date.now() });
        else if (!stay) setPane(null);
        setSession(s);
      } catch (e) {
        onError(e);
      }
    },
    [onError],
  );

  useEffect(() => {
    (async () => {
      try {
        await initAutomerge();
        setAccount(await api.accountInfo());
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        const last = POP?.workspace ?? localStorage.getItem(LAST_WORKSPACE);
        const pick = list.find((w) => w.id === last) ?? list[0];
        if (pick) await openWorkspace(pick.id);
        if (POP && pick?.id === POP.workspace) setPane({ type: "item", id: POP.id, at: Date.now() });
      } catch (e) {
        onError(e);
      } finally {
        setBooted(true);
      }
    })();
  }, [openWorkspace, onError]);

  const createWorkspace = async (name: string) => {
    try {
      const { session: s, info } = await WorkspaceSession.create(name);
      setWorkspaces((ws) => [...ws, info].sort((a, b) => a.name.localeCompare(b.name)));
      localStorage.setItem(LAST_WORKSPACE, info.id);
      setPane(null);
      setSession(s);
    } catch (e) {
      onError(e);
    }
  };

  const openItem = useCallback(
    (id: string, opts: OpenOptions = {}) => {
      const kind = session?.node(id)?.kind;
      if (kind && kind !== "folder") setPane({ type: "item", id, at: Date.now(), ...opts });
    },
    [session],
  );
  const openHelp = useCallback(
    (doc: string, anchor?: string | null) => setPane({ type: "settings", tab: "help", doc, anchor }),
    [],
  );
  const openSettings = useCallback((tab: SettingsTab) => setPane({ type: "settings", tab }), []);
  const nav = useMemo(() => ({ openItem, openHelp, openSettings }), [openItem, openHelp, openSettings]);

  const [palette, setPalette] = useState(false);

  /** A new page at the top level of the open workspace. */
  const createAtTop = useCallback(
    async (kind: ItemKind) => {
      if (!session) return;
      try {
        const id = await session.createItem(kind, null);
        setPane({ type: "item", id, at: Date.now() });
      } catch (e) {
        onError(e);
      }
    },
    [session, onError],
  );

  // App-wide keys: search, settings, and text size.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "k" || e.key === "K") setPalette((v) => !v);
      else if (e.key === ",") setPane((p) => (p?.type === "settings" ? p : { type: "settings", tab: "workspaces" }));
      else if (e.key === "=" || e.key === "+") zoomStep(1);
      else if (e.key === "-" || e.key === "_") zoomStep(-1);
      else if (e.key === "0") zoomStep(0);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** A workspace left this device (deleted here or on another of your devices). */
  const leaveWorkspace = useCallback(
    async (id: string) => {
      try {
        const list = await api.listWorkspaces();
        setWorkspaces(list);
        if (session?.id !== id) return;
        const next = list[0];
        if (next) await openWorkspace(next.id, true);
        else {
          localStorage.removeItem(LAST_WORKSPACE);
          setSession(null);
        }
      } catch (e) {
        onError(e);
      }
    },
    [session, openWorkspace, onError],
  );

  // A change made in another window of this app (a popped-out page, or the
  // main window): reload that doc so both show the same thing.
  useEffect(() => {
    const me = windowLabel();
    const off = listen<{ workspace: string; doc: string; from: string }>("local-applied", async ({ payload }) => {
      if (payload.from === me || !session || payload.workspace !== session.id) return;
      try {
        await session.applyRemote([payload.doc]);
      } catch (e) {
        onError(e);
      }
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [session, onError]);

  // Another device's changes arrived: merge them into what's open.
  useEffect(() => {
    const off = listen<SyncApplied>("sync-applied", async ({ payload }) => {
      try {
        if (payload.identityChanged) setAccount(await api.accountInfo());
        if (session && payload.removedWorkspaces?.includes(session.id)) {
          await leaveWorkspace(session.id);
          return;
        }
        if (
          payload.newWorkspaces ||
          payload.identityChanged ||
          payload.membersChanged.length ||
          payload.removedWorkspaces?.length
        ) {
          setWorkspaces(await api.listWorkspaces());
        }
        if (payload.approvalsChanged) {
          const waiting = await api.listApprovals();
          const a = waiting[waiting.length - 1];
          if (a) {
            showToast(`${a.name || "Someone"} wants to join ${a.workspaceName} as ${a.role === "editor" ? "an editor" : "a viewer"}`, {
              action: { label: "Review", run: () => setPane({ type: "settings", tab: "sharing", workspace: a.workspace }) },
              ttl: 15000,
            });
          }
        }
        const docs = session ? payload.changed[session.id] : undefined;
        if (session && docs) await session.applyRemote(docs);
        if (!session && payload.newWorkspaces) {
          const list = await api.listWorkspaces();
          if (list[0]) {
            setSession(await WorkspaceSession.open(list[0].id));
            setPane(null);
          }
        }
      } catch (e) {
        onError(e);
      }
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [session, onError, leaveWorkspace]);

  /** After an update file: refresh everything that may have changed underneath. */
  const reloadAll = async () => {
    try {
      setAccount(await api.accountInfo());
      const list = await api.listWorkspaces();
      setWorkspaces(list);
      const id = session && list.some((w) => w.id === session.id) ? session.id : list[0]?.id;
      if (id) setSession(await WorkspaceSession.open(id));
    } catch (e) {
      onError(e);
    }
  };

  const openPin = useCallback(
    (p: Pin) => {
      if (p.kind === "hub" || p.kind === "activity") setPane({ type: p.kind });
      else if (p.kind === "view") setPane({ type: "view", id: p.id });
      else if (p.kind === "task") openItem(p.project, { task: p.id });
      else if (session?.node(p.id)?.kind === "folder") window.dispatchEvent(new CustomEvent("reveal-node", { detail: p.id }));
      else openItem(p.id);
    },
    [openItem, session],
  );

  const refreshWorkspaces = useCallback(
    () => api.listWorkspaces().then(setWorkspaces, onError),
    [onError],
  );

  const createView = async () => {
    if (!session) return;
    try {
      setPane({ type: "view", id: await session.createView() });
    } catch (e) {
      onError(e);
    }
  };

  const current = session ? workspaces.find((w) => w.id === session.id) : undefined;
  const canEdit = canEditRole(current?.role);
  useEffect(() => session?.setCanEdit(canEdit), [session, canEdit]);

  if (!booted) return <div className="boot" aria-busy="true" />;

  const settingsBody = (p: Extract<Pane, { type: "settings" }>) => {
    switch (p.tab) {
      case "workspaces":
        return (
          <WorkspacesSettings
            workspaces={workspaces}
            currentId={session?.id ?? null}
            onOpen={(id) => openWorkspace(id, true)}
            onCreate={createWorkspace}
            onJoin={() => setPane({ type: "join" })}
            onDeleted={leaveWorkspace}
            onRestored={async (w) => {
              const list = await api.listWorkspaces().catch(() => [w]);
              setWorkspaces(list);
              if (!session) await openWorkspace(w.id, true);
            }}
            onError={onError}
            session={session}
            onChanged={refreshWorkspaces}
            onShare={(id) => setPane({ type: "settings", tab: "sharing", workspace: id })}
          />
        );
      case "sharing": {
        const id = p.workspace && workspaces.some((w) => w.id === p.workspace) ? p.workspace : session?.id;
        const w = workspaces.find((x) => x.id === id);
        return id && w ? (
          <SharePage
            key={id}
            workspaceId={id}
            workspaceName={w.name}
            workspaces={workspaces}
            onPick={(next) => setPane({ type: "settings", tab: "sharing", workspace: next })}
            onChanged={refreshWorkspaces}
            onError={onError}
          />
        ) : null;
      }
      case "devices":
        return <DevicesPage onImported={reloadAll} onError={onError} />;
      case "claude":
        return <ClaudeSettings onError={onError} />;
      case "appearance":
        return <AppearanceSettings />;
      case "accessibility":
        return <AccessibilitySettings />;
      case "help":
        return <HelpPage doc={p.doc ?? "readme"} anchor={p.anchor} onOpen={openHelp} />;
    }
  };

  const renderGlobal = (p: Pane) => {
    if (p?.type === "settings") {
      const tab = p.tab === "sharing" && !workspaces.length ? "workspaces" : p.tab;
      return (
        <SettingsPage tab={tab} current={current ?? workspaces[0]} onTab={(t) => setPane({ type: "settings", tab: t })}>
          {settingsBody({ ...p, tab })}
        </SettingsPage>
      );
    }
    if (p?.type === "join") return <JoinPage onOpen={openWorkspace} onError={onError} />;
    return null;
  };

  const renderPane = (s: WorkspaceSession, p: Pane) => {
    const global = renderGlobal(p);
    if (global) return global;
    if (p?.type === "item") {
      const node = s.node(p.id);
      if (node && node.kind !== "folder") {
        return (
          <ItemPage
            // Notes and whiteboards reload when another device changes them; projects follow live.
            key={node.kind === "tracker" ? p.id : `${p.id}:${s.remoteVersion(p.id)}`}
            session={s}
            id={p.id}
            kind={node.kind}
            task={p.task}
            tab={p.tab}
            at={p.at}
            onOpen={openItem}
            onError={onError}
          />
        );
      }
    }
    if (p?.type === "activity") return <ActivityLog session={s} onError={onError} />;
    if (p?.type === "hub") return <NotesHub session={s} onError={onError} />;
    if (p?.type === "view" && s.view(p.id)) {
      return (
        <ViewPage
          key={p.id}
          session={s}
          viewId={p.id}
          onOpen={(id, task) => openItem(id, { task })}
          onDeleted={() => setPane(null)}
          onError={onError}
        />
      );
    }
    return <EmptyPane session={s} canEdit={canEdit} onCreate={createAtTop} onSearch={() => setPalette(true)} />;
  };

  return (
    <AccountContext.Provider value={accountCtx}>
    <NavContext.Provider value={nav}>
    <CanEditContext.Provider value={canEdit}>
    <div
      className="app"
      data-rail={session && current ? (sidebar.collapsed || POP ? "collapsed" : "open") : undefined}
      data-popout={POP ? true : undefined}
      style={{ ["--rail-w" as string]: `${sidebar.width}px` }}
    >
      {session && current ? (
        <>
          {sidebar.collapsed && !POP && (
            <button
              className="rail-open"
              aria-label="Show sidebar"
              title={`Show sidebar (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}\\)`}
              onClick={() => sidebar.setCollapsed(false)}
            >
              <Icon name="sidebar" />
            </button>
          )}
          <aside className="rail" hidden={sidebar.collapsed || !!POP}>
            <div
              className="rail-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              title="Drag to resize, double-click to reset"
              onPointerDown={(e) => startResize(e, sidebar.width, sidebar.setWidth)}
              onDoubleClick={() => sidebar.setWidth(RAIL_DEFAULT)}
            />
            <WorkspaceSwitcher
              current={current}
              workspaces={workspaces}
              onSwitch={openWorkspace}
              onCreate={createWorkspace}
              look={session.look()}
              onManage={() => setPane({ type: "settings", tab: "workspaces" })}
              onCollapse={() => sidebar.setCollapsed(true)}
            />
            <button className="rail-search" onClick={() => setPalette(true)} title={`Search (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}K)`}>
              <Icon name="search" />
              <span className="row-label">Search</span>
              <kbd>{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
            </button>
            <PinnedNav
              key={`pins:${session.id}`}
              session={session}
              activeKey={paneKey(pane)}
              onOpen={openPin}
              onError={onError}
            />
            <Tree
              key={session.id}
              session={session}
              selectedId={pane?.type === "item" ? pane.id : null}
              onOpen={(id) => openItem(id)}
              onError={onError}
              onOpenWorkspace={(id, item) => openWorkspace(id, false, item)}
            />
            <ViewsNav
              workspace={session.id}
              views={session.views()}
              active={pane?.type === "activity" || pane?.type === "hub" || pane?.type === "view" ? pane : null}
              onSelect={setPane}
              onCreate={createView}
            />
            <footer className="rail-foot">
              <button
                className="nav-item"
                data-active={pane?.type === "settings" || undefined}
                title={`Settings (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"},)`}
                onClick={() => setPane({ type: "settings", tab: pane?.type === "settings" ? pane.tab : "workspaces" })}
              >
                <Icon name="gear" /> <span className="row-label">Settings</span>
              </button>
              <SyncIndicator onOpen={() => setPane({ type: "settings", tab: "devices" })} />
            </footer>
          </aside>

          {/* Remounts editors when your role changes, so they pick up read-only mode. */}
          <main className="main" key={canEdit ? "edit" : "view"}>
            {renderPane(session, pane)}
          </main>
          {palette && (
            <CommandPalette
              session={session}
              workspaces={workspaces}
              canEdit={canEdit}
              onClose={() => setPalette(false)}
              onOpenItem={openItem}
              onOpenPane={setPane}
              onCreate={createAtTop}
              onNewFolder={async () => {
                try {
                  await session.createFolder(null);
                } catch (e) {
                  onError(e);
                }
              }}
              onSwitchWorkspace={(id) => openWorkspace(id)}
              onToggleSidebar={() => sidebar.setCollapsed(!sidebar.collapsed)}
              onError={onError}
            />
          )}
        </>
      ) : pane?.type === "settings" || pane?.type === "join" ? (
        <div className="solo">
          <button className="ghost solo-back" onClick={() => setPane(null)}>
            <Icon name="chevron" className="chev back" /> Back
          </button>
          <main className="main">{renderGlobal(pane)}</main>
        </div>
      ) : (
        <Welcome
          onCreate={createWorkspace}
          onJoin={() => setPane({ type: "join" })}
          onDevices={() => setPane({ type: "settings", tab: "devices" })}
          onHelp={() => openHelp("readme")}
          onSettings={() => setPane({ type: "settings", tab: "appearance" })}
        />
      )}

      {toast && (
        <div className="toast" data-kind={toast.kind} role={toast.kind === "error" ? "alert" : "status"}>
          <span>{toast.message}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                toast.action!.run();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            ×
          </button>
        </div>
      )}
    </div>
    </CanEditContext.Provider>
    </NavContext.Provider>
    </AccountContext.Provider>
  );
}

/** Which pin, if any, the open pane is. */
function paneKey(p: Pane): string | null {
  if (!p) return null;
  if (p.type === "hub" || p.type === "activity") return p.type;
  if (p.type === "view") return `view:${p.id}`;
  if (p.type === "item") return p.task ? `task:${p.task}` : `node:${p.id}`;
  return null;
}

function Welcome({
  onCreate,
  onJoin,
  onDevices,
  onHelp,
  onSettings,
}: {
  onCreate: (name: string) => void;
  onJoin: () => void;
  onDevices: () => void;
  onHelp: () => void;
  onSettings: () => void;
}) {
  return (
    <div className="welcome">
      <div className="brand">
        <img src="/idear.png" alt="" width={64} height={64} />
        <span>idear</span>
      </div>
      <h1>Start a workspace</h1>
      <p className="muted">
        A workspace holds your notes and folders. You can have as many as you like.
      </p>
      <NameInput
        className="welcome-input"
        placeholder="Workspace name"
        onDone={(name) => name && onCreate(name)}
      />
      <p className="hint">Press Enter to create.</p>
      <div className="welcome-alt">
        <p className="muted small">Already use this app on another computer, or got an invite?</p>
        <button className="ghost" onClick={onDevices}>
          <Icon name="bolt" /> Link this device to it
        </button>
        <button className="ghost" onClick={onJoin}>
          <Icon name="link" /> Join a shared workspace
        </button>
        <button className="ghost" onClick={onHelp}>
          <Icon name="book" /> Help
        </button>
        <button className="ghost" onClick={onSettings}>
          <Icon name="gear" /> Settings
        </button>
      </div>
    </div>
  );
}

const KINDS: { kind: ItemKind; label: string; detail: string; icon: "note" | "whiteboard" | "project" }[] = [
  { kind: "note", label: "Note", detail: "Headings, lists, code, images", icon: "note" },
  { kind: "whiteboard", label: "Whiteboard", detail: "Shapes, arrows, freehand", icon: "whiteboard" },
  { kind: "tracker", label: "Project", detail: "Board, backlog, roadmap", icon: "project" },
];

/** Nothing open: offer the kinds of page directly rather than pointing at the sidebar. */
export function EmptyPane({
  session,
  canEdit,
  onCreate,
  onSearch,
}: {
  session: WorkspaceSession;
  canEdit: boolean;
  onCreate: (kind: ItemKind) => void;
  onSearch: () => void;
}) {
  const hasPages = session.hasPages();
  const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";
  return (
    <div className="placeholder">
      <div className="empty">
        <h2>{hasPages ? "Nothing open" : `Welcome to ${session.name}`}</h2>
        <p className="muted">
          {hasPages ? (
            <>
              Pick a page in the sidebar, or press <kbd>{mod}K</kbd> to search.
            </>
          ) : canEdit ? (
            "Start with a page. You can nest pages inside pages, and group them in folders."
          ) : (
            "This workspace is view only and has no pages yet."
          )}
        </p>
        {canEdit && (
          <div className="empty-kinds">
            {KINDS.map((k) => (
              <button key={k.kind} className="empty-kind" onClick={() => onCreate(k.kind)}>
                <Icon name={k.icon} />
                <span className="empty-kind-label">New {k.label.toLowerCase()}</span>
                <span className="empty-kind-detail">{k.detail}</span>
              </button>
            ))}
          </div>
        )}
        {hasPages && (
          <button className="ghost" onClick={onSearch}>
            <Icon name="search" /> Search this workspace
          </button>
        )}
      </div>
    </div>
  );
}
