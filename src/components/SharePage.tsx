import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PersonView, type Role, type ShareInfo, type ShareInvite, type SyncStatus, type WorkspaceInfo } from "../lib/api";
import { ago, copy } from "../lib/clipboard";
import { useNav } from "../lib/nav";
import { Icon } from "./Icon";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
  removed: "Removed",
};

interface Props {
  workspaceId: string;
  workspaceName: string;
  /** Every workspace on this device, to switch which one this page is about. */
  workspaces: WorkspaceInfo[];
  onPick: (id: string) => void;
  /** Called after roles change, so the switcher and read-only state follow. */
  onChanged: () => void;
  onError: (err: unknown) => void;
}

/** Who has this workspace, and invites for new people. */
export function SharePage({ workspaceId, workspaceName, workspaces, onPick, onChanged, onError }: Props) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const { openHelp, openSettings } = useNav();

  const refresh = useCallback(
    () => api.shareInfo(workspaceId).then(setInfo, onError),
    [workspaceId, onError],
  );

  useEffect(() => {
    refresh();
    let live = true;
    const poll = () => {
      api.syncStatus().then((s) => live && setSync(s), () => {});
      refresh();
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [refresh]);

  if (!info) return <div className="editor-loading" aria-busy="true" />;

  const update = (p: Promise<ShareInfo>) =>
    p.then((next) => {
      setInfo(next);
      onChanged();
    }, onError);

  const current = info.people.filter((p) => p.role !== "removed");
  const removed = info.people.filter((p) => p.role === "removed");

  return (
    <section className="share">
      <header className="devices-head">
        <h1>
          <Icon name="users" /> Sharing
        </h1>
        <label className="share-pick">
          <span className="small muted">Workspace</span>
          <select className="field" value={workspaceId} aria-label="Workspace" onChange={(e) => onPick(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.role === "owner" ? (w.shared ? " (shared)" : "") : w.role === "viewer" ? " (view only)" : " (editor)"}
              </option>
            ))}
          </select>
        </label>
        <p className="muted">
          <strong>{workspaceName}</strong>.{" "}
          {info.isOwner
            ? "You own this workspace: you decide who has it and what they can do."
            : info.role === "removed"
              ? `${info.ownerName || "The owner"} removed you. Your copy stays here, read-only, and no longer syncs.`
              : `Owned by ${info.ownerName || "someone else"}. You're ${info.role === "editor" ? "an editor" : "a viewer"}.`}
        </p>
      </header>

      <section className="card">
        <h2>People</h2>
        <ul className="people">
          {current.map((p) => (
            <PersonRow
              key={p.user}
              person={p}
              sync={sync}
              canManage={info.isOwner && p.role !== "owner"}
              onRole={(role) => update(api.setMemberRole(workspaceId, p.user, role))}
            />
          ))}
        </ul>
        {removed.length > 0 && (
          <>
            <h3 className="muted small">Removed</h3>
            <ul className="people removed">
              {removed.map((p) => (
                <li key={p.user} className="person">
                  <span className="person-main">
                    <span className="person-name">{p.name || "Unnamed"}</span>
                    <span className="person-meta">Their changes after removal are refused.</span>
                  </span>
                  {info.isOwner && (
                    <span className="person-actions">
                      <button className="ghost" onClick={() => update(api.setMemberRole(workspaceId, p.user, "viewer"))}>
                        Restore as viewer
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="hint">
          Changes sync straight between people's devices whenever two of them are online together. Nothing goes through
          a server you don't control.{" "}
          <button className="link-btn" onClick={() => openHelp("sharing")}>
            How sharing works
          </button>
          {info.isOwner && (
            <>
              {" · "}
              <button className="link-btn" onClick={() => openSettings("claude")}>
                Give Claude access
              </button>
            </>
          )}
        </p>
      </section>

      {info.isOwner && <Invites workspaceId={workspaceId} invites={info.invites} people={info.people} onInfo={update} onError={onError} />}
    </section>
  );
}

function PersonRow({
  person,
  sync,
  canManage,
  onRole,
}: {
  person: PersonView;
  sync: SyncStatus | null;
  canManage: boolean;
  onRole: (role: "editor" | "viewer" | "removed") => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const status = personSync(person, sync);
  return (
    <li className="person">
      <span className="avatar" aria-hidden="true">
        {(person.name || "?").slice(0, 1).toUpperCase()}
      </span>
      <span className="person-main">
        <span className="person-name">
          {person.name || "Unnamed"}
          {person.isYou && <span className="muted"> (you)</span>}
        </span>
        <span className="person-meta">
          {person.role === "owner" ? "Owner" : `Since ${dateFmt.format(person.since)}`}
          {status && <span className="sync-line" data-state={status.state}>{status.text}</span>}
        </span>
      </span>
      <span className="person-actions">
        {canManage ? (
          <>
            <select
              className="field"
              aria-label={`${person.name}'s role`}
              value={person.role}
              onChange={(e) => onRole(e.target.value as "editor" | "viewer")}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            {confirming ? (
              <button className="danger-btn" onClick={() => onRole("removed")}>
                Remove {person.name || "them"}
              </button>
            ) : (
              <button className="tool" title="Remove" aria-label={`Remove ${person.name}`} onClick={() => setConfirming(true)}>
                <Icon name="trash" />
              </button>
            )}
          </>
        ) : (
          <span className="role-pill" data-role={person.role}>
            {ROLE_LABEL[person.role]}
          </span>
        )}
      </span>
    </li>
  );
}

/** The freshest sync with any of a person's devices. */
function personSync(person: PersonView, sync: SyncStatus | null): { text: string; state: string } | null {
  if (person.isYou || !sync) return null;
  if (!sync.running) return { text: "Live sync is off", state: "idle" };
  const peers = person.devices.map((d) => sync.peers[d]).filter(Boolean);
  const last = Math.max(0, ...peers.map((p) => p.lastSync ?? 0));
  if (last) return { text: `Synced ${ago(last)}`, state: "ok" };
  const err = peers.find((p) => p.lastError)?.lastError;
  return err ? { text: err, state: "warn" } : { text: "Not synced yet", state: "idle" };
}

function Invites({
  workspaceId,
  invites,
  people,
  onInfo,
  onError,
}: {
  workspaceId: string;
  invites: ShareInvite[];
  people: PersonView[];
  onInfo: (p: Promise<ShareInfo>) => void;
  onError: (err: unknown) => void;
}) {
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(7);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const create = async () => {
    try {
      const r = await api.createInvite(workspaceId, role, label, days);
      setToken(r.token);
      setCopied(false);
      setLabel("");
      onInfo(Promise.resolve(r.info));
    } catch (e) {
      onError(e);
    }
  };

  const nameOf = (user: string | null) => people.find((p) => p.user === user)?.name || "someone";
  const shown = invites.filter((i) => i.status !== "cancelled");

  return (
    <section className="card">
      <h2>Invite someone</h2>
      <p className="muted small">
        Creates a one-time invite link. Send it privately: whoever uses it first joins, so treat it like a password.
        They need this app, and your device has to be online once for them to join.
      </p>
      <div className="invite-form">
        <label className="setting">
          <span>Who it's for</span>
          <input
            className="field"
            value={label}
            placeholder="e.g. Alex"
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label className="setting">
          <span>They can</span>
          <select className="field" value={role} onChange={(e) => setRole(e.target.value as "editor" | "viewer")}>
            <option value="editor">Edit</option>
            <option value="viewer">View only</option>
          </select>
        </label>
        <label className="setting">
          <span>Link works for</span>
          <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <button className="primary" onClick={create}>
          <Icon name="link" /> Create invite link
        </button>
      </div>

      {token && (
        <div className="invite">
          <textarea ref={area} className="field code-box" readOnly value={token} rows={4} />
          <button className="ghost" onClick={() => copy(token, area.current).then(setCopied)}>
            {copied ? "Copied" : "Copy invite link"}
          </button>
          <p className="hint">They paste it under Join a shared workspace, in the workspace menu or Settings.</p>
        </div>
      )}

      {shown.length > 0 && (
        <>
          <h3 className="muted small">Invites</h3>
          <ul className="invite-list">
            {shown.map((i) => (
              <li key={i.id} className="invite-row" data-status={i.status}>
                <span className="person-main">
                  <span className="person-name">
                    {i.label || "Untitled invite"} <span className="muted">· {ROLE_LABEL[i.role]}</span>
                  </span>
                  <span className="person-meta">
                    {i.status === "open" && `Expires ${ago(i.expires)}`}
                    {i.status === "used" && `Used by ${nameOf(i.usedBy)}`}
                    {i.status === "expired" && `Expired ${dateFmt.format(i.expires)}`}
                  </span>
                </span>
                {i.status === "open" && (
                  <button className="ghost" onClick={() => onInfo(api.cancelInvite(workspaceId, i.id))}>
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
