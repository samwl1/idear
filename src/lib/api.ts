// Thin typed wrappers over the Rust commands.
import { invoke } from "@tauri-apps/api/core";

export type Role = "owner" | "editor" | "viewer" | "removed";

export interface WorkspaceInfo {
  id: string;
  name: string;
  /** Your role in it. */
  role: Role;
  /** Shared with anyone besides its owner. */
  shared: boolean;
  ownerName: string;
}

export const canEditRole = (role: Role | undefined) => role === "owner" || role === "editor";

export interface PersonView {
  user: string;
  name: string;
  role: Role;
  since: number;
  isYou: boolean;
  /** Their devices allowed to sync, keyed like sync status peers. */
  devices: string[];
}

export interface ShareInvite {
  id: string;
  role: Role;
  label: string;
  expires: number;
  issued: number;
  status: "open" | "used" | "expired" | "cancelled";
  usedBy: string | null;
}

export interface ShareInfo {
  role: Role;
  isOwner: boolean;
  ownerName: string;
  people: PersonView[];
  invites: ShareInvite[];
}

export interface JoinView {
  workspace: string;
  workspaceName: string;
  ownerName: string;
  role: Role;
  added: number;
  expires: number;
  lastAttempt: number | null;
  lastError: string | null;
}

export interface Contact {
  user: string;
  name: string;
  workspaces: string[];
  canReceiveFiles: boolean;
}

export type ItemKind = "note" | "whiteboard" | "tracker";
export type NodeKind = "folder" | ItemKind;

export interface TreeNode {
  id: string;
  kind: NodeKind;
  parent: string | null;
  sortKey: string;
  title: string;
}

export type ViewSort = "updated" | "created" | "title";

/** Anything a view can return: tree items plus project tasks. */
export type EntityKind = NodeKind | "task" | "phase";
export type Category = "todo" | "doing" | "done";

export interface ViewQuery {
  types: EntityKind[];
  tags: string[];
  text: string;
  updatedWithinDays: number | null;
  sort: ViewSort;
  /** Tasks only: status categories to include. */
  statuses: Category[];
  /** Tasks only: assignee, `*` globs. */
  assignee: string;
  /** Tasks only: key prefixes such as "BUG" or "SYNC*". Empty means any. */
  keys: string[];
}

export interface ViewRow {
  id: string;
  kind: EntityKind;
  title: string;
  parentTitle: string | null;
  tags: string[];
  updatedAt: number;
  tracker: string | null;
  trackerTitle: string | null;
  key: string | null;
  status: string | null;
}

/** One end of a link. `kind` is null when the linked item has been deleted. */
export interface LinkRef {
  id: string;
  kind: EntityKind | null;
  title: string;
  tracker: string | null;
  trackerTitle: string | null;
  key: string | null;
}

export interface Links {
  /** What this item links to. */
  outgoing: LinkRef[];
  /** What links to this item. */
  incoming: LinkRef[];
}

export interface HubRow {
  id: string;
  title: string;
  folder: string | null;
  tags: string[];
  summary: string;
  words: number;
  createdAt: number;
  updatedAt: number;
  links: Links;
}

export interface DeviceView {
  id: string;
  name: string;
  linked: number;
  revoked: number | null;
  thisDevice: boolean;
}

export interface AccountView {
  userId: string;
  name: string;
  thisDevice: string;
  devices: DeviceView[];
}

export interface InviteView {
  code: string;
  passphrase: string;
  expires: number;
}

export interface WorkspaceImport {
  id: string;
  name: string;
  created: boolean;
  eventsAdded: number;
  eventsRejected: number;
  docsUpdated: number;
  changesAdded: number;
  untrusted: string[];
  problems: string[];
}

export interface ImportView {
  workspaces: WorkspaceImport[];
  identityChanged: boolean;
  fromDevice: string;
  created: number;
}

export interface SyncSettings {
  enabled: boolean;
  /** Relay server URL, or empty for local network only. */
  relay: string;
}

export interface PeerStatus {
  /** The user the device belongs to. */
  user: string;
  lastSync: number | null;
  lastAttempt: number | null;
  lastError: string | null;
}

export interface SyncStatus {
  settings: SyncSettings;
  running: boolean;
  relayConnected: boolean;
  peers: Record<string, PeerStatus>;
  problems: string[];
}

/** Sent by the backend when another device's changes were merged. */
export interface SyncApplied {
  changed: Record<string, string[]>;
  newWorkspaces: boolean;
  identityChanged: boolean;
  /** Workspaces whose people or roles changed. */
  membersChanged: string[];
  /** Workspaces another of your devices deleted. */
  removedWorkspaces: string[];
  problems: string[];
}

export type ClaudeAccess = "editor" | "viewer" | "none";

export interface ClaudeStatus {
  /** What Claude runs: this app with `mcp`. */
  command: string;
  /** Claude has connected at least once. */
  seen: boolean;
  name: string;
  desktop: { found: boolean; connected: boolean; stale: boolean; path: string };
  codeCommand: string;
  workspaces: {
    id: string;
    name: string;
    canManage: boolean;
    access: ClaudeAccess;
    /** Access given; Claude hasn't connected to pick it up yet. */
    waiting: boolean;
  }[];
}

export interface Trashed {
  id: string;
  name: string;
  deletedAt: number;
  /** Still in this device's trash, so it can be restored here. */
  restorable: boolean;
}

export interface EventView {
  seq: number;
  ts: number;
  action: string;
  target: string;
  targetTitle: string | null;
  device: string;
  deviceName: string | null;
  thisDevice: boolean;
  hash: string;
}

export interface VerifyReport {
  ok: boolean;
  events: number;
  devices: number;
  problems: string[];
}

const bytes = (b: Uint8Array) => Array.from(b);

export const api = {
  /** What's at a local folder linked from a task or project. */
  gitInfo: (path: string) => invoke<{ isRepo: boolean; remote: string | null; branch: string | null }>("git_info", { path }),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  /** Branch names of a local checkout (read from .git) or a remote (`git ls-remote`). */
  gitBranches: (source: { path?: string; url?: string }) => invoke<{ branches: string[]; source: "local" | "remote"; error: string | null }>("git_branches", source),
  accountInfo: () => invoke<AccountView>("account_info"),
  setUserName: (name: string) => invoke<AccountView>("set_user_name", { name }),
  renameDevice: (device: string, name: string) => invoke<AccountView>("rename_device", { device, name }),
  createLinkCode: (minutes: number) => invoke<InviteView>("create_link_code", { minutes }),
  joinWithCode: (code: string, passphrase: string) => invoke<AccountView>("join_with_code", { code, passphrase }),
  revokeDevice: (device: string) => invoke<AccountView>("revoke_device", { device }),
  /** `recipient` is a person's user ID; leave it out for your own devices. */
  exportUpdate: (path: string, workspaceIds: string[], recipient?: string) =>
    invoke<{ workspaces: number; bytes: number }>("export_update", { path, workspaceIds, recipient: recipient ?? null }),
  importUpdate: (path: string) => invoke<ImportView>("import_update", { path }),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  syncNow: () => invoke<SyncStatus>("sync_now"),
  setSyncSettings: (settings: SyncSettings) => invoke<SyncStatus>("set_sync_settings", { settings }),

  deviceId: () => invoke<string>("device_id"),

  listWorkspaces: () => invoke<WorkspaceInfo[]>("list_workspaces"),

  createWorkspace: (id: string, manifest: Uint8Array) =>
    invoke<WorkspaceInfo>("create_workspace", { id, manifest: bytes(manifest) }),
  deleteWorkspace: (id: string) => invoke<void>("delete_workspace", { id }),
  restoreWorkspace: (id: string) => invoke<WorkspaceInfo>("restore_workspace", { id }),
  purgeWorkspace: (id: string) => invoke<void>("purge_workspace", { id }),
  listTrash: () => invoke<Trashed[]>("list_trash"),

  claudeStatus: () => invoke<ClaudeStatus>("claude_status"),
  claudeSetAccess: (workspaceId: string, access: ClaudeAccess) =>
    invoke<ClaudeStatus>("claude_set_access", { workspaceId, access }),
  claudeConnectDesktop: (connect: boolean) => invoke<ClaudeStatus>("claude_connect_desktop", { connect }),

  loadDoc: async (workspaceId: string, docId: string) =>
    new Uint8Array(await invoke<ArrayBuffer>("load_doc", { workspaceId, docId })),

  createDoc: (workspaceId: string, docId: string, kind: string, doc: Uint8Array, action: string) =>
    invoke<void>("create_doc", { workspaceId, docId, kind, bytes: bytes(doc), action }),

  /** `subject` is the entity the change is about, when it isn't the doc itself. */
  applyChange: (
    workspaceId: string,
    docId: string,
    change: Uint8Array,
    action: string,
    subject?: string,
  ) => invoke<void>("apply_change", { workspaceId, docId, change: bytes(change), action, subject }),

  tree: (workspaceId: string) => invoke<TreeNode[]>("get_tree", { workspaceId }),

  notesHub: (workspaceId: string) => invoke<HubRow[]>("notes_hub", { workspaceId }),

  linksOf: (workspaceId: string, id: string) => invoke<Links>("links_of", { workspaceId, id }),

  runView: (workspaceId: string, query: ViewQuery) =>
    invoke<ViewRow[]>("run_view", { workspaceId, query }),

  events: (workspaceId: string, limit = 200, offset = 0) =>
    invoke<EventView[]>("list_events", { workspaceId, limit, offset }),

  verifyLog: (workspaceId: string) => invoke<VerifyReport>("verify_log", { workspaceId }),

  shareInfo: (workspaceId: string) => invoke<ShareInfo>("share_info", { workspaceId }),
  createInvite: (workspaceId: string, role: "editor" | "viewer", label: string, days: number) =>
    invoke<{ token: string; info: ShareInfo }>("create_invite", { workspaceId, role, label, days }),
  cancelInvite: (workspaceId: string, invite: string) => invoke<ShareInfo>("cancel_invite", { workspaceId, invite }),
  setMemberRole: (workspaceId: string, user: string, role: "editor" | "viewer" | "removed") =>
    invoke<ShareInfo>("set_member_role", { workspaceId, user, role }),
  joinShared: (token: string) => invoke<JoinView>("join_shared", { token }),
  listJoins: () => invoke<JoinView[]>("list_joins"),
  cancelJoin: (workspace: string) => invoke<JoinView[]>("cancel_join", { workspace }),
  shareContacts: () => invoke<Contact[]>("share_contacts"),
};
