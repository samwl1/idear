// Git links: repositories on projects, branches on tasks. The Repo list lives
// in the synced project doc. Where a local repository is on *this* device
// lives here, in localStorage, keyed by the repo's id.
import { openPath } from "@tauri-apps/plugin-opener";
import { open as pickDialog } from "@tauri-apps/plugin-dialog";
import type { BranchRef, Repo } from "../tracker/model";
import { openExternal } from "./openLink";
import { api } from "./api";

const PATHS_KEY = "repopaths";
const OPEN_WITH_KEY = "git:open-with";

function readPaths(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(PATHS_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** The folder a local repository is in on this device, or "". */
export function repoPath(id: string): string {
  return readPaths()[id] ?? "";
}

export function setRepoPath(id: string, path: string) {
  const all = readPaths();
  if (path) all[id] = path;
  else delete all[id];
  try {
    localStorage.setItem(PATHS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable: the mapping lasts for this session only
  }
  window.dispatchEvent(new Event("repopaths"));
}

/** App that opens linked folders on this device. Empty: the file manager. */
export function openWithApp(): string {
  try {
    return localStorage.getItem(OPEN_WITH_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setOpenWithApp(app: string) {
  try {
    if (app.trim()) localStorage.setItem(OPEN_WITH_KEY, app.trim());
    else localStorage.removeItem(OPEN_WITH_KEY);
  } catch {
    // ignore
  }
}

// ---- URLs -------------------------------------------------------------------------

export interface ParsedUrl {
  /** The repository's page, without any branch part. */
  url: string;
  /** "owner/repo". */
  name: string;
  /** A branch named in the pasted link, if any. */
  branch?: string;
  /** The host's short name, for the tooltip. */
  host: string;
}

interface Host {
  test: RegExp;
  host: string;
  /** Captures owner, repo, and an optional branch from the path. */
  path: RegExp;
  /** The page for a branch, given the repo page. */
  branch: (repoUrl: string, branch: string) => string;
}

const enc = (b: string) => b.split("/").map(encodeURIComponent).join("/");

const HOSTS: Host[] = [
  { test: /^(www\.)?github\.com$/i, host: "GitHub", path: /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+?))?\/?$/, branch: (u, b) => `${u}/tree/${enc(b)}` },
  { test: /gitlab/i, host: "GitLab", path: /^\/(.+?)\/([^/]+?)(?:\.git)?(?:\/-\/(?:tree|commits)\/(.+?))?\/?$/, branch: (u, b) => `${u}/-/tree/${enc(b)}` },
  { test: /^(www\.)?bitbucket\.org$/i, host: "Bitbucket", path: /^\/([^/]+)\/([^/]+?)(?:\/(?:branch|src)\/(.+?))?\/?$/, branch: (u, b) => `${u}/branch/${enc(b)}` },
  { test: /^codeberg\.org$|gitea|forgejo/i, host: "Codeberg", path: /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/src\/branch\/(.+?))?\/?$/, branch: (u, b) => `${u}/src/branch/${enc(b)}` },
];

/** Read a pasted repository (or branch) link from a known code host. */
export function parseRepoUrl(raw: string): ParsedUrl | null {
  let text = raw.trim();
  if (!text) return null;
  // "git@github.com:sam/idear.git" pastes work too.
  const ssh = /^(?:[\w.-]+@)?([\w.-]+):([\w./-]+?)(?:\.git)?$/.exec(text);
  if (ssh && !/^[a-z]+:\/\//i.test(text)) text = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  for (const h of HOSTS) {
    if (!h.test.test(u.hostname)) continue;
    const m = h.path.exec(decodeURIComponent(u.pathname));
    if (!m) return null;
    const [, owner, repo, branch] = m;
    return { url: `${u.origin}/${owner}/${repo}`, name: `${owner}/${repo}`, branch: branch || undefined, host: h.host };
  }
  return null;
}

/** The page for a branch of a remote repository, or null when the host isn't known. */
export function branchUrl(repo: Repo, branch: string): string | null {
  if (!repo.url) return null;
  try {
    const u = new URL(repo.url);
    const h = HOSTS.find((x) => x.test.test(u.hostname));
    return h ? h.branch(repo.url.replace(/\/$/, ""), branch) : null;
  } catch {
    return null;
  }
}

/** "git@github.com:sam/idear.git" or an https remote → "github.com/sam/idear". */
export function normalizeRemote(remote: string): string {
  const r = remote.trim().replace(/\.git$/, "");
  const ssh = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/.exec(r);
  if (ssh && !/^[a-z]+:\/\//i.test(r)) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
  try {
    const u = new URL(r);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return r.toLowerCase();
  }
}

/** Last path segment: "/Users/sam/code/idear" → "idear". */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

// ---- opening -----------------------------------------------------------------------

/** Whether a repository can be opened from this device right now. */
export function repoReady(repo: Repo): boolean {
  return repo.kind === "local" ? !!repoPath(repo.id) : !!repo.url;
}

export function openRepo(repo: Repo, onError?: (err: unknown) => void): boolean {
  if (repo.kind === "local") {
    const path = repoPath(repo.id);
    if (!path) return false;
    const app = openWithApp();
    openPath(path, app || undefined).catch((err) => onError?.(err) ?? console.error(err));
    return true;
  }
  return openExternal(repo.url, onError);
}

/** A branch opens its page on the host, or the local folder (git can't be told to check it out from here). */
export function openBranch(repo: Repo, branch: string, onError?: (err: unknown) => void): boolean {
  if (repo.kind === "remote") {
    const url = branchUrl(repo, branch) ?? repo.url;
    return openExternal(url, onError);
  }
  return openRepo(repo, onError);
}

export function branchReady(repos: Repo[], b: BranchRef): boolean {
  const r = repos.find((x) => x.id === b.repo);
  return !!r && repoReady(r);
}

export interface GitInfo {
  isRepo: boolean;
  remote: string | null;
  branch: string | null;
}

/** Native folder picker; null when cancelled. */
export async function pickFolder(title: string): Promise<string | null> {
  const r = await pickDialog({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : null;
}

export const gitInfo = (path: string) => api.gitInfo(path);
export const pathExists = (path: string) => api.pathExists(path);

/** "idear" from "sam/idear". */
export function repoShort(repo: Repo): string {
  return repo.name.split("/").pop() || repo.name;
}

// ---- branches ----------------------------------------------------------------------

export interface BranchCheck {
  branches: string[];
  source: "local" | "remote";
  error: string | null;
}

const branchCache = new Map<string, { at: number; value: BranchCheck }>();
const BRANCH_TTL = 5 * 60_000;

/**
 * The branches a repository has, from this device's checkout or from the
 * remote (`git ls-remote`, which needs git and network). Cached briefly.
 */
export async function listBranches(repo: Repo, fresh = false): Promise<BranchCheck> {
  const path = repo.kind === "local" ? repoPath(repo.id) : "";
  const key = `${repo.id}:${path || repo.url || ""}`;
  const hit = branchCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < BRANCH_TTL) return hit.value;
  let value: BranchCheck;
  if (path) value = await api.gitBranches({ path });
  else if (repo.url) value = await api.gitBranches({ url: repo.url });
  else value = { branches: [], source: "local", error: "Not on this device" };
  branchCache.set(key, { at: Date.now(), value });
  return value;
}
