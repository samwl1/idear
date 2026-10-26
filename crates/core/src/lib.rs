pub mod bundle;
pub mod docs;
pub mod error;
pub mod eventlog;
pub mod identity;
pub mod members;
pub mod index;
pub mod workspace;

use std::path::Path;

use serde::Serialize;

pub use error::{CoreError, Result};
pub use workspace::{Workspace, WorkspaceImport, WorkspaceSummary};

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
}

/// Every workspace under `root`, sorted by name.
pub fn list_workspaces(root: &Path) -> Result<Vec<WorkspaceInfo>> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let Some(id) = entry.file_name().to_str().map(str::to_string) else { continue };
        if !entry.path().join("events.db").exists() || validate_id(&id).is_err() {
            continue;
        }
        // One damaged folder must not hide every other workspace, but say
        // which one was skipped and why, or it just looks lost.
        let ws = match Workspace::open(root, &id) {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("Couldn't open workspace {id}: {e}");
                continue;
            }
        };
        let name = match ws.name() {
            Ok(n) => n,
            Err(e) => {
                eprintln!("Couldn't read the name of workspace {id}: {e}");
                continue;
            }
        };
        out.push(WorkspaceInfo { name, id });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

pub(crate) fn validate_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(CoreError::Invalid(format!("id {id:?}")))
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::transaction::Transactable;
    use automerge::{AutoCommit, ObjType, ReadDoc, ROOT};
    use ed25519_dalek::SigningKey;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    fn manifest(name: &str) -> AutoCommit {
        let mut d = AutoCommit::new();
        let t = d.put_object(ROOT, "name", ObjType::Text).unwrap();
        d.splice_text(&t, 0, 0, name).unwrap();
        d.put_object(ROOT, "nodes", ObjType::Map).unwrap();
        d
    }

    #[test]
    fn end_to_end() {
        let tmp = tempfile::tempdir().unwrap();
        let k = key(7);

        let mut m = manifest("Research");
        let mut ws = Workspace::create(tmp.path(), "ws-1", &m.save(), &k).unwrap();
        assert_eq!(ws.name().unwrap(), "Research");

        // Create a note doc (as the frontend would).
        let mut note = AutoCommit::new();
        let title = note.put_object(ROOT, "title", ObjType::Text).unwrap();
        note.splice_text(&title, 0, 0, "Threat model").unwrap();
        let body = note.put_object(ROOT, "body", ObjType::Text).unwrap();
        note.splice_text(&body, 0, 0, "# Assets\nkeys").unwrap();
        let tags = note.put_object(ROOT, "tags", ObjType::List).unwrap();
        note.insert(&tags, 0, "security").unwrap();
        ws.create_doc(&k, "note-1", "note", &note.save(), "note.create").unwrap();

        // Add it to the tree via an incremental manifest change.
        let nodes = match m.get(ROOT, "nodes").unwrap() {
            Some((_, id)) => id,
            None => panic!(),
        };
        let n = m.put_object(&nodes, "note-1", ObjType::Map).unwrap();
        m.put(&n, "kind", "note").unwrap();
        m.put(&n, "parent", automerge::ScalarValue::Null).unwrap();
        m.put(&n, "order", "a0").unwrap();
        m.commit();
        let change = m.get_last_local_change().unwrap().raw_bytes().to_vec();
        ws.apply_change(&k, "manifest", change, "tree.add", Some("note-1")).unwrap();

        let tree = ws.tree().unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].title, "Threat model");
        assert_eq!(tree[0].kind, "note");

        // Edit the note body.
        note.splice_text(&body, 0, 0, "Draft\n").unwrap();
        note.commit();
        let change = note.get_last_local_change().unwrap().raw_bytes().to_vec();
        ws.apply_change(&k, "note-1", change, "note.edit", None).unwrap();

        // A change built on history the store lacks is rejected.
        let mut other = AutoCommit::new();
        other.put(ROOT, "x", 1).unwrap();
        other.commit();
        other.put(ROOT, "x", 2).unwrap();
        other.commit();
        let orphan = other.get_last_local_change().unwrap().raw_bytes().to_vec();
        assert!(ws.apply_change(&k, "note-1", orphan, "note.edit", None).is_err());

        // Second device writes too.
        ws.apply_change(&key(9), "manifest", {
            let nn = m.put_object(&nodes, "folder-1", ObjType::Map).unwrap();
            m.put(&nn, "kind", "folder").unwrap();
            m.put(&nn, "title", "Archive").unwrap();
            m.put(&nn, "order", "a1").unwrap();
            m.commit();
            m.get_last_local_change().unwrap().raw_bytes().to_vec()
        }, "tree.add", Some("folder-1")).unwrap();

        let report = ws.verify_log().unwrap();
        assert!(report.ok, "{:?}", report.problems);
        assert_eq!(report.events, 5);
        assert_eq!(report.devices, 2);

        // Reopen from disk.
        drop(ws);
        let ws = Workspace::open(tmp.path(), "ws-1").unwrap();
        assert_eq!(ws.tree().unwrap().len(), 2);
        assert_eq!(list_workspaces(tmp.path()).unwrap()[0].name, "Research");

        // Tamper with an event behind the app's back: verification catches it.
        let db = rusqlite::Connection::open(ws.dir().join("events.db")).unwrap();
        db.execute_batch(
            "DROP TRIGGER events_no_update;
             UPDATE events SET action = 'note.delete' WHERE seq = 2;",
        )
        .unwrap();
        let report = ws.verify_log().unwrap();
        assert!(!report.ok);
        assert!(report.problems.iter().any(|p| p.contains("hash mismatch")));
    }

    #[test]
    fn view_queries() {
        use crate::index::ViewQuery;
        let tmp = tempfile::tempdir().unwrap();
        let k = key(5);
        let mut ws = Workspace::create(tmp.path(), "ws", &manifest("Q").save(), &k).unwrap();

        let mk = |title: &str, body: &str, tag: Option<&str>| {
            let mut d = AutoCommit::new();
            let t = d.put_object(ROOT, "title", ObjType::Text).unwrap();
            d.splice_text(&t, 0, 0, title).unwrap();
            let b = d.put_object(ROOT, "body", ObjType::Text).unwrap();
            d.splice_text(&b, 0, 0, body).unwrap();
            let tags = d.put_object(ROOT, "tags", ObjType::List).unwrap();
            if let Some(tag) = tag {
                d.insert(&tags, 0, tag).unwrap();
            }
            d.save()
        };
        ws.create_doc(&k, "a", "note", &mk("Threat model", "signing keys", Some("security")), "note.create").unwrap();
        ws.create_doc(&k, "b", "note", &mk("Groceries", "eggs", None), "note.create").unwrap();
        ws.create_doc(&k, "c", "whiteboard", &mk("Arch diagram", "", Some("security")), "whiteboard.create").unwrap();

        let q = |q: ViewQuery| ws.query(&q).unwrap().into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(q(ViewQuery::default()).len(), 3);
        let mut tagged = q(ViewQuery { tags: vec!["security".into()], ..Default::default() });
        tagged.sort();
        assert_eq!(tagged, vec!["a", "c"]);
        assert_eq!(q(ViewQuery { text: "sign".into(), ..Default::default() }), vec!["a"]);
        assert_eq!(q(ViewQuery { types: vec!["whiteboard".into()], ..Default::default() }), vec!["c"]);
        // Hostile FTS input is treated as plain words, not syntax.
        assert!(q(ViewQuery { text: "foo\" OR NEAR(* \"".into(), ..Default::default() }).is_empty());
        // Tag globbing: `*` matches the rest; GLOB metacharacters are literal.
        let mut globbed = q(ViewQuery { tags: vec!["sec*".into()], ..Default::default() });
        globbed.sort();
        assert_eq!(globbed, vec!["a", "c"]);
        assert!(q(ViewQuery { tags: vec!["sec".into()], ..Default::default() }).is_empty());
        assert_eq!(q(ViewQuery { tags: vec!["*rity".into()], ..Default::default() }).len(), 2);
        assert!(q(ViewQuery { tags: vec!["s?curity".into()], ..Default::default() }).is_empty());
        let rows = ws.query(&ViewQuery { sort: "title".into(), ..Default::default() }).unwrap();
        assert_eq!(rows[0].title, "Arch diagram");
        assert_eq!(rows[0].tags, vec!["security"]);
    }

    #[test]
    fn whiteboard_text_and_links_indexed() {
        use crate::index::ViewQuery;
        let tmp = tempfile::tempdir().unwrap();
        let k = key(6);
        let mut ws = Workspace::create(tmp.path(), "ws", &manifest("W").save(), &k).unwrap();
        let mut d = AutoCommit::new();
        let t = d.put_object(ROOT, "title", ObjType::Text).unwrap();
        d.splice_text(&t, 0, 0, "Board").unwrap();
        d.put_object(ROOT, "tags", ObjType::List).unwrap();
        let els = d.put_object(ROOT, "elements", ObjType::Map).unwrap();
        let box1 = d.put_object(&els, "e1", ObjType::Map).unwrap();
        let tx = d.put_object(&box1, "text", ObjType::Text).unwrap();
        d.splice_text(&tx, 0, 0, "Trust boundary").unwrap();
        let card = d.put_object(&els, "e2", ObjType::Map).unwrap();
        d.put(&card, "ref", "note-9").unwrap();
        ws.create_doc(&k, "wb", "whiteboard", &d.save(), "whiteboard.create").unwrap();
        let hits = ws.query(&ViewQuery { text: "boundary".into(), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);
        let db = rusqlite::Connection::open(ws.dir().join("index.sqlite")).unwrap();
        let target: String = db.query_row("SELECT target FROM links WHERE source = 'wb'", [], |r| r.get(0)).unwrap();
        assert_eq!(target, "note-9");
    }

    #[test]
    fn tracker_tasks_indexed_and_queryable() {
        use crate::index::ViewQuery;
        let tmp = tempfile::tempdir().unwrap();
        let k = key(8);
        let mut ws = Workspace::create(tmp.path(), "ws", &manifest("T").save(), &k).unwrap();

        let mut d = AutoCommit::new();
        let t = d.put_object(ROOT, "title", ObjType::Text).unwrap();
        d.splice_text(&t, 0, 0, "App launch").unwrap();
        d.put_object(ROOT, "tags", ObjType::List).unwrap();
        d.put(ROOT, "prefix", "APP").unwrap();
        let cols = d.put_object(ROOT, "columns", ObjType::List).unwrap();
        // Inserted out of order: position comes from `order`, not list index.
        for (i, (id, name, order, done)) in
            [("c2", "Done", "a2", true), ("c1", "To do", "a0", false), ("c3", "Doing", "a1", false), ("c4", "Shipped", "a3", true)]
                .iter()
                .enumerate()
        {
            let c = d.insert_object(&cols, i, ObjType::Map).unwrap();
            d.put(&c, "id", *id).unwrap();
            d.put(&c, "name", *name).unwrap();
            d.put(&c, "order", *order).unwrap();
            d.put(&c, "done", *done).unwrap();
        }
        let phases = d.put_object(ROOT, "phases", ObjType::Map).unwrap();
        let p1 = d.put_object(&phases, "p1", ObjType::Map).unwrap();
        d.put(&p1, "name", "Alpha").unwrap();
        let tasks = d.put_object(ROOT, "tasks", ObjType::Map).unwrap();
        for (id, n, title, col, who) in [("t1", 1, "Write spec", "c1", "sam"), ("t2", 2, "Ship it", "c2", "alex"), ("t3", 1, "Fix crash", "c4", "")] {
            let task = d.put_object(&tasks, id, ObjType::Map).unwrap();
            if id == "t3" {
                d.put(&task, "prefix", "BUG").unwrap();
            }
            d.put(&task, "number", n as i64).unwrap();
            d.put(&task, "title", title).unwrap();
            d.put(&task, "column", col).unwrap();
            d.put(&task, "assignee", who).unwrap();
            d.put(&task, "phase", "p1").unwrap();
            d.put_object(&task, "tags", ObjType::List).unwrap();
        }
        ws.create_doc(&k, "tr", "tracker", &d.save(), "tracker.create").unwrap();

        let q = |q: ViewQuery| ws.query(&q).unwrap();
        let rows = q(ViewQuery { types: vec!["task".into()], sort: "title".into(), ..Default::default() });
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].key.as_deref(), Some("BUG-1"));
        assert_eq!(rows[1].key.as_deref(), Some("APP-2"));
        assert_eq!(rows[1].status.as_deref(), Some("Done"));
        assert_eq!(rows[1].tracker_title.as_deref(), Some("App launch"));
        // Two done columns: both count as done.
        let done = q(ViewQuery { types: vec!["task".into()], statuses: vec!["done".into()], ..Default::default() });
        assert_eq!(done.len(), 2);
        let open = q(ViewQuery { types: vec!["task".into()], statuses: vec!["todo".into()], ..Default::default() });
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, "t1");
        let mine = q(ViewQuery { types: vec!["task".into()], assignee: "SA*".into(), ..Default::default() });
        assert_eq!(mine.len(), 1);
        // Tasks don't show up unless asked for.
        assert!(q(ViewQuery::default()).iter().all(|r| r.kind != "task"));
    }

    #[test]
    fn notes_hub_links_both_ways() {
        use crate::index::ViewQuery;
        let tmp = tempfile::tempdir().unwrap();
        let k = key(4);
        let mut ws = Workspace::create(tmp.path(), "ws", &manifest("H").save(), &k).unwrap();

        // A project with one phase and one task that links to the note.
        let mut tr = AutoCommit::new();
        let t = tr.put_object(ROOT, "title", ObjType::Text).unwrap();
        tr.splice_text(&t, 0, 0, "Launch").unwrap();
        tr.put_object(ROOT, "tags", ObjType::List).unwrap();
        tr.put(ROOT, "prefix", "LA").unwrap();
        tr.put_object(ROOT, "columns", ObjType::List).unwrap();
        let phases = tr.put_object(ROOT, "phases", ObjType::Map).unwrap();
        let p = tr.put_object(&phases, "ph1", ObjType::Map).unwrap();
        tr.put(&p, "name", "Alpha").unwrap();
        let tasks = tr.put_object(ROOT, "tasks", ObjType::Map).unwrap();
        let task = tr.put_object(&tasks, "t1", ObjType::Map).unwrap();
        tr.put(&task, "number", 7i64).unwrap();
        tr.put(&task, "title", "Ship").unwrap();
        tr.put_object(&task, "tags", ObjType::List).unwrap();
        let tl = tr.put_object(&task, "links", ObjType::List).unwrap();
        tr.insert(&tl, 0, "n1").unwrap();
        ws.create_doc(&k, "tr", "tracker", &tr.save(), "tracker.create").unwrap();

        // A whiteboard with a card pointing at the note.
        let mut wb = AutoCommit::new();
        let t = wb.put_object(ROOT, "title", ObjType::Text).unwrap();
        wb.splice_text(&t, 0, 0, "Board").unwrap();
        wb.put_object(ROOT, "tags", ObjType::List).unwrap();
        let els = wb.put_object(ROOT, "elements", ObjType::Map).unwrap();
        let card = wb.put_object(&els, "c", ObjType::Map).unwrap();
        wb.put(&card, "ref", "n1").unwrap();
        ws.create_doc(&k, "wb", "whiteboard", &wb.save(), "whiteboard.create").unwrap();

        // The note: a summary, and links to the phase and the whiteboard.
        let mut note = AutoCommit::new();
        let t = note.put_object(ROOT, "title", ObjType::Text).unwrap();
        note.splice_text(&t, 0, 0, "Plan").unwrap();
        note.put_object(ROOT, "tags", ObjType::List).unwrap();
        let b = note.put_object(ROOT, "body", ObjType::Text).unwrap();
        note.splice_text(&b, 0, 0, "four words right here").unwrap();
        let sm = note.put_object(ROOT, "summary", ObjType::Text).unwrap();
        note.splice_text(&sm, 0, 0, "Quarterly roadmap").unwrap();
        let nl = note.put_object(ROOT, "links", ObjType::List).unwrap();
        note.insert(&nl, 0, "ph1").unwrap();
        note.insert(&nl, 1, "wb").unwrap();
        ws.create_doc(&k, "n1", "note", &note.save(), "note.create").unwrap();

        let hub = ws.notes_hub().unwrap();
        assert_eq!(hub.len(), 1);
        let row = &hub[0];
        assert_eq!(row.summary, "Quarterly roadmap");
        assert_eq!(row.words, 4);
        let out: Vec<_> = row.links.outgoing.iter().map(|l| (l.kind.as_deref(), l.title.as_str())).collect();
        assert_eq!(out, vec![(Some("phase"), "Alpha"), (Some("whiteboard"), "Board")]);
        assert_eq!(row.links.outgoing[0].tracker_title.as_deref(), Some("Launch"));
        let inc: Vec<_> = row.links.incoming.iter().map(|l| (l.kind.as_deref(), l.key.as_deref())).collect();
        // Sorted by title: "Board" before "Ship".
        assert_eq!(inc, vec![(Some("whiteboard"), None), (Some("task"), Some("LA-7"))]);

        // From the phase's side, the note shows as attached.
        let phase_links = ws.links_of("ph1").unwrap();
        assert_eq!(phase_links.incoming.len(), 1);
        assert_eq!(phase_links.incoming[0].id, "n1");

        // The summary is searchable.
        let hits = ws.query(&ViewQuery { text: "quarterly".into(), ..Default::default() }).unwrap();
        assert_eq!(hits.len(), 1);

        // Delete the phase: the note keeps the link, shown as a deleted item.
        let phases_obj = match tr.get(ROOT, "phases").unwrap() { Some((_, id)) => id, None => panic!() };
        tr.delete(&phases_obj, "ph1").unwrap();
        tr.commit();
        let change = tr.get_last_local_change().unwrap().raw_bytes().to_vec();
        ws.apply_change(&k, "tr", change, "phase.delete", None).unwrap();
        let hub = ws.notes_hub().unwrap();
        let gone = hub[0].links.outgoing.iter().find(|l| l.id == "ph1").unwrap();
        assert_eq!(gone.kind, None);
    }

    #[test]
    fn rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let m = manifest("x").save();
        assert!(Workspace::create(tmp.path(), "../evil", &m, &key(1)).is_err());
    }
}

/// Cross-language check: docs and changes produced by the JS Automerge build.
/// Run with XLANG_DIR=/path/to/generated cargo test -p notes-core xlang
#[cfg(test)]
mod xlang {
    use super::*;

    #[test]
    fn js_changes_apply() {
        let Ok(dir) = std::env::var("XLANG_DIR") else { return };
        let read = |n: &str| std::fs::read(format!("{dir}/{n}")).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        let k = ed25519_dalek::SigningKey::from_bytes(&[3; 32]);
        let mut ws = Workspace::create(tmp.path(), "w", &read("manifest.am"), &k).unwrap();
        ws.create_doc(&k, "n1", "note", &read("note.am"), "note.create").unwrap();
        ws.apply_change(&k, "manifest", read("c1.bin"), "tree.add", Some("n1")).unwrap();
        ws.apply_change(&k, "manifest", read("c2.bin"), "tree.add", Some("f1")).unwrap();
        ws.apply_change(&k, "n1", read("c3.bin"), "note.rename", None).unwrap();
        ws.apply_change(&k, "n1", read("c4.bin"), "note.edit", None).unwrap();
        ws.apply_change(&k, "manifest", read("c5.bin"), "tree.rename", Some("f1")).unwrap();
        let tree = ws.tree().unwrap();
        let titles: Vec<_> = tree.iter().map(|n| (n.kind.as_str(), n.title.as_str())).collect();
        assert_eq!(titles, vec![("note", "Threat model"), ("folder", "Old stuff")]);
        assert_eq!(ws.name().unwrap(), "Research");
        assert!(ws.verify_log().unwrap().ok);
        let ev = ws.events(10, 0).unwrap();
        assert!(ev.iter().any(|e| e.data.contains("\"title\":\"Threat model\"")));
    }
}

/// Update files between two devices of the same user.
#[cfg(test)]
mod sync_files {
    use super::*;
    use crate::bundle::{self, Bundle};
    use crate::identity::{key_id, DeviceCert, IdentityState, Revocation};
    use automerge::transaction::Transactable;
    use automerge::{AutoCommit, ObjType, ReadDoc, ROOT};
    use ed25519_dalek::SigningKey;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    struct Setup {
        user: SigningKey,
        a: SigningKey,
        b: SigningKey,
        ids: IdentityState,
    }

    fn setup() -> Setup {
        let (user, a, b) = (key(1), key(2), key(3));
        let mut ids = IdentityState::new(&user.verifying_key());
        for (k, n) in [(&a, "A"), (&b, "B")] {
            ids.certs.insert(key_id(&k.verifying_key()), DeviceCert::issue(&user, &k.verifying_key(), n).unwrap());
        }
        Setup { user, a, b, ids }
    }

    fn note(title: &str) -> AutoCommit {
        let mut d = AutoCommit::new();
        let t = d.put_object(ROOT, "title", ObjType::Text).unwrap();
        d.splice_text(&t, 0, 0, title).unwrap();
        d.put_object(ROOT, "tags", ObjType::List).unwrap();
        d.put_object(ROOT, "body", ObjType::Text).unwrap();
        d
    }

    fn manifest_with(ws_name: &str) -> AutoCommit {
        let mut m = AutoCommit::new();
        let t = m.put_object(ROOT, "name", ObjType::Text).unwrap();
        m.splice_text(&t, 0, 0, ws_name).unwrap();
        m.put_object(ROOT, "nodes", ObjType::Map).unwrap();
        m
    }

    fn add_to_tree(ws: &mut Workspace, k: &SigningKey, m: &mut AutoCommit, id: &str) {
        let nodes = match m.get(ROOT, "nodes").unwrap() { Some((_, id)) => id, None => panic!() };
        let n = m.put_object(&nodes, id, ObjType::Map).unwrap();
        m.put(&n, "kind", "note").unwrap();
        m.put(&n, "order", "a0").unwrap();
        m.commit();
        let c = m.get_last_local_change().unwrap().raw_bytes().to_vec();
        ws.apply_change(k, "manifest", c, "tree.add", Some(id)).unwrap();
    }

    fn pack(s: &Setup, by: &SigningKey, ws: &mut Workspace) -> Vec<u8> {
        let b = Bundle {
            created_by: key_id(&by.verifying_key()),
            created: 0,
            identity: s.ids.clone(),
            workspaces: vec![ws.export(true).unwrap()],
            members: Default::default(),
        };
        bundle::seal(&s.user, &b).unwrap()
    }

    fn unpack(s: &Setup, root: &std::path::Path, bytes: &[u8], ids: &IdentityState, me: &SigningKey) -> WorkspaceImport {
        let b = bundle::open(&s.user, bytes, None).unwrap();
        let trusted = |d: &str, ts: i64, _: &str, _: &str| ids.trusted_at(d, ts);
        Workspace::import(root, &b.workspaces[0], None, &trusted, &key_id(&me.verifying_key())).unwrap()
    }

    #[test]
    fn round_trip_between_devices() {
        let s = setup();
        let (ra, rb) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());

        // Device A: a workspace with one note.
        let mut m = manifest_with("Thesis");
        let mut wa = Workspace::create(ra.path(), "ws", &m.save(), &s.a).unwrap();
        let mut n = note("Plan");
        wa.create_doc(&s.a, "n1", "note", &n.save(), "note.create").unwrap();
        add_to_tree(&mut wa, &s.a, &mut m, "n1");

        // Carry it to device B.
        let file = pack(&s, &s.a, &mut wa);
        let r = unpack(&s, rb.path(), &file, &s.ids, &s.b);
        assert!(r.created && r.problems.is_empty(), "{r:?}");
        let mut wb = Workspace::open(rb.path(), "ws").unwrap();
        assert_eq!(wb.name().unwrap(), "Thesis");
        assert_eq!(wb.tree().unwrap()[0].title, "Plan");
        assert!(wb.verify_log().unwrap().ok);

        // Importing the same file again changes nothing.
        let again = unpack(&s, rb.path(), &file, &s.ids, &s.b);
        assert_eq!((again.events_added, again.changes_added), (0, 0));

        // B edits the note (built on B's own copy) and sends it back.
        let mut nb = AutoCommit::load(&wb.load_doc("n1").unwrap()).unwrap();
        let t = match nb.get(ROOT, "title").unwrap() { Some((_, id)) => id, None => panic!() };
        nb.splice_text(&t, 4, 0, " v2").unwrap();
        nb.commit();
        let c = nb.get_last_local_change().unwrap().raw_bytes().to_vec();
        wb.apply_change(&s.b, "n1", c, "note.rename", None).unwrap();

        // Meanwhile A edits the same title concurrently.
        let t = match n.get(ROOT, "title").unwrap() { Some((_, id)) => id, None => panic!() };
        n.splice_text(&t, 0, 0, "My ").unwrap();
        n.commit();
        let c = n.get_last_local_change().unwrap().raw_bytes().to_vec();
        wa.apply_change(&s.a, "n1", c, "note.rename", None).unwrap();

        let back = pack(&s, &s.b, &mut wb);
        drop(wa);
        let r = unpack(&s, ra.path(), &back, &s.ids, &s.a);
        assert!(r.problems.is_empty(), "{r:?}");
        let wa = Workspace::open(ra.path(), "ws").unwrap();
        // Both concurrent edits survive the merge.
        assert_eq!(wa.tree().unwrap()[0].title, "My Plan v2");
        let report = wa.verify_log().unwrap();
        assert!(report.ok && report.devices == 2, "{report:?}");
    }

    #[test]
    fn refuses_unsigned_and_untrusted_changes() {
        let s = setup();
        let (ra, rb) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut m = manifest_with("W");
        let mut wa = Workspace::create(ra.path(), "ws", &m.save(), &s.a).unwrap();
        wa.create_doc(&s.a, "n1", "note", &note("Plan").save(), "note.create").unwrap();
        add_to_tree(&mut wa, &s.a, &mut m, "n1");
        let file = pack(&s, &s.a, &mut wa);
        unpack(&s, rb.path(), &file, &s.ids, &s.b);

        // An outsider device, not certified by the user, edits A's copy and logs it.
        let outsider = key(7);
        let mut n = AutoCommit::load(&wa.load_doc("n1").unwrap()).unwrap();
        let t = match n.get(ROOT, "title").unwrap() { Some((_, id)) => id, None => panic!() };
        n.splice_text(&t, 0, 0, "Evil ").unwrap();
        n.commit();
        let c = n.get_last_local_change().unwrap().raw_bytes().to_vec();
        wa.apply_change(&outsider, "n1", c, "note.rename", None).unwrap();
        let file = pack(&s, &s.a, &mut wa);
        let r = unpack(&s, rb.path(), &file, &s.ids, &s.b);
        assert_eq!(r.events_rejected, 1);
        assert!(r.untrusted.contains(&key_id(&outsider.verifying_key())));
        assert!(r.problems.iter().any(|p| p.contains("not signed")), "{r:?}");
        assert_eq!(Workspace::open(rb.path(), "ws").unwrap().tree().unwrap()[0].title, "Plan");

        // A device removed from the identity is refused the same way.
        let mut ids = s.ids.clone();
        let a_id = key_id(&s.a.verifying_key());
        ids.revocations.insert(a_id.clone(), Revocation::issue(&s.user, &a_id).unwrap());
        let mut n = AutoCommit::load(&wa.load_doc("n1").unwrap()).unwrap();
        n.put(ROOT, "summary", "after removal").unwrap();
        n.commit();
        let c = n.get_last_local_change().unwrap().raw_bytes().to_vec();
        wa.apply_change(&s.a, "n1", c, "note.edit", None).unwrap();
        let file = pack(&s, &s.a, &mut wa);
        let r = unpack(&s, rb.path(), &file, &ids, &s.b);
        assert!(r.untrusted.contains(&a_id));
        assert_eq!(r.changes_added, 0);
    }

    #[test]
    fn live_sync_sends_only_whats_missing() {
        let s = setup();
        let (ra, rb) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let trusted = |d: &str, ts: i64, _: &str, _: &str| s.ids.trusted_at(d, ts);
        let b_id = key_id(&s.b.verifying_key());

        let mut m = manifest_with("W");
        let mut wa = Workspace::create(ra.path(), "ws", &m.save(), &s.a).unwrap();
        let mut n = note("Plan");
        wa.create_doc(&s.a, "n1", "note", &n.save(), "note.create").unwrap();
        add_to_tree(&mut wa, &s.a, &mut m, "n1");

        // B has nothing yet: everything goes.
        let first = wa.delta_for(None, true).unwrap();
        Workspace::import(rb.path(), &first, None, &trusted, &b_id).unwrap();
        let mut wb = Workspace::open(rb.path(), "ws").unwrap();

        // Now A makes one edit; B's summary means only that edit is sent.
        let t = match n.get(ROOT, "title").unwrap() { Some((_, id)) => id, None => panic!() };
        n.splice_text(&t, 4, 0, "!").unwrap();
        n.commit();
        let c = n.get_last_local_change().unwrap().raw_bytes().to_vec();
        wa.apply_change(&s.a, "n1", c, "note.rename", None).unwrap();

        let delta = wa.delta_for(Some(&wb.summary(true).unwrap()), true).unwrap();
        assert_eq!(delta.events.len(), 1);
        assert_eq!(delta.docs.len(), 1);
        assert_eq!(delta.docs[0].changes.as_ref().map(|c| c.len()), Some(1));
        drop(wb);
        let r = Workspace::import(rb.path(), &delta, None, &trusted, &b_id).unwrap();
        assert!(r.problems.is_empty(), "{r:?}");
        assert_eq!(r.changed_docs, vec!["n1".to_string()]);
        let mut wb = Workspace::open(rb.path(), "ws").unwrap();
        assert_eq!(wb.tree().unwrap()[0].title, "Plan!");

        // In sync: nothing left to send either way.
        let empty = wa.delta_for(Some(&wb.summary(true).unwrap()), true).unwrap();
        assert!(empty.events.is_empty() && empty.docs.is_empty());
        let back = wb.delta_for(Some(&wa.summary(true).unwrap()), true).unwrap();
        assert!(back.events.is_empty() && back.docs.is_empty());
    }

    #[test]
    fn sealed_files_are_private_and_tamper_evident() {
        let s = setup();
        let ra = tempfile::tempdir().unwrap();
        let mut m = manifest_with("Secret plans");
        let mut wa = Workspace::create(ra.path(), "ws", &m.save(), &s.a).unwrap();
        add_to_tree(&mut wa, &s.a, &mut m, "n0");
        let file = pack(&s, &s.a, &mut wa);
        assert!(!file.windows(12).any(|w| w == b"Secret plans"), "contents must not be readable");
        assert!(bundle::open(&key(9), &file, None).is_err(), "another identity can't open it");
        // Sealed under a passphrase instead: any device with the passphrase, and only those.
        let b = bundle::open(&s.user, &file, None).unwrap();
        let pass = bundle::seal_with(&s.user, &b, "correct horse").unwrap();
        assert!(bundle::needs_passphrase(&pass) && !bundle::needs_passphrase(&file));
        assert!(bundle::open(&key(9), &pass, None).err().is_some_and(|e| e.to_string().contains("passphrase")));
        assert!(bundle::open(&key(9), &pass, Some("wrong")).is_err());
        assert_eq!(bundle::open(&key(9), &pass, Some("CORRECT HORSE")).unwrap().identity.user, b.identity.user);
        // The header (the sender) is bound to the ciphertext: swapping a byte
        // of it fails to open even with the right passphrase.
        let mut swapped = pass.clone();
        swapped[12] ^= 1;
        assert!(bundle::open(&key(9), &swapped, Some("correct horse")).is_err(), "a changed header is detected");
        let mut bad = file.clone();
        let i = bad.len() - 5;
        bad[i] ^= 1;
        assert!(bundle::open(&s.user, &bad, None).is_err(), "a flipped bit is detected");
    }

    #[test]
    fn files_sealed_for_another_person() {
        use crate::identity::BoxKey;
        let s = setup();
        let ra = tempfile::tempdir().unwrap();
        let mut m = manifest_with("For Alex");
        let mut wa = Workspace::create(ra.path(), "ws", &m.save(), &s.a).unwrap();
        add_to_tree(&mut wa, &s.a, &mut m, "n0");
        let alex = key(20);
        let mut alex_ids = IdentityState::new(&alex.verifying_key());
        let b = Bundle {
            created_by: key_id(&s.a.verifying_key()),
            created: 0,
            identity: s.ids.clone(),
            workspaces: vec![wa.export(true).unwrap()],
            members: Default::default(),
        };
        // Without a published box key there's nothing to seal to.
        assert!(bundle::seal_for(&alex_ids, &b).is_err());
        alex_ids.box_key = Some(BoxKey::issue(&alex).unwrap());
        let file = bundle::seal_for(&alex_ids, &b).unwrap();
        assert!(!file.windows(8).any(|w| w == b"For Alex"));
        let opened = bundle::open(&alex, &file, None).unwrap();
        assert_eq!(opened.workspaces[0].name, "For Alex");
        // Not the sender, not anyone else.
        assert!(bundle::open(&s.user, &file, None).is_err());
        assert!(bundle::open(&key(21), &file, None).is_err());
        let mut bad = file.clone();
        let i = bad.len() - 3;
        bad[i] ^= 1;
        assert!(bundle::open(&alex, &bad, None).is_err());
    }
}

/// Workspaces shared between different people.
#[cfg(test)]
mod sharing {
    use super::*;
    use crate::identity::{key_id, DeviceCert, IdentityState, NameRecord};
    use crate::members::Role;
    use automerge::transaction::Transactable;
    use automerge::{AutoCommit, ObjType, ReadDoc, ROOT};
    use ed25519_dalek::SigningKey;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    fn person(user: u8, device: u8, name: &str) -> (SigningKey, SigningKey, IdentityState) {
        let (u, d) = (key(user), key(device));
        let mut s = IdentityState::new(&u.verifying_key());
        s.name = Some(NameRecord::issue(&u, name).unwrap());
        s.certs.insert(key_id(&d.verifying_key()), DeviceCert::issue(&u, &d.verifying_key(), "laptop").unwrap());
        (u, d, s)
    }

    fn manifest() -> AutoCommit {
        let mut m = AutoCommit::new();
        let t = m.put_object(ROOT, "name", ObjType::Text).unwrap();
        m.splice_text(&t, 0, 0, "Team").unwrap();
        m.put_object(ROOT, "nodes", ObjType::Map).unwrap();
        m
    }

    /// Change the workspace name from a member's copy and log it with their device.
    /// Change the manifest's name, logged as `action`. Tests use "tree.rename"
    /// as a stand-in for an ordinary edit; "workspace.rename" is the owner's alone.
    fn rename_as(root: &std::path::Path, dev: &SigningKey, to: &str, action: &str) {
        let mut ws = Workspace::open(root, "w").unwrap();
        let mut m = AutoCommit::load(&ws.load_doc("manifest").unwrap()).unwrap();
        let t = match m.get(ROOT, "name").unwrap() { Some((_, id)) => id, None => panic!() };
        let len = m.text(&t).unwrap().chars().count();
        m.splice_text(&t, 0, len as isize, to).unwrap();
        m.commit();
        let c = m.get_last_local_change().unwrap().raw_bytes().to_vec();
        ws.apply_change(dev, "manifest", c, action, Some("w")).unwrap();
    }

    fn rename(root: &std::path::Path, dev: &SigningKey, to: &str) {
        rename_as(root, dev, to, "tree.rename");
    }

    /// An ordinary edit from a member's copy: give folder `id` a title,
    /// adding the folder to the layout if it isn't there yet.
    fn retitle(root: &std::path::Path, dev: &SigningKey, id: &str, title: &str) {
        let mut ws = Workspace::open(root, "w").unwrap();
        let mut m = AutoCommit::load(&ws.load_doc("manifest").unwrap()).unwrap();
        let nodes = match m.get(ROOT, "nodes").unwrap() { Some((_, id)) => id, None => panic!() };
        let n = match m.get(&nodes, id).unwrap() {
            Some((_, n)) => n,
            None => {
                let n = m.put_object(&nodes, id, ObjType::Map).unwrap();
                m.put(&n, "kind", "folder").unwrap();
                m.put(&n, "order", "a0").unwrap();
                n
            }
        };
        m.put(&n, "title", title).unwrap();
        m.commit();
        let c = m.get_last_local_change().unwrap().raw_bytes().to_vec();
        ws.apply_change(dev, "manifest", c, "tree.rename", Some(id)).unwrap();
    }

    fn title(root: &std::path::Path, id: &str) -> Option<String> {
        Workspace::open(root, "w").unwrap().title_of(id).unwrap()
    }

    /// Send everything `from` has to `to`, as live sync would, trusting by `to`'s membership.
    fn send(from: &std::path::Path, to: &std::path::Path, own_to: &IdentityState, me: &SigningKey) -> WorkspaceImport {
        let mut src = Workspace::open(from, "w").unwrap();
        let bundle = src.export(true).unwrap();
        let theirs = src.members().cloned();
        // Trust is decided by the receiver's membership merged with what arrives.
        let mut effective = Workspace::open(to, "w").ok().and_then(|w| w.members().cloned()).or(theirs.clone()).unwrap();
        if let Some(t) = &theirs {
            effective.merge(t).unwrap();
        }
        let trusted = |d: &str, ts: i64, action: &str, doc: &str| effective.trusts_event(d, ts, action, doc, own_to);
        Workspace::import(to, &bundle, theirs.as_ref(), &trusted, &key_id(&me.verifying_key())).unwrap()
    }

    #[test]
    fn editors_viewers_and_removal() {
        let (owner, od, oid) = person(1, 11, "Sam");
        let (_, xd, xid) = person(2, 12, "Alex");
        let (_, vd, vid) = person(3, 13, "Val");
        let (ro, rx, rv) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());

        // Sam creates the workspace and shares it: Alex edits, Val views.
        let mut ws = Workspace::create(ro.path(), "w", &manifest().save(), &od).unwrap();
        ws.ensure_members(&oid).unwrap();
        ws.update_members(|m| m.set_role(&owner, &xid, Role::Editor, None)).unwrap();
        ws.update_members(|m| m.set_role(&owner, &vid, Role::Viewer, None)).unwrap();
        drop(ws);

        // Both receive it.
        assert!(send(ro.path(), rx.path(), &xid, &xd).created);
        assert!(send(ro.path(), rv.path(), &vid, &vd).created);
        let m = Workspace::open(rx.path(), "w").unwrap().members().cloned().unwrap();
        assert_eq!(m.owner, oid.user);
        assert_eq!(m.role(&vid.user), Some(Role::Viewer));

        // Alex's edit reaches Sam.
        retitle(rx.path(), &xd, "f", "Plans (Alex)");
        let r = send(rx.path(), ro.path(), &oid, &od);
        assert!(r.problems.is_empty(), "{r:?}");
        assert_eq!(title(ro.path(), "f").as_deref(), Some("Plans (Alex)"));

        // Sam renames the workspace; it reaches Alex.
        rename_as(ro.path(), &od, "Team (Sam)", "workspace.rename");
        let r = send(ro.path(), rx.path(), &xid, &xd);
        assert!(r.problems.is_empty(), "{r:?}");
        assert_eq!(Workspace::open(rx.path(), "w").unwrap().name().unwrap(), "Team (Sam)");

        // Alex renaming the workspace itself is the owner's call: refused,
        // however it arrives. Labelled as an ordinary edit, the change is
        // caught by what it does; labelled as a rename, the event isn't
        // trusted at all (and, as any refused event, breaks the chain after it).
        rename(rx.path(), &xd, "Alex's team, quietly");
        let r = send(rx.path(), ro.path(), &oid, &od);
        assert!(r.problems.iter().any(|p| p.contains("rename the workspace")), "{r:?}");
        assert_eq!(Workspace::open(ro.path(), "w").unwrap().name().unwrap(), "Team (Sam)");
        rename_as(rx.path(), &xd, "Alex's team", "workspace.rename");
        let r = send(rx.path(), ro.path(), &oid, &od);
        assert!(r.untrusted.contains(&key_id(&xd.verifying_key())), "{r:?}");
        assert_eq!(Workspace::open(ro.path(), "w").unwrap().name().unwrap(), "Team (Sam)");

        // Val's edit (a modified app could make one) is refused.
        retitle(rv.path(), &vd, "f", "Plans (Val)");
        let r = send(rv.path(), ro.path(), &oid, &od);
        assert!(r.untrusted.contains(&key_id(&vd.verifying_key())), "{r:?}");
        assert_eq!(title(ro.path(), "f").as_deref(), Some("Plans (Alex)"));

        // Sam removes Alex. Alex's later edit is refused; the earlier one stands.
        let mut ws = Workspace::open(ro.path(), "w").unwrap();
        ws.update_members(|m| m.set_role(&owner, &xid, Role::Removed, None)).unwrap();
        drop(ws);
        std::thread::sleep(std::time::Duration::from_millis(5));
        retitle(rx.path(), &xd, "f", "Alex was here");
        let r = send(rx.path(), ro.path(), &oid, &od);
        assert!(r.untrusted.contains(&key_id(&xd.verifying_key())));
        assert_eq!(title(ro.path(), "f").as_deref(), Some("Plans (Alex)"));

        // A newcomer receiving everything later still gets Alex's earlier edit.
        let (_, nd, nid) = person(4, 14, "Nia");
        let mut ws = Workspace::open(ro.path(), "w").unwrap();
        ws.update_members(|m| m.set_role(&owner, &nid, Role::Viewer, None)).unwrap();
        drop(ws);
        let rn = tempfile::tempdir().unwrap();
        let r = send(ro.path(), rn.path(), &nid, &nd);
        assert!(r.problems.is_empty(), "{r:?}");
        assert_eq!(title(rn.path(), "f").as_deref(), Some("Plans (Alex)"));
        assert_eq!(Workspace::open(rn.path(), "w").unwrap().name().unwrap(), "Team (Sam)");
    }

    #[test]
    fn a_viewer_certifying_the_owners_device_cannot_hijack_it() {
        // Anyone can sign a certificate for any public key. Val (a viewer)
        // certifies Sam's device under her own user; her user id sorts first.
        let (owner, od, oid) = person(1, 11, "Sam");
        let (vu, vd, mut vid) = person(0, 13, "Val");
        let od_id = key_id(&od.verifying_key());
        vid.certs.insert(od_id.clone(), DeviceCert::issue(&vu, &od.verifying_key(), "stolen").unwrap());
        let (ro, rv) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());

        let mut ws = Workspace::create(ro.path(), "w", &manifest().save(), &od).unwrap();
        ws.ensure_members(&oid).unwrap();
        ws.update_members(|m| m.set_role(&owner, &vid, Role::Viewer, None)).unwrap();
        drop(ws);
        assert!(send(ro.path(), rv.path(), &vid, &vd).created);

        // Sam's later edit must still count on Val's copy, and on anyone's.
        rename_as(ro.path(), &od, "Team (Sam)", "workspace.rename");
        let r = send(ro.path(), rv.path(), &vid, &vd);
        assert!(!r.untrusted.contains(&od_id), "{r:?}");
        assert!(r.problems.is_empty(), "{r:?}");
        assert_eq!(Workspace::open(rv.path(), "w").unwrap().name().unwrap(), "Team (Sam)");

        let m = Workspace::open(rv.path(), "w").unwrap().members().cloned().unwrap();
        assert!(m.device_has_access(&od_id, &vid));
        assert_eq!(m.device_user(&od_id, now_ms(), &vid).map(|i| i.user.clone()), Some(oid.user.clone()));
        // Val's own device gets no edit rights from the extra certificate.
        assert!(!m.trusts_event(&key_id(&vd.verifying_key()), now_ms(), "tree.rename", "manifest", &vid));
    }

    #[test]
    fn a_root_layout_change_needs_a_signed_event() {
        // A viewer puts a whole new tree at the root of the layout. The change
        // has no dependencies, like the very first one; it must still be refused.
        let (owner, od, oid) = person(1, 11, "Sam");
        let (_, vd, vid) = person(3, 13, "Val");
        let (ro, rv) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut ws = Workspace::create(ro.path(), "w", &manifest().save(), &od).unwrap();
        ws.ensure_members(&oid).unwrap();
        ws.update_members(|m| m.set_role(&owner, &vid, Role::Viewer, None)).unwrap();
        drop(ws);
        assert!(send(ro.path(), rv.path(), &vid, &vd).created);

        let mut theirs = Workspace::open(rv.path(), "w").unwrap();
        let mut forged = AutoCommit::new();
        let t = forged.put_object(ROOT, "name", ObjType::Text).unwrap();
        forged.splice_text(&t, 0, 0, "Pwned").unwrap();
        forged.put_object(ROOT, "nodes", ObjType::Map).unwrap();
        forged.commit();
        let raw = forged.get_last_local_change().unwrap().raw_bytes().to_vec();
        // Slip the change into the doc without any event vouching for it.
        theirs.docs.import_changes("manifest", vec![automerge::Change::from_bytes(raw).unwrap()], |_, _| true).unwrap();
        drop(theirs);

        let r = send(rv.path(), ro.path(), &oid, &od);
        assert!(r.problems.iter().any(|p| p.contains("workspace layout")), "{r:?}");
        assert_eq!(Workspace::open(ro.path(), "w").unwrap().name().unwrap(), "Team");
    }

    #[test]
    fn a_private_event_cannot_vouch_for_a_shared_doc() {
        // A viewer may log private.* events (their own pins). One of those
        // events naming a layout change as its "change" must not let that
        // change in: a vouched hash only counts for the doc the event names,
        // and private events only for the signer's own private doc.
        let (owner, od, oid) = person(1, 11, "Sam");
        let (_, vd, vid) = person(3, 13, "Val");
        let (ro, rv) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut ws = Workspace::create(ro.path(), "w", &manifest().save(), &od).unwrap();
        ws.ensure_members(&oid).unwrap();
        ws.update_members(|m| m.set_role(&owner, &vid, Role::Viewer, None)).unwrap();
        drop(ws);
        assert!(send(ro.path(), rv.path(), &vid, &vd).created);

        let mut theirs = Workspace::open(rv.path(), "w").unwrap();
        let mut forged = AutoCommit::new();
        let t = forged.put_object(ROOT, "name", ObjType::Text).unwrap();
        forged.splice_text(&t, 0, 0, "Pwned").unwrap();
        forged.put_object(ROOT, "nodes", ObjType::Map).unwrap();
        forged.commit();
        let change = forged.get_last_local_change().unwrap();
        let hash = change.hash().to_string();
        theirs
            .docs
            .import_changes("manifest", vec![automerge::Change::from_bytes(change.raw_bytes().to_vec()).unwrap()], |_, _| true)
            .unwrap();
        // Three shapes of a forged voucher: a private event naming the
        // manifest, a private event naming Val's own pins doc, and a private
        // event naming the owner's pins doc.
        let pins = workspace::private_doc_id(&vid.user);
        for doc in ["manifest", pins.as_str(), &workspace::private_doc_id(&oid.user)] {
            theirs
                .log_event(&vd, "private.edit", doc, serde_json::json!({ "doc": doc, "kind": "private", "change": hash }))
                .unwrap();
        }
        drop(theirs);

        let r = send(rv.path(), ro.path(), &oid, &od);
        assert!(r.problems.iter().any(|p| p.contains("workspace layout")), "{r:?}");
        assert_eq!(Workspace::open(ro.path(), "w").unwrap().name().unwrap(), "Team");
    }

    #[test]
    fn only_the_owner_creates_or_renames_a_workspace() {
        // An editor forges a "workspace.create" event whose heads name a
        // change that renames the workspace. Creation vouches for a name, so
        // it must be the owner's alone, like renaming.
        let (owner, od, oid) = person(1, 11, "Sam");
        let (_, xd, xid) = person(2, 12, "Alex");
        let (ro, rx) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut ws = Workspace::create(ro.path(), "w", &manifest().save(), &od).unwrap();
        ws.ensure_members(&oid).unwrap();
        ws.update_members(|m| m.set_role(&owner, &xid, Role::Editor, None)).unwrap();
        drop(ws);
        assert!(send(ro.path(), rx.path(), &xid, &xd).created);

        let mut theirs = Workspace::open(rx.path(), "w").unwrap();
        let mut m = AutoCommit::load(&theirs.load_doc("manifest").unwrap()).unwrap();
        let t = match m.get(ROOT, "name").unwrap() { Some((_, id)) => id, None => panic!() };
        m.splice_text(&t, 0, 4, "Pwned").unwrap();
        m.commit();
        let change = m.get_last_local_change().unwrap();
        let hash = change.hash().to_string();
        theirs
            .docs
            .import_changes("manifest", vec![automerge::Change::from_bytes(change.raw_bytes().to_vec()).unwrap()], |_, _| true)
            .unwrap();
        theirs.log_event(&xd, "workspace.create", "w", serde_json::json!({ "name": "Pwned", "heads": [hash] })).unwrap();
        drop(theirs);

        let r = send(rx.path(), ro.path(), &oid, &od);
        assert!(r.untrusted.contains(&key_id(&xd.verifying_key())), "{r:?}");
        assert_eq!(Workspace::open(ro.path(), "w").unwrap().name().unwrap(), "Team");
    }

    #[test]
    fn a_copy_with_another_owner_is_refused() {
        let (_, od, oid) = person(1, 11, "Sam");
        let (_, xd, xid) = person(2, 12, "Alex");
        let (ro, rx) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let mut ws = Workspace::create(ro.path(), "w", &manifest().save(), &od).unwrap();
        ws.ensure_members(&oid).unwrap();
        drop(ws);
        // Alex has an unrelated workspace that happens to use the same id.
        let mut theirs = Workspace::create(rx.path(), "w", &manifest().save(), &xd).unwrap();
        theirs.ensure_members(&xid).unwrap();
        let bundle = theirs.export(true).unwrap();
        let m = theirs.members().cloned();
        let trusted = |_: &str, _: i64, _: &str, _: &str| true;
        assert!(Workspace::import(ro.path(), &bundle, m.as_ref(), &trusted, "me").is_err());
    }
}
