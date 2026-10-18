import { useCallback, useEffect, useState } from "react";
import { api, canEditRole, type Trashed, type WorkspaceInfo } from "../../lib/api";
import { ago } from "../../lib/clipboard";
import { Icon } from "../Icon";
import { NameInput, WorkspaceMark } from "../WorkspaceSwitcher";
import { LookPicker } from "../LookPicker";
import { WorkspaceSession, type WorkspaceLook } from "../../lib/session";
import { cachedLook, rememberLook } from "../../lib/looks";
import { showToast } from "../../lib/toast";
import { carryPins } from "../../lib/pins";

interface Props {
  workspaces: WorkspaceInfo[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
  onJoin: () => void;
  /** After a delete or restore: refresh the list (and leave a deleted workspace). */
  onDeleted: (id: string) => void;
  onRestored: (w: WorkspaceInfo) => void;
  onError: (err: unknown) => void;
  /** The open workspace's session, so edits to it show in the sidebar at once. */
  session: WorkspaceSession | null;
  /** After a rename: refresh the list. */
  onChanged: () => void;
  /** Settings → Sharing for that workspace. */
  onShare: (id: string) => void;
}

function roleText(w: WorkspaceInfo): string {
  if (w.role === "owner") return w.shared ? "Yours, shared" : "Yours";
  const by = w.ownerName ? ` · ${w.ownerName}'s` : "";
  return (w.role === "editor" ? "Editor" : w.role === "viewer" ? "View only" : "Removed") + by;
}

/** What deleting does, which depends on who else has it. */
function deleteNote(w: WorkspaceInfo): string {
  if (w.role === "owner" && w.shared) {
    return "It goes to the trash on all your devices. People you shared it with keep their copies; remove them on the Sharing page first if they shouldn't.";
  }
  if (w.role !== "owner") {
    return `It goes to the trash on all your devices. ${w.ownerName || "The owner"} and others keep theirs, and you stay listed as a member until they remove you.`;
  }
  return "It goes to the trash on all your devices.";
}

export function WorkspacesSettings({ workspaces, currentId, onOpen, onCreate, onJoin, onDeleted, onRestored, onError, session, onChanged, onShare }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [trash, setTrash] = useState<Trashed[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  const loadTrash = useCallback(() => api.listTrash().then(setTrash, onError), [onError]);

  useEffect(() => {
    loadTrash();
  }, [loadTrash, workspaces]);

  const remove = async (w: WorkspaceInfo) => {
    try {
      await api.deleteWorkspace(w.id);
      setConfirm(null);
      onDeleted(w.id);
      loadTrash();
    } catch (e) {
      onError(e);
    }
  };

  const restore = async (t: Trashed) => {
    try {
      onRestored(await api.restoreWorkspace(t.id));
      loadTrash();
    } catch (e) {
      onError(e);
    }
  };

  /**
   * Everything in `from` goes to the top level of `into`, then `from` goes to
   * the trash. The copy finishes before anything is removed; a failure
   * part-way leaves `from` as it was.
   */
  const merge = async (from: WorkspaceInfo, into: WorkspaceInfo) => {
    try {
      const src = from.id === currentId && session ? session : await WorkspaceSession.open(from.id);
      const dst = into.id === currentId && session ? session : await WorkspaceSession.open(into.id);
      dst.setCanEdit(canEditRole(into.role));
      const sub = await src.exportSubtree(null);
      const n = Object.keys(sub.nodes).length;
      const ids = await dst.importSubtree(null, sub, "tree.merge_in");
      await api.deleteWorkspace(from.id);
      carryPins(from.id, into.id, ids);
      setMerging(null);
      showToast(`Merged ${n} item${n === 1 ? "" : "s"} from ${from.name} into ${into.name}`);
      onDeleted(from.id);
      loadTrash();
    } catch (e) {
      onError(e);
    }
  };

  const purge = async (t: Trashed) => {
    try {
      await api.purgeWorkspace(t.id);
      setConfirm(null);
      loadTrash();
    } catch (e) {
      onError(e);
    }
  };

  const inTrash = trash.filter((t) => t.restorable);
  // Two of your own with the same name: usually the same workspace from before
  // this device was added to the account. Offer to fold one into the other.
  const twins = Object.values(
    workspaces.filter((w) => w.role === "owner").reduce<Record<string, WorkspaceInfo[]>>((acc, w) => {
      const k = w.name.trim().toLowerCase();
      (acc[k] ??= []).push(w);
      return acc;
    }, {}),
  ).filter((g) => g.length > 1);

  return (
    <div className="prefs">
      {twins.length > 0 && (
        <section className="card notice">
          <h2>Workspaces that may be the same one</h2>
          {twins.map((g) => (
            <p key={g[0].id} className="small">
              You own {g.length} workspaces named “{g[0].name}”. If they're one workspace from before this device joined the account, merge the one
              with the older copy into the other.
              {" "}
              <button
                className="ghost small"
                onClick={() => {
                  setEditing(g[0].id);
                  setMerging(g[0].id);
                }}
              >
                Merge…
              </button>
            </p>
          ))}
        </section>
      )}
      <section className="card">
        <h2>Workspaces on this device</h2>
        <p className="muted small">Click one to open it. Edit its name, color, and icon here without opening it.</p>
        <ul className="ws-list">
          {workspaces.map((w) => (
            <li key={w.id} className="ws-row" data-confirm={confirm === w.id || undefined} data-open={w.id === currentId || undefined}>
              <button
                className="ws-main"
                aria-current={w.id === currentId ? "true" : undefined}
                title={w.id === currentId ? "Open now" : `Open ${w.name}`}
                onClick={() => w.id !== currentId && onOpen(w.id)}
              >
                <WorkspaceMark name={w.name} look={w.id === currentId && session ? session.look() : cachedLook(w.id)} />
                <span className="ws-text">
                  <span className="ws-name">
                    {w.name}
                    {w.id === currentId && <span className="muted"> (open)</span>}
                  </span>
                  <span className="ws-meta">{roleText(w)}</span>
                </span>
              </button>
              {confirm === w.id ? (
                <div className="ws-confirm" role="group" aria-label={`Delete ${w.name}?`}>
                  <p>{deleteNote(w)} You can restore it for 30 days.</p>
                  <div className="ws-actions">
                    <button className="ghost" onClick={() => setConfirm(null)} autoFocus>
                      Keep it
                    </button>
                    <button className="danger-btn" onClick={() => remove(w)}>
                      Move to trash
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ws-actions">
                  <button className="tool" aria-label={`Sharing for ${w.name}`} title="Sharing" onClick={() => onShare(w.id)}>
                    <Icon name="users" />
                  </button>
                  {canEditRole(w.role) && (
                    <button
                      className="tool"
                      aria-pressed={editing === w.id}
                      aria-label={`Edit ${w.name}`}
                      title="Name, color, and icon"
                      onClick={() => setEditing(editing === w.id ? null : w.id)}
                    >
                      <Icon name="pencil" />
                    </button>
                  )}
                  <button className="tool" aria-label={`Delete ${w.name}`} title="Delete" onClick={() => setConfirm(w.id)}>
                    <Icon name="trash" />
                  </button>
                </div>
              )}
              {editing === w.id && confirm !== w.id && (
                <>
                  <WorkspaceEditor
                    workspace={w}
                    session={w.id === currentId ? session : null}
                    onChanged={onChanged}
                    onError={onError}
                  />
                  {w.role === "owner" && (
                    <div className="ws-merge">
                      {merging === w.id ? (
                        <MergePicker
                          from={w}
                          targets={workspaces.filter((x) => x.id !== w.id && canEditRole(x.role))}
                          onPick={(into) => merge(w, into)}
                          onCancel={() => setMerging(null)}
                        />
                      ) : (
                        <button className="ghost small" onClick={() => setMerging(w.id)}>
                          Merge into another workspace…
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
          {workspaces.length === 0 && <li className="muted small">No workspaces yet.</li>}
        </ul>
        <div className="ws-add">
          {creating ? (
            <NameInput
              className="field"
              placeholder="New workspace name"
              onDone={(name) => {
                setCreating(false);
                if (name) onCreate(name);
              }}
            />
          ) : (
            <button className="ghost" onClick={() => setCreating(true)}>
              <Icon name="plus" /> New workspace
            </button>
          )}
          <button className="ghost" onClick={onJoin}>
            <Icon name="link" /> Join a shared workspace
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Trash</h2>
        {inTrash.length === 0 ? (
          <p className="muted small">Deleted workspaces stay here for 30 days, on each of your devices.</p>
        ) : (
          <>
            <p className="muted small">Kept for 30 days after deleting, then cleared.</p>
            <ul className="ws-list">
              {inTrash.map((t) => (
                <li key={t.id} className="ws-row" data-confirm={confirm === `trash:${t.id}` || undefined}>
                  <div className="ws-main">
                    <span className="ws-name">{t.name || "Untitled workspace"}</span>
                    <span className="ws-meta">Deleted {ago(t.deletedAt)}</span>
                  </div>
                  {confirm === `trash:${t.id}` ? (
                    <div className="ws-confirm" role="group" aria-label={`Delete ${t.name} for good?`}>
                      <p>This erases it from this device and can't be undone. Your other devices keep their trash until it expires.</p>
                      <div className="ws-actions">
                        <button className="ghost" onClick={() => setConfirm(null)} autoFocus>
                          Cancel
                        </button>
                        <button className="danger-btn" onClick={() => purge(t)}>
                          Delete for good
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="ws-actions">
                      <button className="ghost" onClick={() => restore(t)}>
                        Restore
                      </button>
                      <button className="ghost" onClick={() => setConfirm(`trash:${t.id}`)}>
                        Delete for good
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Name, color, and icon of one workspace. The open workspace edits through the
 * app's session so the sidebar follows; any other gets a session of its own,
 * which only loads the workspace's manifest.
 */
function WorkspaceEditor({
  workspace,
  session,
  onChanged,
  onError,
}: {
  workspace: WorkspaceInfo;
  session: WorkspaceSession | null;
  onChanged: () => void;
  onError: (err: unknown) => void;
}) {
  const [own, setOwn] = useState<WorkspaceSession | null>(null);
  const [, bump] = useState(0);
  const s = session ?? own;

  useEffect(() => {
    if (session) return;
    let live = true;
    WorkspaceSession.open(workspace.id).then((x) => {
      x.setCanEdit(canEditRole(workspace.role));
      if (live) setOwn(x);
    }, onError);
    return () => {
      live = false;
    };
  }, [session, workspace.id, workspace.role, onError]);

  useEffect(() => s?.subscribe(() => bump((n) => n + 1)), [s]);

  if (!s) return <div className="ws-editor muted small">Loading…</div>;
  const look: WorkspaceLook = s.look();
  const run = (p: Promise<unknown>) => p.catch(onError);

  return (
    <div className="ws-editor">
      {workspace.role !== "owner" && <p className="muted small ws-editor-note">Only the owner can rename a workspace.</p>}
      {workspace.role === "owner" && (
      <label className="ws-field">
        <span className="small muted">Name</span>
        <input
          className="field"
          key={workspace.name}
          defaultValue={workspace.name}
          aria-label="Workspace name"
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            if (name && name !== workspace.name) run(s.renameWorkspace(name).then(onChanged));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </label>
      )}
      <LookPicker look={look} onLook={(l) => run(s.setLook(l).then(() => rememberLook(workspace.id, s.look())))} />
    </div>
  );
}

/** Choose where a workspace's pages go; the workspace itself goes to the trash after. */
function MergePicker({ from, targets, onPick, onCancel }: { from: WorkspaceInfo; targets: WorkspaceInfo[]; onPick: (into: WorkspaceInfo) => void; onCancel: () => void }) {
  const [into, setInto] = useState<string>(targets[0]?.id ?? "");
  const target = targets.find((t) => t.id === into);
  return (
    <div className="ws-confirm" role="group" aria-label={`Merge ${from.name}`}>
      {targets.length === 0 ? (
        <p>No other workspace you can edit to merge into.</p>
      ) : (
        <>
          <p>
            Everything in {from.name} moves to the top level of the workspace you pick, and its saved views come along.
            {from.shared && " People you shared it with keep their copies of the old one."} Then {from.name} goes to the trash.
          </p>
          <label className="ws-field">
            <span className="small muted">Merge into</span>
            <select className="field" value={into} onChange={(e) => setInto(e.target.value)}>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <div className="ws-actions">
        <button className="ghost" onClick={onCancel} autoFocus>
          Cancel
        </button>
        {target && (
          <button className="primary" onClick={() => onPick(target)}>
            Merge into {target.name}
          </button>
        )}
      </div>
    </div>
  );
}
