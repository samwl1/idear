import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type Contact, type ImportView, type WorkspaceInfo } from "../lib/api";
import { Icon } from "./Icon";

const EXT = "idear";
/** Files saved under the app's earlier names end in .scramble or .notesupdate; they open the same way. */
const FILTERS = [{ name: "Update file", extensions: [EXT, "scramble", "notesupdate"] }];

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

interface Props {
  onImported: () => void;
  onError: (err: unknown) => void;
}

/** Move changes between your devices by file: USB, phone, cloud drive, anything. */
export function UpdateFiles({ onImported, onError }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [exported, setExported] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportView | null>(null);
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  /** A person's user ID, or "" for your own devices. */
  const [to, setTo] = useState("");
  const [sealed, setSealed] = useState(false);
  const [askPass, setAskPass] = useState<{ path: string; value: string } | null>(null);

  useEffect(() => {
    Promise.all([api.listWorkspaces(), api.shareContacts()]).then(([list, people]) => {
      setWorkspaces(list);
      setContacts(people);
      setPicked(new Set(list.map((w) => w.id)));
    }, onError);
  }, [onError, imported]);

  const contact = contacts.find((c) => c.user === to);
  // For a person, only what you both have.
  const offered = contact ? workspaces.filter((w) => contact.workspaces.includes(w.id)) : workspaces;
  const sending = [...picked].filter((id) => offered.some((w) => w.id === id));

  const pickRecipient = (user: string) => {
    setTo(user);
    setExported(null);
    const c = contacts.find((x) => x.user === user);
    setPicked(new Set(c ? c.workspaces : workspaces.map((w) => w.id)));
  };

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const doExport = async () => {
    const day = new Date().toISOString().slice(0, 10);
    const who = contact ? `-for-${contact.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "";
    const path = await save({ defaultPath: `idear-update${who}-${day}.${EXT}`, filters: FILTERS });
    if (!path) return;
    setBusy(true);
    try {
      const r = await api.exportUpdate(path, sending, to || undefined, sealed);
      const n = `${r.workspaces} ${r.workspaces === 1 ? "workspace" : "workspaces"} (${size(r.bytes)})`;
      setExported(
        r.passphrase
          ? `Saved ${n}. It opens with the passphrase ${r.passphrase} (send that by a different route; it isn't shown again).`
          : contact
            ? `Saved ${n}. Only ${contact.name} can open it.`
            : `Saved ${n}.`,
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    const path = await open({ multiple: false, directory: false, filters: FILTERS });
    if (!path || Array.isArray(path)) return;
    if (await api.inspectUpdate(path).catch(() => false)) {
      setAskPass({ path, value: "" });
      return;
    }
    await finishImport(path);
  };

  const finishImport = async (path: string, passphrase?: string) => {
    setBusy(true);
    try {
      setImported(await api.importUpdate(path, passphrase));
      setAskPass(null);
      onImported();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Update files</h2>
      <p className="muted small">
        Carry changes without any network: save an update file here, move it however you like, and open it on the
        other device. A file for your devices only opens on your devices; a file for someone you share with only opens
        on theirs, and holds only workspaces you share. Every change in it is signature-checked on import, and opening
        the same file twice is harmless.
      </p>

      <div className="updates">
        <div className="updates-col">
          <h3>Send</h3>
          {contacts.length > 0 && (
            <label className="setting">
              <span>For</span>
              <select className="field" value={to} onChange={(e) => pickRecipient(e.target.value)}>
                <option value="">My devices</option>
                {contacts.map((c) => (
                  <option key={c.user} value={c.user}>
                    {c.name || "Unnamed"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {contact && !contact.canReceiveFiles && !sealed && (
            <p className="report bad small">
              {contact.name} is on an older version, or you haven't synced with them yet. Sync once, or use a passphrase.
            </p>
          )}
          <label className="setting setting-check">
            <input type="checkbox" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
            <span>Seal with a passphrase instead{contact ? "" : " (opens on any device that has it)"}</span>
          </label>
          {offered.length === 0 ? (
            <p className="muted small">No workspaces to send yet.</p>
          ) : (
            <div className="ws-checks">
              {offered.map((w) => (
                <label key={w.id} className="check">
                  <input type="checkbox" checked={picked.has(w.id)} onChange={() => toggle(w.id)} />
                  <span>{w.name}</span>
                </label>
              ))}
            </div>
          )}
          <button
            className="primary"
            disabled={busy || sending.length === 0 || (contact && !contact.canReceiveFiles && !sealed)}
            onClick={doExport}
          >
            <Icon name="inbox" /> Save update file…
          </button>
          {exported && <p className="hint">{exported}</p>}
        </div>

        <div className="updates-col">
          <h3>Receive</h3>
          <button className="primary" disabled={busy} onClick={doImport}>
            <Icon name="inbox" /> Open update file…
          </button>
          {askPass && (
            <div className="invite">
              <label className="setting">
                <span>This file needs its passphrase</span>
                <input
                  className="field"
                  autoFocus
                  autoComplete="off"
                  value={askPass.value}
                  onChange={(e) => setAskPass({ ...askPass, value: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && askPass.value.trim() && finishImport(askPass.path, askPass.value)}
                />
              </label>
              <span className="row-actions">
                <button className="ghost" onClick={() => setAskPass(null)}>
                  Cancel
                </button>
                <button className="primary" disabled={busy || !askPass.value.trim()} onClick={() => finishImport(askPass.path, askPass.value)}>
                  Open
                </button>
              </span>
            </div>
          )}
          {imported && <ImportResult r={imported} />}
        </div>
      </div>
    </section>
  );
}

function ImportResult({ r }: { r: ImportView }) {
  const problems = r.workspaces.flatMap((w) => w.problems.map((p) => `${w.name || "Workspace"}: ${p}`));
  const untrusted = new Set(r.workspaces.flatMap((w) => w.untrusted));
  return (
    <div className="import-result">
      <p className="small muted">
        From {r.fromDevice}, saved {dateTime.format(r.created)}.
        {r.identityChanged && " Your device list was updated too."}
      </p>
      <ul>
        {r.workspaces.map((w) => (
          <li key={w.id}>
            <strong>{w.name || "Untitled workspace"}</strong>{" "}
            {w.created
              ? `added, ${w.changesAdded} changes`
              : w.changesAdded > 0
                ? `updated, ${w.changesAdded} new ${w.changesAdded === 1 ? "change" : "changes"}`
                : "already up to date"}
          </li>
        ))}
      </ul>
      {untrusted.size > 0 && (
        <p className="report bad small">
          Refused changes from {untrusted.size} {untrusted.size === 1 ? "device that isn't" : "devices that aren't"} allowed
          to change it.
        </p>
      )}
      {problems.length > 0 && (
        <ul className="report bad small">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
