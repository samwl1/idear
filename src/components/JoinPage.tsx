import { useCallback, useEffect, useRef, useState } from "react";
import { api, type JoinView } from "../lib/api";
import { ago } from "../lib/clipboard";
import { useNav } from "../lib/nav";
import { Icon } from "./Icon";

interface Props {
  /** Switch to a workspace once it has arrived. */
  onOpen: (id: string) => void;
  onError: (err: unknown) => void;
}

/** Paste an invite link; the workspace arrives once the owner's device answers. */
export function JoinPage({ onOpen, onError }: Props) {
  const [token, setToken] = useState("");
  const [pass, setPass] = useState("");
  const [needsPass, setNeedsPass] = useState(false);
  const [joins, setJoins] = useState<JoinView[] | null>(null);
  const [joined, setJoined] = useState<JoinView[]>([]);
  const [busy, setBusy] = useState(false);
  const { openHelp } = useNav();
  const waiting = useRef<JoinView[]>([]);

  // A join that's no longer waiting either arrived or was cancelled; the workspace list says which.
  const refresh = useCallback(async () => {
    try {
      const [list, workspaces] = await Promise.all([api.listJoins(), api.listWorkspaces()]);
      const done = waiting.current.filter(
        (j) => !list.some((x) => x.id === j.id) && j.workspace && workspaces.some((w) => w.id === j.workspace),
      );
      if (done.length) setJoined((cur) => [...cur, ...done]);
      waiting.current = list;
      setJoins(list);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // A sealed link asks for its passphrase before Join does anything.
  useEffect(() => {
    const t = token.trim();
    if (!t) {
      setNeedsPass(false);
      return;
    }
    api.inspectInvite(t).then(setNeedsPass, () => setNeedsPass(false));
  }, [token]);

  const join = async () => {
    setBusy(true);
    try {
      await api.joinShared(token, needsPass ? pass : undefined);
      setToken("");
      setPass("");
      // Try right away rather than waiting for the next round.
      api.syncNow().catch(() => {});
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="share">
      <header className="devices-head">
        <h1>
          <Icon name="link" /> Join a shared workspace
        </h1>
        <p className="muted">
          Paste the invite link someone sent you. The workspace arrives the first time your device reaches one of
          theirs, which can take a moment, or longer if they're offline.
        </p>
      </header>

      <section className="card">
        <textarea
          className="field code-box"
          rows={2}
          value={token}
          placeholder="idear-share-2.…"
          aria-label="Invite link"
          onChange={(e) => setToken(e.target.value)}
        />
        {needsPass && (
          <label className="setting">
            <span>Passphrase</span>
            <input
              className="field"
              value={pass}
              placeholder="From whoever sent the link"
              aria-label="Invite passphrase"
              autoComplete="off"
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pass.trim() && join()}
            />
          </label>
        )}
        <button className="primary" disabled={busy || !token.trim() || (needsPass && !pass.trim())} onClick={join}>
          {busy ? "Checking…" : "Join"}
        </button>
        <p className="hint">
          Check who it's from before joining: the owner and everyone they add can see your name and your devices'
          network addresses.{" "}
          <button className="link-btn" onClick={() => openHelp("sharing")}>
            How sharing works
          </button>
        </p>
      </section>

      {joined.length > 0 && (
        <section className="card">
          <h2>Joined</h2>
          <ul className="people">
            {joined.map((j) => (
              <li key={j.id} className="person">
                <span className="person-main">
                  <span className="person-name">{j.workspaceName}</span>
                  <span className="person-meta">From {j.ownerName || "the owner"}.</span>
                </span>
                <span className="person-actions">
                  <button className="primary" onClick={() => onOpen(j.workspace)}>
                    Open
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {joins && joins.length > 0 && (
        <section className="card">
          <h2>Waiting to join</h2>
          <ul className="people">
            {joins.map((j) => (
              <li key={j.id} className="person">
                <span className="person-main">
                  <span className="person-name">
                    {j.workspaceName || "A shared workspace"} <span className="muted">· from {j.ownerName || "the owner"}</span>
                  </span>
                  <span className="person-meta">
                    <span className="sync-line" data-state={j.status === "declined" ? "error" : j.lastError ? "warn" : "idle"}>
                      {j.status === "declined"
                        ? "The owner declined"
                        : j.status === "waiting"
                          ? "Waiting for the owner to approve you"
                          : j.lastError
                            ? `${j.lastError}${j.lastAttempt ? `, tried ${ago(j.lastAttempt)}` : ""}`
                            : "Trying to reach them…"}
                    </span>
                  </span>
                </span>
                <span className="person-actions">
                  <button
                    className="ghost"
                    onClick={() =>
                      api.cancelJoin(j.id).then((list) => {
                        waiting.current = list;
                        setJoins(list);
                      }, onError)
                    }
                  >
                    {j.status === "declined" ? "Dismiss" : "Cancel"}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">Joining keeps retrying in the background while the app is open.</p>
        </section>
      )}
    </section>
  );
}
