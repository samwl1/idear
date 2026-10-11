// The Git button: repositories on a project, branches on a task. Grey when
// nothing is linked, filled when it can be opened from here, outlined when a
// local repository hasn't been found on this device yet.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { BranchRef, Repo } from "../tracker/model";
import { Icon } from "./Icon";
import { useAccount } from "../lib/account";
import { useCanEdit } from "../lib/access";
import { v7 as uuidv7 } from "uuid";
import {
  baseName,
  branchReady,
  gitInfo,
  listBranches,
  type BranchCheck,
  normalizeRemote,
  openBranch,
  openRepo,
  parseRepoUrl,
  pathExists,
  pickFolder,
  repoPath,
  repoReady,
  repoShort,
  setRepoPath,
} from "../lib/git";

/** Re-render when a local path is mapped on this device. */
function usePathsVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    window.addEventListener("repopaths", bump);
    return () => window.removeEventListener("repopaths", bump);
  }, []);
  return v;
}

function useMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: globalThis.MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return { open, setOpen, root };
}

type State = "none" | "ready" | "away";

function Toggle({
  state,
  count,
  label,
  title,
  open,
  onClick,
  onMenu,
}: {
  state: State;
  count: number;
  label?: string;
  title: string;
  open: boolean;
  onClick: (e: MouseEvent) => void;
  onMenu: () => void;
}) {
  return (
    <button
      type="button"
      className={label !== undefined ? "tool git-toggle git-toggle-wide" : "tool git-toggle"}
      data-state={state}
      aria-label={title}
      aria-expanded={open}
      title={title}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu();
      }}
    >
      <Icon name="branch" />
      {count > 1 && label === undefined && <span className="git-count">{count}</span>}
      {label !== undefined && <span className="git-label">{label}</span>}
    </button>
  );
}

// ---- project: repositories -------------------------------------------------------

export function RepoButton({
  repos,
  onChange,
  onError,
  align = "left",
  withLabel,
}: {
  repos: Repo[];
  onChange?: (repos: Repo[]) => void;
  onError: (err: unknown) => void;
  align?: "left" | "right";
  withLabel?: boolean;
}) {
  const { open, setOpen, root } = useMenu();
  usePathsVersion();
  const canEdit = useCanEdit() && !!onChange;
  const ready = repos.filter(repoReady);
  const state: State = repos.length === 0 ? "none" : ready.length ? "ready" : "away";
  const title =
    repos.length === 0
      ? canEdit
        ? "Link a repository"
        : "No repository linked"
      : repos.length === 1
        ? `${repos[0].name}${repoReady(repos[0]) ? "" : " (not on this device)"}. Right-click to add or edit.`
        : `${repos.length} repositories. Click for the list.`;
  const label = withLabel ? (repos.length === 0 ? "Git" : repos.length === 1 ? repoShort(repos[0]) : `${repos.length} repos`) : undefined;

  return (
    <span className="git" ref={root} onClick={(e) => e.stopPropagation()}>
      <Toggle
        state={state}
        count={repos.length}
        label={label}
        title={title}
        open={open}
        onMenu={() => (repos.length || canEdit) && setOpen(!open)}
        onClick={(e) => {
          e.stopPropagation();
          if (repos.length === 1 && repoReady(repos[0]) && !e.altKey) {
            openRepo(repos[0], onError);
            return;
          }
          if (repos.length === 0 && !canEdit) return;
          setOpen(!open);
        }}
      />
      {open && (
        <div className="menu git-menu" data-align={align} role="dialog" aria-label="Repositories">
          <RepoList repos={repos} onChange={canEdit ? onChange : undefined} onError={onError} onOpened={() => setOpen(false)} />
        </div>
      )}
    </span>
  );
}

export function RepoList({
  repos,
  onChange,
  onError,
  onOpened,
}: {
  repos: Repo[];
  onChange?: (repos: Repo[]) => void;
  onError: (err: unknown) => void;
  onOpened?: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  usePathsVersion();
  const canEdit = !!onChange;
  const replace = (id: string, next: Repo | null) => {
    onChange?.(next ? repos.map((r) => (r.id === id ? next : r)) : repos.filter((r) => r.id !== id));
    if (!next) setRepoPath(id, "");
    setEditing(null);
  };

  return (
    <div className="git-list">
      {repos.length === 0 && !adding && <p className="muted small git-empty">{canEdit ? "No repository linked yet." : "No repository linked."}</p>}
      {repos.map((r) =>
        editing === r.id ? (
          <RepoForm key={r.id} initial={r} onDone={(next) => replace(r.id, next)} onCancel={() => setEditing(null)} />
        ) : (
          <RepoRow key={r.id} r={r} canEdit={canEdit} onError={onError} onEdit={() => setEditing(r.id)} onRemove={() => replace(r.id, null)} onOpened={onOpened} />
        ),
      )}
      {canEdit &&
        (adding ? (
          <AddRepo
            onError={onError}
            onDone={(r) => {
              setAdding(false);
              if (r) onChange?.([...repos, r]);
            }}
          />
        ) : (
          <button type="button" className="ghost git-add" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add repository
          </button>
        ))}
    </div>
  );
}

function RepoRow({
  r,
  canEdit,
  onError,
  onEdit,
  onRemove,
  onOpened,
}: {
  r: Repo;
  canEdit: boolean;
  onError: (err: unknown) => void;
  onEdit: () => void;
  onRemove: () => void;
  onOpened?: () => void;
}) {
  const here = r.kind === "local" ? repoPath(r.id) : "";
  const ok = repoReady(r);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!here) return;
    let live = true;
    pathExists(here).then((e) => live && setMissing(!e), () => {});
    return () => {
      live = false;
    };
  }, [here]);

  const sub =
    r.kind === "remote"
      ? (() => {
          try {
            return new URL(r.url!).hostname.replace(/^www\./, "");
          } catch {
            return r.url ?? "";
          }
        })()
      : here
        ? missing
          ? `${here} (not found)`
          : here
        : r.addedOn
          ? `Linked on ${r.addedOn.device} as ${r.addedOn.path}`
          : "Not on this device";

  return (
    <div className="git-row" data-away={!ok || missing || undefined}>
      <button
        type="button"
        className="git-open"
        disabled={!ok}
        title={ok ? (r.kind === "local" ? "Open the folder" : r.url) : "Not on this device"}
        onClick={() => {
          if (openRepo(r, onError)) onOpened?.();
        }}
      >
        <Icon name={r.kind === "local" ? "folder" : "branch"} />
        <span className="git-text">
          <span className="git-name">{r.name}</span>
          <span className="git-sub muted small">{sub}</span>
        </span>
      </button>
      {r.kind === "local" && (!here || missing) && <FindHere r={r} onError={onError} />}
      {canEdit && (
        <span className="git-tools">
          <button type="button" className="tool" aria-label="Edit repository" title="Edit" onClick={onEdit}>
            <Icon name="pencil" />
          </button>
          <button type="button" className="tool" aria-label="Remove repository" title="Remove" onClick={onRemove}>
            <Icon name="trash" />
          </button>
        </span>
      )}
    </div>
  );
}

/** For a local repository linked on another device: pick where it lives here. */
function FindHere({ r, onError }: { r: Repo; onError: (err: unknown) => void }) {
  const [same, setSame] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const suggested = r.addedOn?.path ?? "";

  useEffect(() => {
    if (!suggested) return;
    let live = true;
    pathExists(suggested).then((e) => live && setSame(e), () => {});
    return () => {
      live = false;
    };
  }, [suggested]);

  const use = async (path: string) => {
    setBusy(true);
    try {
      const info = await gitInfo(path);
      if (!info.isRepo) setNote("Not a git checkout. Linked anyway.");
      else if (r.origin && info.remote && normalizeRemote(info.remote) !== normalizeRemote(r.origin))
        setNote(`Its remote (${normalizeRemote(info.remote)}) differs from the one linked. Linked anyway.`);
      else setNote("");
      setRepoPath(r.id, path);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="git-find">
      {same && (
        <button type="button" className="ghost small" disabled={busy} onClick={() => use(suggested)}>
          Use the same path
        </button>
      )}
      <button
        type="button"
        className="ghost small"
        disabled={busy}
        onClick={async () => {
          try {
            const p = await pickFolder(`Where is ${r.name} on this device?`);
            if (p) await use(p);
          } catch (e) {
            onError(e);
          }
        }}
      >
        Find it on this device
      </button>
      {note && <span className="muted small git-note">{note}</span>}
    </span>
  );
}

/** Paste a repository link, or choose a folder. */
function AddRepo({ onDone, onError }: { onDone: (r: Repo | null) => void; onError: (err: unknown) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { account } = useAccount();
  const parsed = parseRepoUrl(text);
  const device = account?.devices.find((d) => d.thisDevice)?.name ?? "this device";

  const chooseFolder = async () => {
    setBusy(true);
    try {
      const path = await pickFolder("Link a repository folder");
      if (!path) return;
      const info = await gitInfo(path).catch(() => ({ isRepo: false, remote: null, branch: null }));
      const id = uuidv7();
      setRepoPath(id, path);
      onDone({ id, kind: "local", name: baseName(path), ...(info.remote ? { origin: info.remote } : {}), addedOn: { device, path } });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="git-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed) onDone({ id: uuidv7(), kind: "remote", url: parsed.url, name: parsed.name });
      }}
    >
      <input
        className="field"
        autoFocus
        value={text}
        placeholder="Paste a repository link"
        aria-label="Repository link"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone(null)}
      />
      {text.trim() && <p className="muted small git-hint">{parsed ? `${parsed.host}: ${parsed.name}` : "Not a link to a known code host (GitHub, GitLab, Bitbucket, Codeberg)."}</p>}
      <div className="git-form-foot">
        <button type="button" className="ghost small" disabled={busy} onClick={chooseFolder}>
          <Icon name="folder" /> Choose folder…
        </button>
        <span className="git-form-spacer" />
        <button type="button" className="ghost small" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button type="submit" className="primary small" disabled={!parsed}>
          Add
        </button>
      </div>
    </form>
  );
}

function RepoForm({ initial, onDone, onCancel }: { initial: Repo; onDone: (r: Repo) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url ?? "");
  const parsed = initial.kind === "remote" ? parseRepoUrl(url) : null;
  const valid = name.trim() !== "" && (initial.kind === "local" || !!parsed);
  return (
    <form
      className="git-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onDone({ ...initial, name: name.trim(), ...(parsed ? { url: parsed.url } : {}) });
      }}
    >
      <label className="git-field">
        <span className="muted small">Name</span>
        <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onCancel()} />
      </label>
      {initial.kind === "remote" && (
        <label className="git-field">
          <span className="muted small">Link</span>
          <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
      )}
      <div className="git-form-foot">
        <span className="git-form-spacer" />
        <button type="button" className="ghost small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary small" disabled={!valid}>
          Save
        </button>
      </div>
    </form>
  );
}

// ---- task: branches ----------------------------------------------------------------

export function BranchButton({
  repos,
  branches,
  onChange,
  onError,
  align = "right",
}: {
  /** The project's repositories. */
  repos: Repo[];
  branches: BranchRef[];
  onChange?: (branches: BranchRef[]) => void;
  onError: (err: unknown) => void;
  align?: "left" | "right";
}) {
  const { open, setOpen, root } = useMenu();
  usePathsVersion();
  const canEdit = useCanEdit() && !!onChange;
  const ready = branches.filter((b) => branchReady(repos, b));
  const state: State = branches.length === 0 ? "none" : ready.length ? "ready" : "away";
  const first = branches[0] && repos.find((r) => r.id === branches[0].repo);
  const title =
    branches.length === 0
      ? canEdit
        ? "Link a branch"
        : "No branch linked"
      : branches.length === 1
        ? `${first ? repoShort(first) : "?"} › ${branches[0].branch}${ready.length ? "" : " (not on this device)"}. Right-click for the list.`
        : `${branches.length} branches. Click for the list.`;

  return (
    <span className="git" ref={root} onClick={(e) => e.stopPropagation()}>
      <Toggle
        state={state}
        count={branches.length}
        title={title}
        open={open}
        onMenu={() => (branches.length || canEdit) && setOpen(!open)}
        onClick={(e) => {
          e.stopPropagation();
          if (branches.length === 1 && first && repoReady(first) && !e.altKey) {
            openBranch(first, branches[0].branch, onError);
            return;
          }
          if (branches.length === 0 && !canEdit) return;
          setOpen(!open);
        }}
      />
      {open && (
        <div className="menu git-menu" data-align={align} role="dialog" aria-label="Branches">
          <BranchList repos={repos} branches={branches} onChange={canEdit ? onChange : undefined} onError={onError} onOpened={() => setOpen(false)} />
        </div>
      )}
    </span>
  );
}

export function BranchList({
  repos,
  branches,
  onChange,
  onError,
  onOpened,
}: {
  repos: Repo[];
  branches: BranchRef[];
  onChange?: (branches: BranchRef[]) => void;
  onError: (err: unknown) => void;
  onOpened?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [name, setName] = useState("");
  const [check, setCheck] = useState<BranchCheck | "loading" | null>(null);
  usePathsVersion();
  const canEdit = !!onChange;
  const chosen = repos.find((r) => r.id === repoId) ?? repos[0];
  const valid = !!chosen && name.trim() !== "" && !branches.some((b) => b.repo === chosen.id && b.branch === name.trim());

  // Look the repository's branches up once the form opens, so the name can be checked as you type.
  useEffect(() => {
    if (!adding || !chosen) return;
    let live = true;
    setCheck("loading");
    listBranches(chosen).then(
      (c) => live && setCheck(c),
      (e) => live && setCheck({ branches: [], source: chosen.kind === "local" ? "local" : "remote", error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [adding, chosen]);

  const typed = name.trim();
  const status =
    !typed || check === null
      ? null
      : check === "loading"
        ? { kind: "wait", text: "Checking…" }
        : check.error
          ? { kind: "unknown", text: `Couldn't check: ${check.error.split("\n")[0]}` }
          : check.branches.includes(typed)
            ? { kind: "ok", text: `Exists ${check.source === "local" ? "in the checkout" : "on the remote"}` }
            : { kind: "missing", text: `Not among the ${check.branches.length} ${check.source === "local" ? "local" : "remote"} branches` };

  const add = () => {
    if (!valid || !chosen) return;
    onChange?.([...branches, { repo: chosen.id, branch: name.trim() }]);
    setName("");
  };

  return (
    <div className="git-list">
      {branches.length === 0 && !adding && <p className="muted small git-empty">{canEdit ? "No branch linked yet." : "No branch linked."}</p>}
      {branches.map((b, i) => {
        const r = repos.find((x) => x.id === b.repo);
        const ok = !!r && repoReady(r);
        return (
          <div key={`${b.repo}:${b.branch}`} className="git-row" data-away={!ok || undefined}>
            <button
              type="button"
              className="git-open"
              disabled={!ok}
              title={!r ? "Its repository was removed from the project" : ok ? (r.kind === "local" ? "Open the folder" : "Open the branch") : "Repository not on this device"}
              onClick={() => {
                if (r && openBranch(r, b.branch, onError)) onOpened?.();
              }}
            >
              <Icon name="branch" />
              <span className="git-text">
                <span className="git-name">{b.branch}</span>
                <span className="git-sub muted small">{r ? r.name : "Repository removed"}</span>
              </span>
            </button>
            {canEdit && (
              <span className="git-tools">
                <button type="button" className="tool" aria-label="Remove branch" title="Remove" onClick={() => onChange?.(branches.filter((_, j) => j !== i))}>
                  <Icon name="trash" />
                </button>
              </span>
            )}
          </div>
        );
      })}
      {canEdit &&
        (repos.length === 0 ? (
          <p className="muted small git-empty">Link a repository to the project first (the Git button by its title).</p>
        ) : adding ? (
          <form
            className="git-form"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <div className="git-branch-row">
              {repos.length > 1 && (
                <select className="field" aria-label="Repository" value={chosen?.id ?? ""} onChange={(e) => setRepoId(e.target.value)}>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {repoShort(r)}
                    </option>
                  ))}
                </select>
              )}
              <input
                className="field"
                autoFocus
                value={name}
                list="git-branch-names"
                placeholder={repos.length > 1 ? "Branch" : `Branch in ${chosen ? repoShort(chosen) : ""}`}
                aria-label="Branch name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
              />
              <datalist id="git-branch-names">
                {check !== null && check !== "loading" && check.branches.map((b) => <option key={b} value={b} />)}
              </datalist>
            </div>
            {status && (
              <p className="git-hint small" data-status={status.kind}>
                {status.kind === "ok" && <Icon name="check" />}
                {status.text}
                {status.kind !== "wait" && status.kind !== "ok" && " (you can still add it)"}
              </p>
            )}
            <div className="git-form-foot">
              <span className="git-form-spacer" />
              <button type="button" className="ghost small" onClick={() => setAdding(false)}>
                Done
              </button>
              <button type="submit" className="primary small" disabled={!valid}>
                Add
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="ghost git-add" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add branch
          </button>
        ))}
    </div>
  );
}
