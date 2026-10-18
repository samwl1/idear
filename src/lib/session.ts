// A WorkspaceSession owns the open workspace's Automerge docs on the frontend.
// Every edit becomes one Automerge change, which is sent to Rust to be applied,
// persisted, indexed, and signed into the event log. Writes are queued so Rust
// always receives changes in the order they were made.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { v7 as uuidv7 } from "uuid";
import { A } from "./automerge";
import { api, type ItemKind, type NodeKind, type ViewQuery, type WorkspaceInfo } from "./api";
import { flushAll } from "./pending";

export const MANIFEST = "manifest";
const READ_ONLY = "You can view this workspace but not change it.";
/** Image types an attachment may be shown as. SVG is left out: it can carry scripts. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export type { ItemKind, NodeKind };

export interface ManifestNode {
  kind: NodeKind;
  title?: string; // folders only; items keep their title in their own doc
  parent: string | null;
  order: string;
}

/** A piece of one workspace's tree, with its docs as plain values, on its way to another. */
export interface Subtree {
  nodes: Record<string, ManifestNode>;
  docs: Record<string, ItemBase>;
  views: ViewDef[];
}

/** A deep copy with no Automerge proxies left in it; immutable strings stay immutable. */
export function plainCopy(v: unknown): unknown {
  if (v instanceof A.ImmutableString) return new A.ImmutableString(v.val);
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (Array.isArray(v)) return v.map(plainCopy);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = plainCopy(x);
    return out;
  }
  return v;
}

export interface ViewDef {
  name: string;
  icon?: string;
  order: string;
  query: ViewQuery;
}

export type Manifest = {
  name: string;
  nodes: Record<string, ManifestNode>;
  views?: Record<string, ViewDef>;
  /** How the workspace shows in the switcher: a color name and an icon name. Synced with the workspace. */
  look?: WorkspaceLook;
};

export type WorkspaceLook = { color?: string; icon?: string };

/** A file stored inside an item's doc, so it syncs and is signed like any other change. */
export type Attachment = {
  name: string;
  /** MIME type, e.g. image/png. */
  type: string;
  data: Uint8Array;
  added: number;
};

/** Fields every item doc has. */
export type ItemBase = {
  title: string;
  tags: string[];
  /** Images in the body, referenced from markdown as `att:<id>`. */
  attachments?: Record<string, Attachment>;
};

export type Note = ItemBase & {
  body: string; // markdown
  /** Short summary, written in the Notes Hub. Older notes may not have one. */
  summary?: string;
  /** Ids of anything this note is attached to: items, tasks, phases. */
  links?: string[];
};

export type Whiteboard = ItemBase & {
  elements: Record<string, unknown>;
  /** Ids of anything this whiteboard is attached to: items, tasks, phases. */
  links?: string[];
};

export type Tracker = ItemBase & {
  prefix?: string;
  columns: { id: string; name: string; color: string; done: boolean; order: string }[];
  phases: Record<string, { name: string; order: string }>;
  tasks: Record<string, Record<string, unknown>>;
};

export const KIND_LABEL: Record<NodeKind, string> = {
  folder: "Folder",
  note: "Note",
  whiteboard: "Whiteboard",
  tracker: "Project",
};

function initialDoc(kind: ItemKind): Note | Whiteboard | Tracker {
  const base = { title: `Untitled ${KIND_LABEL[kind].toLowerCase()}`, tags: [] as string[] };
  switch (kind) {
    case "note":
      return { ...base, title: "Untitled", body: "", summary: "", links: [] } satisfies Note;
    case "whiteboard":
      return { ...base, elements: {} } satisfies Whiteboard;
    case "tracker": {
      const [a, b, c] = generateNKeysBetween(null, null, 3);
      return {
        ...base,
        columns: [
          { id: uuidv7(), name: "To do", color: "grey", done: false, order: a },
          { id: uuidv7(), name: "In progress", color: "blue", done: false, order: b },
          { id: uuidv7(), name: "Done", color: "green", done: true, order: c },
        ],
        phases: {},
        tasks: {},
      } satisfies Tracker;
    }
  }
}

export const DEFAULT_QUERY: ViewQuery = {
  types: [],
  tags: [],
  text: "",
  updatedWithinDays: null,
  sort: "updated",
  statuses: [],
  assignee: "",
  keys: [],
};

/** Where a dragged node lands relative to another node. */
export type DropRef = { before: string } | { after: string } | { end: true };

type Listener = () => void;

/** What's pinned in a workspace, for one account: syncs between its devices only. */
export type PrivateDoc = {
  pins: PrivatePin[];
};
/** A pin as stored in the private doc: a Pin without device-only scope. */
export type PrivatePin = Record<string, string>;

export class WorkspaceSession {
  /** This account's user key, set once at startup; private docs are named by it. */
  static user: string | null = null;

  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<Listener>();
  private items = new Map<string, A.Doc<ItemBase>>();
  /** False where you can only view; changes are refused before they're made. */
  private editable = true;
  /** Bumped when another device changes a doc, so open editors reload it. */
  private remoteVersions = new Map<string, number>();
  /** Docs the tree lists but this device hasn't received; they reload when they arrive. */
  private missing = new Set<string>();
  /** This account's private doc (pins), once loaded. */
  private privateDoc: A.Doc<PrivateDoc> | null = null;

  private constructor(
    readonly id: string,
    private manifest: A.Doc<Manifest>,
  ) {}

  static async create(name: string): Promise<{ session: WorkspaceSession; info: WorkspaceInfo }> {
    const id = uuidv7();
    const doc = A.from<Manifest>({ name, nodes: {}, views: {} });
    const info = await api.createWorkspace(id, A.save(doc));
    return { session: new WorkspaceSession(id, doc), info };
  }

  static async open(id: string): Promise<WorkspaceSession> {
    const bytes = await api.loadDoc(id, MANIFEST);
    return new WorkspaceSession(id, A.load<Manifest>(bytes));
  }

  // ---- subscriptions --------------------------------------------------------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  // ---- private doc (pins) -----------------------------------------------------

  /** The id of this account's private doc here, or null before the account is known. */
  get privateId(): string | null {
    return WorkspaceSession.user ? `private-${WorkspaceSession.user.slice(0, 48)}` : null;
  }

  /**
   * This account's private doc, created on first use. Viewers can write it
   * too: it never reaches anyone else's devices.
   */
  async loadPrivate(): Promise<A.Doc<PrivateDoc>> {
    if (this.privateDoc) return this.privateDoc;
    const id = this.privateId;
    if (!id) throw new Error("The account isn't known yet");
    try {
      this.privateDoc = A.load<PrivateDoc>(await api.loadDoc(this.id, id));
    } catch {
      const doc = A.from<PrivateDoc>({ pins: [] });
      await this.enqueue(() => api.createDoc(this.id, id, "private", A.save(doc), "private.create"));
      this.privateDoc = doc;
    }
    return this.privateDoc;
  }

  /** The private doc if it's loaded; otherwise null (see loadPrivate). */
  get privateSnapshot(): A.Doc<PrivateDoc> | null {
    return this.privateDoc;
  }

  changePrivate(fn: A.ChangeFn<PrivateDoc>): Promise<void> {
    const id = this.privateId;
    if (!id || !this.privateDoc) return Promise.reject(new Error("Private doc isn't loaded"));
    return this.commit<PrivateDoc>(
      id,
      () => this.privateDoc as A.Doc<PrivateDoc>,
      (d) => (this.privateDoc = d),
      "private.edit",
      fn,
      undefined,
      true,
    );
  }

  // ---- reads ----------------------------------------------------------------

  get canEdit(): boolean {
    return this.editable;
  }

  setCanEdit(v: boolean) {
    if (v === this.editable) return;
    this.editable = v;
    this.emit();
  }

  get name(): string {
    return this.manifest.name;
  }

  node(id: string): ManifestNode | undefined {
    return this.manifest.nodes[id];
  }

  hasPages(): boolean {
    return Object.keys(this.manifest.nodes).length > 0;
  }

  views(): { id: string; def: ViewDef }[] {
    return Object.entries(this.manifest.views ?? {})
      .map(([id, def]) => ({ id, def }))
      .sort((a, b) => (a.def.order < b.def.order ? -1 : a.def.order > b.def.order ? 1 : 0));
  }

  view(id: string): ViewDef | undefined {
    return this.manifest.views?.[id];
  }

  async loadItem<T extends ItemBase>(id: string): Promise<A.Doc<T>> {
    const cached = this.items.get(id);
    if (cached) return cached as A.Doc<T>;
    let doc: A.Doc<ItemBase>;
    try {
      doc = A.load<ItemBase>(await api.loadDoc(this.id, id));
    } catch (err) {
      // Listed in the tree but not here yet: another device made it and
      // hasn't synced the page itself. Reload when it arrives.
      this.missing.add(id);
      throw err;
    }
    this.missing.delete(id);
    this.items.set(id, doc);
    return doc as A.Doc<T>;
  }

  remoteVersion(id: string): number {
    return this.remoteVersions.get(id) ?? 0;
  }

  /**
   * Another device changed these docs and they're already merged on disk.
   * Save anything still waiting to be written, then reload from disk, which
   * now holds both this device's edits and the other device's.
   */
  async applyRemote(docIds: string[]) {
    flushAll();
    await this.queue;
    for (const id of docIds) {
      try {
        if (id === MANIFEST) {
          this.manifest = A.load<Manifest>(await api.loadDoc(this.id, MANIFEST));
        } else if (this.items.has(id)) {
          this.items.set(id, A.load<ItemBase>(await api.loadDoc(this.id, id)));
        } else if (this.missing.has(id)) {
          this.missing.delete(id); // the page's next load fetches it
        } else if (id === this.privateId && this.privateDoc) {
          this.privateDoc = A.load<PrivateDoc>(await api.loadDoc(this.id, id));
        } else {
          continue;
        }
        this.remoteVersions.set(id, this.remoteVersion(id) + 1);
      } catch (err) {
        console.error("Couldn't reload", id, err);
      }
    }
    this.emit();
  }

  // ---- write plumbing -------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Make one change to a doc and hand it to Rust. Rolls back to the stored doc on failure. */
  private commit<T>(
    docId: string,
    get: () => A.Doc<T>,
    set: (doc: A.Doc<T>) => void,
    action: string,
    fn: A.ChangeFn<T>,
    subject?: string,
    /** The private doc is yours whatever your role. */
    private_ = false,
  ): Promise<void> {
    if (!this.editable && !private_) return Promise.reject(new Error(READ_ONLY));
    return this.enqueue(async () => {
      const before = get();
      const after = A.change(before, fn);
      if (A.getHeads(after).join() === A.getHeads(before).join()) return; // no-op
      const change = A.getLastLocalChange(after);
      if (!change) return;
      set(after);
      try {
        await api.applyChange(this.id, docId, change, action, subject);
      } catch (err) {
        set(A.load<T>(await api.loadDoc(this.id, docId)));
        this.emit();
        throw err;
      }
      this.emit();
    });
  }

  private changeManifest(action: string, subject: string, fn: A.ChangeFn<Manifest>) {
    return this.commit<Manifest>(
      MANIFEST,
      () => this.manifest,
      (d) => (this.manifest = d),
      action,
      fn,
      subject,
    );
  }

  /** The latest loaded copy of an item, if it's loaded. */
  peekItem<T extends ItemBase>(id: string): A.Doc<T> | undefined {
    return this.items.get(id) as A.Doc<T> | undefined;
  }

  /**
   * `verb` is rename / edit / tag; the action is logged as `<kind>.<verb>`.
   * `opts.action` overrides the whole action, and `opts.subject` names what the
   * change is about (e.g. a task inside a project) for the activity log.
   */
  changeItem<T extends ItemBase>(
    id: string,
    verb: string,
    fn: A.ChangeFn<T>,
    opts: { action?: string; subject?: string } = {},
  ) {
    const kind = this.node(id)?.kind ?? "note";
    return this.commit<T>(
      id,
      () => {
        const doc = this.items.get(id);
        if (!doc) throw new Error(`Item ${id} isn't loaded`);
        return doc as A.Doc<T>;
      },
      (d) => this.items.set(id, d as A.Doc<ItemBase>),
      opts.action ?? `${kind}.${verb}`,
      fn,
      opts.subject,
    );
  }

  /** Like changeItem, but loads the item first if it isn't open. */
  async editItem<T extends ItemBase>(
    id: string,
    verb: string,
    fn: A.ChangeFn<T>,
    opts: { action?: string; subject?: string } = {},
  ) {
    await this.loadItem(id);
    return this.changeItem<T>(id, verb, fn, opts);
  }

  /** Store a file in an item's doc. Returns its id, for an `att:<id>` reference. */
  async addAttachment(itemId: string, file: { name: string; type: string; data: Uint8Array }): Promise<string> {
    const id = uuidv7();
    const kind = this.node(itemId)?.kind ?? "note";
    await this.editItem(
      itemId,
      "attach",
      (d) => {
        if (!d.attachments) d.attachments = {};
        d.attachments[id] = { name: file.name, type: file.type, data: file.data, added: Date.now() };
      },
      { action: `${kind}.attach`, subject: itemId },
    );
    return id;
  }

  private blobUrls = new Map<string, string>();

  /** A URL for showing an attachment, or null if it isn't (yet) in the doc. */
  async attachmentUrl(itemId: string, attachmentId: string): Promise<string | null> {
    const key = `${itemId}:${attachmentId}`;
    const cached = this.blobUrls.get(key);
    if (cached) return cached;
    const doc = await this.loadItem(itemId);
    const att = doc.attachments?.[attachmentId];
    if (!att || !(att.data instanceof Uint8Array) || !IMAGE_TYPES.includes(att.type)) return null;
    const url = URL.createObjectURL(new Blob([att.data.slice()], { type: att.type }));
    this.blobUrls.set(key, url);
    return url;
  }

  setSummary(noteId: string, summary: string) {
    return this.editItem<Note>(noteId, "edit", (d) => {
      if (d.summary === undefined) d.summary = "";
      A.updateText(d, ["summary"], summary);
    });
  }

  /** Attach a note to any item, task, or phase. */
  /** Attach a note or whiteboard to something: an item, a task, or a phase. */
  linkItem(itemId: string, target: string) {
    if (itemId === target) return Promise.resolve();
    return this.editItem<Note | Whiteboard>(
      itemId,
      "link",
      (d) => {
        if (!d.links) d.links = [];
        if (!d.links.includes(target)) d.links.push(target);
      },
      { action: "note.link", subject: itemId },
    );
  }

  unlinkItem(itemId: string, target: string) {
    return this.editItem<Note | Whiteboard>(
      itemId,
      "link",
      (d) => {
        if (!d.links) return;
        const i = d.links.indexOf(target);
        if (i >= 0) d.links.splice(i, 1);
      },
      { action: "note.unlink", subject: itemId },
    );
  }

  linkNote(noteId: string, target: string) {
    return this.linkItem(noteId, target);
  }

  unlinkNote(noteId: string, target: string) {
    return this.unlinkItem(noteId, target);
  }

  /** A new top-level note, already attached to `target`. */
  async createAttachedNote(target: string, title?: string): Promise<string> {
    return this.createAttached("note", target, title);
  }

  /** A new note or whiteboard, already attached to `target`. */
  async createAttached(kind: "note" | "whiteboard", target: string, title?: string): Promise<string> {
    const id = await this.createItem(kind, null);
    if (title) await this.editItem<ItemBase>(id, "rename", (d) => A.updateText(d, ["title"], title));
    await this.linkItem(id, target);
    return id;
  }

  // ---- tree operations ------------------------------------------------------

  private siblings(parent: string | null, exclude?: string) {
    return Object.entries(this.manifest.nodes)
      .filter(([id, n]) => n.parent === parent && id !== exclude)
      .map(([id, n]) => ({ id, order: n.order }))
      .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1));
  }

  private orderAt(parent: string | null, ref: DropRef, exclude?: string): string {
    const sibs = this.siblings(parent, exclude);
    let lo: string | null = null;
    let hi: string | null = null;
    if ("before" in ref) {
      const i = sibs.findIndex((s) => s.id === ref.before);
      lo = sibs[i - 1]?.order ?? null;
      hi = sibs[i]?.order ?? null;
    } else if ("after" in ref) {
      const i = sibs.findIndex((s) => s.id === ref.after);
      lo = sibs[i]?.order ?? null;
      hi = sibs[i + 1]?.order ?? null;
    } else {
      lo = sibs[sibs.length - 1]?.order ?? null;
    }
    // Two devices can produce equal keys offline; fall back to "after lo".
    if (lo !== null && hi !== null && lo >= hi) hi = null;
    return generateKeyBetween(lo, hi);
  }

  /** True if `id` is `ancestor` or sits somewhere under it. */
  isWithin(id: string | null, ancestor: string): boolean {
    // The seen set stops at a parent loop, which offline moves can merge into.
    const seen = new Set<string>();
    for (let cur = id; cur && !seen.has(cur); cur = this.manifest.nodes[cur]?.parent ?? null) {
      if (cur === ancestor) return true;
      seen.add(cur);
    }
    return false;
  }

  async createFolder(parent: string | null, title = "New folder"): Promise<string> {
    const id = uuidv7();
    await this.changeManifest("tree.add", id, (d) => {
      d.nodes[id] = { kind: "folder", title, parent, order: this.orderAt(parent, { end: true }) };
    });
    return id;
  }

  async createItem(kind: ItemKind, parent: string | null): Promise<string> {
    if (!this.editable) throw new Error(READ_ONLY);
    const id = uuidv7();
    const doc = A.from<ItemBase>(initialDoc(kind) as ItemBase);
    await this.enqueue(() => api.createDoc(this.id, id, kind, A.save(doc), `${kind}.create`));
    this.items.set(id, doc);
    await this.changeManifest("tree.add", id, (d) => {
      d.nodes[id] = { kind, parent, order: this.orderAt(parent, { end: true }) };
    });
    return id;
  }

  /** Move a node under `parent` at the given position. Refuses to put a folder inside itself. */
  moveNode(id: string, parent: string | null, ref: DropRef) {
    if (parent && this.isWithin(parent, id)) return Promise.resolve();
    const order = this.orderAt(parent, ref, id);
    return this.changeManifest("tree.move", id, (d) => {
      const n = d.nodes[id];
      if (!n) return;
      if (n.parent !== parent) n.parent = parent;
      n.order = order;
    });
  }

  renameFolder(id: string, title: string) {
    return this.changeManifest("tree.rename", id, (d) => {
      if (d.nodes[id]) A.updateText(d, ["nodes", id, "title"], title);
    });
  }

  renameWorkspace(name: string) {
    return this.changeManifest("workspace.rename", this.id, (d) => A.updateText(d, ["name"], name));
  }

  look(): WorkspaceLook {
    const l = this.manifest.look;
    return { color: l?.color ? String(l.color) : undefined, icon: l?.icon ? String(l.icon) : undefined };
  }

  /** Color and icon for the switcher. Empty strings clear a value. */
  setLook(look: WorkspaceLook) {
    return this.changeManifest("workspace.look", this.id, (d) => {
      if (!d.look) d.look = {};
      if (look.color !== undefined) {
        if (look.color) d.look.color = new A.ImmutableString(look.color) as unknown as string;
        else delete d.look.color;
      }
      if (look.icon !== undefined) {
        if (look.icon) d.look.icon = new A.ImmutableString(look.icon) as unknown as string;
        else delete d.look.icon;
      }
    });
  }

  /**
   * Removes a node and everything under it from the tree. Item docs stay on disk as
   * history. Returns the removed records so `restoreNodes` can undo it.
   */
  async deleteNode(id: string, action = "tree.delete"): Promise<Record<string, ManifestNode>> {
    const doomed = Object.keys(this.manifest.nodes).filter((nid) => this.isWithin(nid, id));
    const removed: Record<string, ManifestNode> = {};
    for (const nid of doomed) {
      const n = this.manifest.nodes[nid];
      removed[nid] = { kind: n.kind, title: n.title ? String(n.title) : undefined, parent: n.parent, order: n.order };
    }
    await this.changeManifest(action, id, (d) => {
      doomed.forEach((nid) => delete d.nodes[nid]);
    });
    return removed;
  }

  /** Puts nodes removed by `deleteNode` back where they were. */
  restoreNodes(nodes: Record<string, ManifestNode>) {
    const ids = Object.keys(nodes);
    if (!ids.length) return Promise.resolve();
    // The root of the restored subtree is the one whose parent isn't being restored.
    const root = ids.find((id) => !nodes[id].parent || !nodes[nodes[id].parent!]) ?? ids[0];
    return this.changeManifest("tree.restore", root, (d) => {
      for (const id of ids) {
        if (d.nodes[id]) continue;
        const n = nodes[id];
        // A parent deleted since (or on another device) drops the node to the top level.
        const parent = n.parent && (d.nodes[n.parent] || nodes[n.parent]) ? n.parent : null;
        d.nodes[id] = n.title !== undefined ? { kind: n.kind, title: n.title, parent, order: n.order } : { kind: n.kind, parent, order: n.order };
      }
    });
  }

  // ---- moving between workspaces ---------------------------------------------

  /**
   * A copy of `id` and everything under it, ready to put in another workspace.
   * With no `id`, the whole tree. Docs are copied as plain values: the other
   * workspace gets them as fresh docs with one change, which its members can
   * verify from the move event, rather than a history nobody there vouched for.
   */
  async exportSubtree(id: string | null): Promise<Subtree> {
    const ids = Object.keys(this.manifest.nodes).filter((nid) => (id ? this.isWithin(nid, id) : true));
    const nodes: Subtree["nodes"] = {};
    const docs: Subtree["docs"] = {};
    // Walk parents before children so import can place each under its parent.
    const depth = (nid: string, seen = new Set<string>()): number => {
      const p = this.manifest.nodes[nid]?.parent;
      return p && ids.includes(p) && !seen.has(nid) ? 1 + depth(p, seen.add(nid)) : 0;
    };
    for (const nid of ids.sort((a, b) => depth(a) - depth(b))) {
      const n = this.manifest.nodes[nid];
      const parent = n.parent && ids.includes(n.parent) ? n.parent : null;
      nodes[nid] = { kind: n.kind, title: n.title ? String(n.title) : undefined, parent, order: n.order };
      if (n.kind === "folder") continue;
      let doc: ItemBase;
      try {
        doc = await this.loadItem(nid);
      } catch {
        continue; // not here yet; the tree entry moves on its own
      }
      docs[nid] = plainCopy(doc) as ItemBase;
    }
    return { nodes, docs, views: id ? [] : this.views().map((v) => plainCopy(v.def) as ViewDef) };
  }

  /**
   * Puts a subtree from another workspace under `parent` (null: top level).
   * Ids are kept where they're free, so links between the moved pages keep
   * working; a clash gets a fresh id and links follow it. Links to anything
   * that stayed behind are dropped. Returns the moved ids, old to new.
   */
  async importSubtree(parent: string | null, sub: Subtree, action = "tree.move_in"): Promise<Record<string, string>> {
    if (!this.editable) throw new Error(READ_ONLY);
    const ids: Record<string, string> = {};
    for (const old of Object.keys(sub.nodes)) ids[old] = this.manifest.nodes[old] ? uuidv7() : old;
    // Tasks and phases inside moved projects keep their ids, so links to them survive.
    const inside = new Set(Object.keys(sub.nodes));
    for (const d of Object.values(sub.docs)) {
      const t = d as Partial<Tracker>;
      Object.keys(t.tasks ?? {}).forEach((k) => inside.add(k));
      Object.keys(t.phases ?? {}).forEach((k) => inside.add(k));
    }
    const map = (x: string) => ids[x] ?? x;
    for (const [old, n] of Object.entries(sub.nodes)) {
      if (n.kind === "folder" || !sub.docs[old]) continue;
      const copy = sub.docs[old] as Note | Whiteboard;
      if (copy.links) copy.links = copy.links.filter((l) => inside.has(l)).map(map);
      let doc = A.from<ItemBase>(copy);
      let id = ids[old];
      try {
        await this.enqueue(() => api.createDoc(this.id, id, n.kind as ItemKind, A.save(doc), action));
      } catch (e) {
        // The doc exists here without a tree entry (deleted earlier): take a fresh id.
        if (id !== old || !/already exists/.test(String(e))) throw e;
        id = ids[old] = uuidv7();
        doc = A.from<ItemBase>(copy);
        await this.enqueue(() => api.createDoc(this.id, id, n.kind as ItemKind, A.save(doc), action));
      }
      this.items.set(id, doc);
    }
    const top = Object.keys(sub.nodes).filter((old) => !sub.nodes[old].parent);
    const first = top[0] ? ids[top[0]] : parent ?? this.id;
    await this.changeManifest(action, first, (d) => {
      const sibs = this.siblings(parent);
      let last = sibs.length ? sibs[sibs.length - 1].order : null;
      for (const [old, n] of Object.entries(sub.nodes)) {
        if (n.kind !== "folder" && !sub.docs[old]) continue; // never arrived; nothing to move
        const p = n.parent ? ids[n.parent] : parent;
        const order = n.parent ? n.order : (last = generateKeyBetween(last, null));
        d.nodes[ids[old]] = n.title !== undefined ? { kind: n.kind, title: n.title, parent: p, order } : { kind: n.kind, parent: p, order };
      }
      for (const v of sub.views) {
        if (!d.views) d.views = {};
        if (Object.values(d.views).some((x) => x.name === v.name)) continue;
        const def = plainCopy(v) as ViewDef;
        const orders = Object.values(d.views).map((x) => x.order).sort();
        def.order = generateKeyBetween(orders.length ? orders[orders.length - 1] : null, null);
        d.views[uuidv7()] = def;
      }
    });
    return ids;
  }

  // ---- views ----------------------------------------------------------------

  async createView(name = "Untitled view"): Promise<string> {
    const id = uuidv7();
    const all = this.views();
    const last = all[all.length - 1]?.def.order ?? null;
    await this.changeManifest("view.create", id, (d) => {
      if (!d.views) d.views = {};
      d.views[id] = {
        name,
        icon: new A.ImmutableString("view") as unknown as string,
        order: generateKeyBetween(last, null),
        query: { ...DEFAULT_QUERY },
      };
    });
    return id;
  }

  renameView(id: string, name: string) {
    return this.changeManifest("view.rename", id, (d) => {
      if (d.views?.[id]) A.updateText(d, ["views", id, "name"], name);
    });
  }

  setViewIcon(id: string, icon: string) {
    return this.changeManifest("view.edit", id, (d) => {
      const v = d.views?.[id];
      if (v) v.icon = new A.ImmutableString(icon) as unknown as string;
    });
  }

  setViewQuery(id: string, query: ViewQuery) {
    return this.changeManifest("view.edit", id, (d) => {
      const v = d.views?.[id];
      if (v) v.query = { ...query, types: [...query.types], tags: [...query.tags], statuses: [...query.statuses], keys: [...(query.keys ?? [])] };
    });
  }

  deleteView(id: string) {
    return this.changeManifest("view.delete", id, (d) => {
      if (d.views) delete d.views[id];
    });
  }
}
