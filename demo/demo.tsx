// A fake backend in the browser, so the real frontend runs without Tauri.
// For the demo recording only.
import "../src/assetPath";
import { A, initAutomerge } from "../src/lib/automerge";

const ws = { id: "ws", name: "Sam's notes", role: "owner", shared: false, ownerName: "" };
const docs = new Map<string, any>(); // docId -> Automerge doc
const kinds = new Map<string, string>();
const ids = { research: "f-research", relay: "n-relay", sync: "n-sync", board: "w-arch", personal: "f-personal", book: "t-book", reading: "n-reading" };

function seed() {
  const manifest = A.from<any>({
    name: "Sam's notes",
    look: { color: "teal", icon: "book" },
    nodes: {
      [ids.research]: { kind: "folder", title: "Research", parent: null, order: "a0" },
      [ids.relay]: { kind: "note", parent: ids.research, order: "a0" },
      [ids.sync]: { kind: "note", parent: ids.research, order: "a1" },
      [ids.board]: { kind: "whiteboard", parent: ids.research, order: "a2" },
      [ids.personal]: { kind: "folder", title: "Personal", parent: null, order: "a1" },
      [ids.book]: { kind: "tracker", parent: ids.personal, order: "a0" },
      [ids.reading]: { kind: "note", parent: ids.personal, order: "a1" },
    },
    views: { v1: { name: "Due this week", icon: "clock", order: "a0", query: { types: ["task"], tags: [], text: "", updatedWithinDays: 7, sort: "updated", statuses: ["todo", "doing"], assignee: "", keys: [] } } },
  });
  docs.set("manifest", manifest);
  const note = (title: string, tags: string[], body: string) => A.from<any>({ title, tags, body, summary: "", links: [] });
  docs.set(ids.relay, note("Relay setup", ["sync", "infra"], "The app uses iroh's public NA East relay by default. For the thesis test bench I want a relay on the Pi so the two laptops keep syncing when the campus network blocks UDP.\n\n## What needs to happen\n\n- [x] Install iroh-relay on the Pi and open 443\n- [ ] Point `Settings → Devices → Live sync` at the new URL on both laptops\n- [ ] Confirm the address record updates in `identity.json` after the next sync\n\n:::panel {type=\"warning\"}\nChanging the relay changes this device's address. Other devices learn it at the next sync, so switch one device at a time.\n:::\n\n## Open question\n\nDoes mDNS alone cover the lab network? If both machines are on the same subnet the relay is only a fallback.\n"));
  docs.set(ids.sync, note("Sync protocol", ["sync"], "Each device runs an iroh endpoint whose identity is its device key.\n\nDevices sync whenever two of them are online: every 30 seconds, and about 2 seconds after a local change.\n"));
  docs.set(ids.reading, note("Reading list", [], "- Designing Data-Intensive Applications\n- The Pragmatic Programmer\n- Crafting Interpreters\n"));
  docs.set(ids.board, A.from<any>({ title: "Architecture board", tags: [], elements: {} }));
  const task = (n: number, prefix: string, title: string, column: string, extra: any = {}) => ({ prefix, number: n, title, description: "", column, order: `a${String(n).padStart(2, "0")}`, assignee: "", priority: "none", due: "", phase: "", parent: "", tags: [], links: [], created: Date.now(), ...extra });
  docs.set(ids.book, A.from<any>({
    title: "idear 1.1", tags: ["app", "release"], prefix: "IDR", repos: [
      { id: "r0", kind: "remote", url: "https://github.com/sam/idear", name: "sam/idear" },
      { id: "r1", kind: "local", name: "idear-relay", origin: "git@github.com:sam/idear-relay.git", addedOn: { device: "Desktop", path: "/Users/sam/code/idear-relay" } },
    ],
    columns: [{ id: "c1", name: "To do", order: "a0", color: "grey" }, { id: "c2", name: "In progress", order: "a1", color: "blue" }, { id: "c3", name: "Done", order: "a2", color: "green", done: true }],
    phases: { p1: { name: "Sync hardening", order: "a0", start: "2026-10-01", end: "2026-10-20" }, p2: { name: "Polish", order: "a1", start: "2026-10-15", end: "2026-10-31" }, p3: { name: "Release", order: "a2" } },
    tasks: {
      a: task(31, "IDR", "Renumber duplicate task keys on sync", "c1", { tags: ["sync"], priority: "high", assignee: "Sam", phase: "p1", start: "2026-10-13", due: "2026-10-20" }),
      b: task(29, "IDR", "Private views", "c1", { tags: ["views"], priority: "medium", phase: "p2", start: "2026-10-21", due: "2026-10-28" }),
      c: task(8, "SYNC", "Identity rotation after device removal", "c1", { tags: ["identity", "sync"], priority: "high", assignee: "Neji Mensi", phase: "p1", start: "2026-10-16", due: "2026-10-30" }),
      d: task(11, "SYNC", "Own relay on the Pi", "c2", { tags: ["infra", "sync"], priority: "high", start: "2026-10-06", due: "2026-10-14", assignee: "Sam", phase: "p1", branches: [{ repo: "r0", branch: "relay-on-pi" }, { repo: "r1", branch: "main" }] }),
      e: task(33, "IDR", "Encryption at rest: SQLCipher + sealed docs", "c2", { tags: ["security"], priority: "medium", assignee: "Sam", phase: "p2", start: "2026-10-08", due: "2026-10-24", branches: [{ repo: "r0", branch: "sqlcipher" }], checklist: [
        { id: "c1", text: "Pick a key derivation", done: true },
        { id: "c2", text: "Seal docs at rest", done: true },
        { id: "c3", text: "Migrate existing workspaces", done: false },
        { id: "c4", text: "Benchmark open time", done: false },
      ] }),
      f: task(24, "IDR", "Pinned section in the sidebar", "c3", { tags: ["sidebar"], phase: "p2", start: "2026-09-28", due: "2026-10-03" }),
      g: task(22, "IDR", "Workspace trash, 30-day restore", "c3", { tags: ["workspaces"], phase: "p2", start: "2026-09-30", due: "2026-10-07", assignee: "Sam" }),
      h: task(40, "IDR", "Release notes and tag 1.1", "c1", { tags: ["release"], phase: "p3", due: "2026-11-06", assignee: "Sam" }),
      i: task(41, "IDR", "Write the demo script", "c1", { tags: ["release"], phase: "p3" }),
      j: task(42, "IDR", "Review relay docs", "c2", { tags: ["infra"], parent: "d", start: "2026-10-10", due: "2026-10-12" }),
      k: task(43, "IDR", "Open port 443 on the Pi", "c3", { tags: ["infra"], parent: "d", start: "2026-10-06", due: "2026-10-08" }),
    },
  }));
  for (const [k, v] of Object.entries(ids)) kinds.set(v, k.startsWith("f-") ? "folder" : v.startsWith("n-") ? "note" : v.startsWith("w-") ? "whiteboard" : "tracker");
}

function tree() {
  const m: any = docs.get("manifest");
  return Object.entries(m.nodes).map(([id, n]: [string, any]) => ({ id, kind: n.kind, parent: n.parent ?? null, sortKey: n.order, title: n.kind === "folder" ? n.title : String(docs.get(id)?.title ?? "") }));
}

function rows(q: any) {
  const text = String(q.text ?? "").toLowerCase();
  const out: any[] = [];
  for (const n of tree()) {
    if (n.kind === "folder") continue;
    const d: any = docs.get(n.id);
    if (q.types?.length && !q.types.includes(n.kind)) continue;
    const hay = `${d.title} ${d.body ?? ""}`.toLowerCase();
    if (text && !hay.includes(text)) continue;
    out.push({ id: n.id, kind: n.kind, title: String(d.title), parentTitle: null, tags: [...d.tags], updatedAt: Date.now(), tracker: null, trackerTitle: null, key: null, status: null });
  }
  if (!q.types?.length || q.types.includes("task")) {
    for (const n of tree().filter((n) => n.kind === "tracker")) {
      const d: any = docs.get(n.id);
      for (const [tid, t] of Object.entries<any>(d.tasks ?? {})) {
        if (text && !String(t.title).toLowerCase().includes(text)) continue;
        const col = d.columns.find((c: any) => c.id === t.column);
        out.push({ id: tid, kind: "task", title: String(t.title), parentTitle: null, tags: [...t.tags], updatedAt: Date.now(), tracker: n.id, trackerTitle: String(d.title), key: `${t.prefix}-${t.number}`, status: col?.name ?? null });
      }
    }
  }
  return out;
}

const me = { userId: "u-sam", name: "Sam", thisDevice: "dev-1", devices: [{ id: "dev-1", name: "MacBook", linked: Date.now() - 86400000 * 30, revoked: null, thisDevice: true }] };

async function invoke(cmd: string, args: any = {}): Promise<any> {
  switch (cmd) {
    case "account_info": return me;
    case "list_workspaces": return [ws];
    case "load_doc": { const d = docs.get(args.docId); return A.save(d).buffer; }
    case "create_doc": { docs.set(args.docId, A.load(new Uint8Array(args.bytes))); kinds.set(args.docId, args.kind); return null; }
    case "apply_change": { const [next] = A.applyChanges(docs.get(args.docId), [new Uint8Array(args.change)]); docs.set(args.docId, next); return null; }
    case "get_tree": return tree();
    case "run_view": return rows(args.query);
    case "links_of": return { outgoing: args.id === ids.relay ? [{ id: ids.book, kind: "tracker", title: "idear 1.1", tracker: null, trackerTitle: null, key: null }] : [], incoming: [] };
    case "notes_hub": return [];
    case "list_events": return [];
    case "list_trash": return [];
    case "list_joins": return [];
    case "git_info": return { isRepo: true, remote: "git@github.com:sam/idear.git", branch: "main" };
    case "path_exists": return String(args.path).includes("sam");
    case "git_branches": return { branches: ["main", "relay-on-pi", "sqlcipher", "feature/pi"], source: args.path ? "local" : "remote", error: null };
    case "share_info": return { role: "owner", isOwner: true, ownerName: "Sam", people: [{ user: "u-sam", name: "Sam", role: "owner", since: 1, isYou: true, devices: ["dev-1"] }], invites: [] };
    case "sync_status": return { settings: { enabled: true, relay: "https://use1-1.relay.n0.iroh.link./" }, running: true, relayConnected: true, peers: { "dev-2": { user: "u-sam", lastSync: Date.now() - 120000, lastAttempt: null, lastError: null } }, problems: [] };
    case "claude_status": return { command: "idear mcp", seen: false, name: "Claude", desktop: { found: false, connected: false, stale: false, path: "" }, codeCommand: "", workspaces: [] };
    default:
      if (cmd.startsWith("plugin:")) return 1;
      return null;
  }
}

(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
(window as any).__TAURI_INTERNALS__ = { invoke, transformCallback: () => 0, metadata: {} };

// A cursor the recording can see, and a caption strip the script drives.
const style = document.createElement("style");
style.textContent = `
#demo-cursor{position:fixed;z-index:9999;width:18px;height:18px;margin:-3px 0 0 -3px;pointer-events:none;transition:left .35s cubic-bezier(.2,.8,.2,1),top .35s cubic-bezier(.2,.8,.2,1)}
#demo-cursor svg{filter:drop-shadow(0 1px 2px rgb(0 0 0/.5))}
#demo-cursor[data-down]{transform:scale(.85)}
#demo-caption{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9998;padding:10px 18px;border-radius:999px;background:rgb(15 20 35/.88);color:#fff;font:500 15px/1.3 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.01em;opacity:0;transition:opacity .25s;pointer-events:none;max-width:70vw;text-align:center}
#demo-caption[data-on]{opacity:1}
#demo-title{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:#15181e;color:#e3e6eb;font-family:"IBM Plex Sans",system-ui,sans-serif;transition:opacity .5s}
#demo-title h1{font:600 56px/1.1 "Source Serif 4",Georgia,serif;margin:0 0 12px;letter-spacing:-.01em}
#demo-title p{margin:0;font-size:18px;color:#969fae}
#demo-title[data-off]{opacity:0;pointer-events:none}
`;
document.head.appendChild(style);
const cursor = document.createElement("div");
cursor.id = "demo-cursor";
cursor.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 2l16 9-7 1.5L9 20z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
document.body.appendChild(cursor);
const caption = document.createElement("div");
caption.id = "demo-caption";
document.body.appendChild(caption);
const title = document.createElement("div");
title.id = "demo-title";
title.innerHTML = `<div style="text-align:center"><h1>idear</h1><p>Notes, whiteboards, and projects. Local-first, peer to peer, end-to-end signed.</p></div>`;
document.body.appendChild(title);
(window as any).demo = {
  cursor(x: number, y: number) { cursor.style.left = `${x}px`; cursor.style.top = `${y}px`; },
  down(v: boolean) { if (v) cursor.dataset.down = "1"; else delete cursor.dataset.down; },
  say(t: string) { if (!t) { delete caption.dataset.on; return; } caption.textContent = t; caption.dataset.on = "1"; },
  start() { title.dataset.off = "1"; },
};

await initAutomerge();
seed();
localStorage.clear();
localStorage.setItem("prefs", JSON.stringify({ theme: "light", accent: "indigo" }));
localStorage.setItem("pins:ws", JSON.stringify([{ kind: "node", id: ids.relay }, { kind: "task", id: "d", project: ids.book }]));

const React = (await import("react")).default;
const ReactDOM = (await import("react-dom/client")).default;
await import("@fontsource/ibm-plex-sans/400.css");
await import("@fontsource/ibm-plex-sans/500.css");
await import("@fontsource/ibm-plex-sans/600.css");
await import("@fontsource/source-serif-4/400.css");
await import("@fontsource/source-serif-4/600.css");
await import("../src/styles.css");
const { default: App } = await import("../src/App");
const { initPrefs } = await import("../src/lib/prefs");
initPrefs();
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
