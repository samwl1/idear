import { useContext, useEffect, useRef, useState } from "react";
import { api, type DeviceView, type InviteView, type PeerStatus, type SyncStatus } from "../lib/api";
import { fingerprint, useAccount } from "../lib/account";
import { NavContext } from "../lib/nav";
import { Icon } from "./Icon";
import { ago, copy } from "../lib/clipboard";
import { UpdateFiles } from "./UpdateFiles";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

interface Props {
  /** Called after an update file is imported, so open workspaces reload. */
  onImported: () => void;
  onError: (err: unknown) => void;
}

export function DevicesPage({ onImported, onError }: Props) {
  const { account, setAccount } = useAccount();
  const [sync, setSync] = useState<SyncStatus | null>(null);

  // Live status while this page is open.
  useEffect(() => {
    let live = true;
    const refresh = () => api.syncStatus().then((s) => live && setSync(s), () => {});
    refresh();
    const t = setInterval(refresh, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!account) return <div className="editor-loading" aria-busy="true" />;

  const active = account.devices.filter((d) => d.revoked === null);
  const removed = account.devices.filter((d) => d.revoked !== null);
  const run = (p: Promise<typeof account>) => p.then(setAccount, onError);

  return (
    <section className="devices">
      <header className="devices-head">
        <h1>Devices</h1>
        <p className="muted">
          Your devices share one identity. Each device signs its own changes, and your identity vouches for the
          devices.
        </p>
      </header>

      <section className="card">
        <h2>You</h2>
        <label className="setting-row">
          <span>Name</span>
          <input
            className="field"
            key={account.name}
            defaultValue={account.name}
            placeholder="Your name"
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              if (v && v !== account.name) run(api.setUserName(v));
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        </label>
        <p className="hint">Used as your assignee name. In a view's Assignee filter, @me means you.</p>
        <div className="setting-row">
          <span>Identity</span>
          <code className="fp" title={account.userId}>
            {fingerprint(account.userId)}
          </code>
        </div>
      </section>

      <section className="card">
        <h2>Linked devices</h2>
        <ul className="device-list">
          {active.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              status={d.thisDevice ? undefined : (sync?.peers[d.id] ?? null)}
              syncOn={!!sync?.running}
              onRename={(n) => run(api.renameDevice(d.id, n))}
              onRemove={() => run(api.revokeDevice(d.id))}
            />
          ))}
        </ul>
        {removed.length > 0 && (
          <>
            <h3 className="muted small">Removed</h3>
            <ul className="device-list removed">
              {removed.map((d) => (
                <li key={d.id} className="device">
                  <Icon name="trash" className="device-icon" />
                  <span className="device-main">
                    <span className="device-name">{d.name}</span>
                    <span className="device-meta">
                      Removed {dateFmt.format(d.revoked!)}. Its new changes are refused.
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="hint">Devices you link or remove reach your other devices on the next sync.</p>
      </section>

      <SyncCard status={sync} onStatus={setSync} onError={onError} />

      <div className="link-grid">
        <CreateLink onError={onError} />
        <JoinWithCode onError={onError} />
      </div>

      <UpdateFiles onImported={onImported} onError={onError} />
    </section>
  );
}

function syncLine(status: PeerStatus | null, on: boolean): { text: string; state: "ok" | "warn" | "idle" } {
  if (!on) return { text: "Live sync is off", state: "idle" };
  if (!status) return { text: "Not synced yet", state: "idle" };
  if (status.lastError) {
    const last = status.lastSync ? ` Last synced ${ago(status.lastSync)}.` : "";
    return { text: `${status.lastError}.${last}`, state: "warn" };
  }
  return status.lastSync ? { text: `Synced ${ago(status.lastSync)}`, state: "ok" } : { text: "Not synced yet", state: "idle" };
}

function DeviceRow({
  device,
  status,
  syncOn,
  onRename,
  onRemove,
}: {
  device: DeviceView;
  /** Undefined for this device; null when it hasn't been tried yet. */
  status?: PeerStatus | null;
  syncOn: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  return (
    <li className="device">
      <Icon name="bolt" className="device-icon" />
      <span className="device-main">
        {editing ? (
          <input
            className="field"
            autoFocus
            defaultValue={device.name}
            aria-label="Device name"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              setEditing(false);
              const v = e.currentTarget.value.trim();
              if (v && v !== device.name) onRename(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="device-name">
            {device.name}
            {device.thisDevice && <span className="badge">This device</span>}
          </span>
        )}
        <span className="device-meta">
          <code className="fp" title={device.id}>
            {fingerprint(device.id)}
          </code>
          <CopyId id={device.id} />, linked {dateFmt.format(device.linked)}
        </span>
        {status !== undefined && (
          <span className="sync-line" data-state={syncLine(status, syncOn).state}>
            {syncLine(status, syncOn).text}
          </span>
        )}
      </span>
      <span className="device-tools">
        <button className="tool" aria-label={`Rename ${device.name}`} title="Rename" onClick={() => setEditing(true)}>
          <Icon name="pencil" />
        </button>
        {!device.thisDevice &&
          (confirming ? (
            <button className="danger-btn small" onClick={onRemove}>
              Remove {device.name}
            </button>
          ) : (
            <button className="tool" aria-label={`Remove ${device.name}`} title="Remove" onClick={() => setConfirming(true)}>
              <Icon name="trash" />
            </button>
          ))}
      </span>
    </li>
  );
}

/** Copies the full 64-character device ID, e.g. for a relay allowlist. */
function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="copy-id"
      title="Copy the full device ID"
      onClick={() => copy(id, null).then((ok) => setCopied(ok))}
    >
      {copied ? "Copied" : "Copy ID"}
    </button>
  );
}

function useCountdown(until: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, until - now) : 0;
}

const LIFETIMES: { minutes: number; label: string }[] = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 8 * 60, label: "8 hours" },
  { minutes: 24 * 60, label: "24 hours" },
  { minutes: 7 * 24 * 60, label: "7 days" },
];

/** "3d 4h", "2h 05m", or "4:59" when under an hour. */
function remaining(ms: number) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function CreateLink({ onError }: { onError: (err: unknown) => void }) {
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [minutes, setMinutes] = useState(15);
  const [copied, setCopied] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const left = useCountdown(invite?.expires ?? null);
  const expired = invite !== null && left === 0;

  return (
    <section className="card">
      <h2>Link another device</h2>
      <p className="muted small">
        Creates a one-time code that lets another device join your identity. Anyone with the code and passphrase can,
        so treat them like a password.
      </p>
      {!invite || expired ? (
        <>
          <label className="setting">
            <span>Code works for</span>
            <select className="field" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {LIFETIMES.map((l) => (
                <option key={l.minutes} value={l.minutes}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {minutes > 60 && (
            <p className="hint">
              A long window is fine when the other device is somewhere else: the passphrase is what protects the code.
              Keep the passphrase on this screen until you need it.
            </p>
          )}
          <button
            className="primary"
            onClick={() =>
              api.createLinkCode(minutes).then((i) => {
                setInvite(i);
                setCopied(false);
              }, onError)
            }
          >
            {expired ? "Create a new code" : "Create link code"}
          </button>
        </>
      ) : (
        <div className="invite">
          <label className="setting">
            <span>1. Send this code to your other device, any way you like</span>
            <textarea ref={area} className="field code-box" readOnly value={invite.code} rows={3} />
          </label>
          <button
            className="ghost"
            onClick={() => copy(invite.code, area.current).then(setCopied)}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
          <div className="setting">
            <span>2. Type this passphrase on that device. Don't send it with the code.</span>
            <code className="passphrase">{invite.passphrase}</code>
          </div>
          <p className="hint">Expires in {remaining(left)}</p>
        </div>
      )}
    </section>
  );
}

function JoinWithCode({ onError }: { onError: (err: unknown) => void }) {
  const { account, setAccount } = useAccount();
  const [code, setCode] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  const join = async () => {
    setBusy(true);
    try {
      setAccount(await api.joinWithCode(code, pass));
      setJoined(true);
      setCode("");
      setPass("");
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Join with a link code</h2>
      <p className="muted small">
        Makes this device one of yours. It takes on your identity from the other device; workspaces already on this
        device stay here.
      </p>
      {joined ? (
        <p className="report ok">
          <Icon name="check" /> Linked as {account?.name || "your identity"}.
        </p>
      ) : (
        <form
          className="join"
          onSubmit={(e) => {
            e.preventDefault();
            join();
          }}
        >
          <label className="setting">
            <span>Link code</span>
            <textarea
              className="field code-box"
              rows={3}
              value={code}
              placeholder="notes-invite-1…"
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="setting">
            <span>Passphrase</span>
            <input
              className="field passphrase-input"
              value={pass}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPass(e.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={busy || !code.trim() || !pass.trim()}>
            {busy ? "Checking…" : "Join"}
          </button>
        </form>
      )}
    </section>
  );
}

function SyncCard({
  status,
  onStatus,
  onError,
}: {
  status: SyncStatus | null;
  onStatus: (s: SyncStatus) => void;
  onError: (err: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [relay, setRelay] = useState<string | null>(null);
  const { openHelp } = useContext(NavContext);
  if (!status) return null;
  const s = status.settings;
  const relayValue = relay ?? s.relay;

  const save = async (next: { enabled: boolean; relay: string }) => {
    setBusy(true);
    try {
      onStatus(await api.setSyncSettings(next));
      setRelay(null);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const summary = !s.enabled
    ? "Off. Use update files to move changes between devices."
    : !status.running
      ? "Starting…"
      : !s.relay
        ? "On, local network only."
        : status.relayConnected
          ? "On. Reachable from anywhere through the relay."
          : "On. Can't reach the relay right now, so only devices on this network can sync.";

  return (
    <section className="card">
      <div className="sync-head">
        <h2>Live sync</h2>
        <button
          className="ghost"
          disabled={busy || !status.running}
          onClick={async () => {
            setBusy(true);
            try {
              onStatus(await api.syncNow());
            } catch (e) {
              onError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Syncing…" : "Sync now"}
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => save({ ...s, enabled: e.target.checked })} />
        <span>
          Sync with my devices, and people I share with, while they're online
          <span className="check-hint">{summary}</span>
        </span>
      </label>

      <div className="setting relay">
        <span>Relay server</span>
        <div className="relay-row">
          <input
            className="field"
            value={relayValue}
            placeholder="None: local network only"
            spellCheck={false}
            onChange={(e) => setRelay(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save({ ...s, relay: relayValue.trim() })}
          />
          <button className="ghost" disabled={busy || relayValue.trim() === s.relay} onClick={() => save({ ...s, relay: relayValue.trim() })}>
            Save
          </button>
        </div>
        <p className="hint">
          The relay helps your devices find each other across networks and carries traffic only when a direct connection
          isn't possible. It sees encrypted bytes, never your notes. Leave empty to sync only on the same network.
          {" "}
          <button className="link-btn inline" onClick={() => openHelp("relay")}>
            Set up your own relay
          </button>
          {s.relay !== DEFAULT_RELAY && (
            <>
              {" "}
              <button className="link-btn inline" onClick={() => save({ ...s, relay: DEFAULT_RELAY })}>
                Use iroh's public relay
              </button>
            </>
          )}
        </p>
      </div>

      {status.problems.length > 0 && (
        <details className="sync-problems">
          <summary className="small muted">Recent sync messages ({status.problems.length})</summary>
          <ul className="small">
            {status.problems.slice().reverse().map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const DEFAULT_RELAY = "https://use1-1.relay.n0.iroh.link./";
