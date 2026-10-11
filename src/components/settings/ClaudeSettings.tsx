import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ClaudeAccess, type ClaudeStatus } from "../../lib/api";
import { copy } from "../../lib/clipboard";
import { useNav } from "../../lib/nav";
import { Icon } from "../Icon";
import { Segmented } from "./controls";

const ACCESS: { value: ClaudeAccess; label: string }[] = [
  { value: "none", label: "No access" },
  { value: "viewer", label: "Can view" },
  { value: "editor", label: "Can edit" },
];

export function ClaudeSettings({ onError }: { onError: (err: unknown) => void }) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [syncOn, setSyncOn] = useState(true);
  const [copied, setCopied] = useState(false);
  const [restart, setRestart] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const { openHelp } = useNav();

  const refresh = useCallback(() => {
    api.claudeStatus().then(setStatus, onError);
    api.syncStatus().then((s) => setSyncOn(s.running), () => {});
  }, [onError]);

  // Claude picks up access in the background; keep the page current.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!status) return <div className="editor-loading" aria-busy="true" />;

  const setAccess = (id: string, access: ClaudeAccess) => api.claudeSetAccess(id, access).then(setStatus, onError);
  const desktop = (connect: boolean) =>
    api.claudeConnectDesktop(connect).then((s) => {
      setStatus(s);
      setRestart(true);
    }, onError);

  const owned = status.workspaces.filter((w) => w.canManage);
  const others = status.workspaces.filter((w) => !w.canManage && w.access !== "none");

  return (
    <div className="prefs">
      <section className="card">
        <h2>
          <Icon name="sparkle" /> Connect Claude
        </h2>
        <p className="muted small">
          idear has Claude's connection built in. Add it to Claude once, then choose below what Claude can see.
        </p>

        <div className="connect-row">
          <div>
            <span className="pref-label">Claude Desktop</span>
            <span className="pref-hint">
              {status.desktop.connected
                ? "Connected. Claude starts idear's connection whenever it opens."
                : status.desktop.stale
                  ? "Connected to a different copy of idear. Update it to use this one."
                  : status.desktop.found
                    ? "Adds idear to Claude Desktop's settings. A backup of them is kept."
                    : "Claude Desktop doesn't seem to be installed on this computer."}
            </span>
          </div>
          {status.desktop.connected ? (
            <button className="ghost" onClick={() => desktop(false)}>
              Disconnect
            </button>
          ) : (
            <button className="primary" onClick={() => desktop(true)}>
              {status.desktop.stale ? "Update" : "Connect"}
            </button>
          )}
        </div>
        {restart && (
          <p className="callout" role="status">
            Quit Claude Desktop completely and open it again to pick up the change.
          </p>
        )}

        <div className="connect-row stacked">
          <div>
            <span className="pref-label">Claude Code</span>
            <span className="pref-hint">Run this once in a terminal.</span>
          </div>
          <div className="code-copy">
            <textarea ref={box} className="field code-box" readOnly rows={2} value={status.codeCommand} />
            <button className="ghost" onClick={() => copy(status.codeCommand, box.current).then(setCopied)}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>What Claude can see</h2>
        {!syncOn && (
          <p className="callout warn" role="status">
            Live sync is off, so Claude can't receive workspaces. Turn it on under Devices.
          </p>
        )}
        <p className="muted small">
          Claude is its own member of each workspace you give it, like a person you invite. Its changes are signed
          and show up as {status.name} in Activity, and nothing can be deleted through it.
        </p>
        <ul className="ws-list">
          {owned.map((w) => (
            <li key={w.id} className="ws-row">
              <div className="ws-main">
                <span className="ws-name">{w.name}</span>
                {w.waiting && (
                  <span className="ws-meta wait">
                    Waiting for Claude. It picks this up the next time it connects while idear is open.
                  </span>
                )}
              </div>
              <Segmented label={`Claude's access to ${w.name}`} value={w.access} options={ACCESS} onChange={(a) => setAccess(w.id, a)} />
            </li>
          ))}
          {owned.length === 0 && <li className="muted small">You don't own any workspaces on this device yet.</li>}
        </ul>
        {others.length > 0 && (
          <>
            <h3 className="muted small">In other people's workspaces</h3>
            <ul className="ws-list">
              {others.map((w) => (
                <li key={w.id} className="ws-row">
                  <span className="ws-name">{w.name}</span>
                  <span className="ws-meta">{w.access === "editor" ? "Can edit" : "Can view"}, set by the owner</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="hint">
          Text in a shared workspace could try to steer Claude. Give edit access only where you trust everyone who can
          edit.{" "}
          <button className="link-btn" onClick={() => openHelp("claude")}>
            More about Claude and idear
          </button>
        </p>
      </section>
    </div>
  );
}
