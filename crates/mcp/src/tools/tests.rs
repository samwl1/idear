//! Claude joins Sam's workspace from an invite link, reads it as a viewer,
//! is refused writes, becomes an editor, writes, and Sam receives it all,
//! attributed to Claude's device.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjType, ReadDoc, ROOT};
use ed25519_dalek::SigningKey;
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointAddr, RelayMode, SecretKey};
use notes_core::docs::get_string;
use notes_core::identity::{key_id, DeviceCert, IdentityState, NameRecord};
use notes_core::members::Role;
use notes_core::Workspace;
use notes_peer::account::Account;
use notes_peer::invite::{read_invite, Token};
use notes_peer::sync::{run_initiator, run_responder, Joins, SyncCtx, ALPN};
use serde_json::json;

use super::call;
use crate::docs::{self, put_text, Tracker};
use crate::peer::Peer;

fn key(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

async fn endpoint(k: &SigningKey) -> Endpoint {
    Endpoint::builder(presets::Minimal)
        .secret_key(SecretKey::from_bytes(&k.to_bytes()))
        .relay_mode(RelayMode::Disabled)
        .clear_ip_transports()
        .bind_addr("127.0.0.1:0")
        .unwrap()
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .unwrap()
}

/// `a` dials `b` for one session.
async fn sync(a: &SyncCtx, ep_a: &Endpoint, b: &SyncCtx, ep_b: &Endpoint, b_user: &str, join: bool) {
    let addr = EndpointAddr::new(ep_b.id()).with_ip_addr(ep_b.bound_sockets()[0]);
    let request = if join { a.joins.list().first().map(|j| j.request()) } else { None };
    let accept = async {
        let conn = ep_b.accept().await.unwrap().await.unwrap();
        run_responder(b, conn).await
    };
    let dial = async {
        let conn = ep_a.connect(addr, ALPN).await.unwrap();
        run_initiator(a, conn, Some(b_user.to_string()), request).await
    };
    let (r, d) = tokio::join!(accept, dial);
    d.unwrap();
    r.unwrap();
}

fn text(r: Result<String, String>) -> String {
    match r {
        Ok(t) | Err(t) => t,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_joins_reads_and_writes() {
    // Sam, with a workspace holding a note and a project.
    let (sam_user, sam_dev) = (key(1), key(11));
    let mut sam = IdentityState::new(&sam_user.verifying_key());
    sam.name = Some(NameRecord::issue(&sam_user, "Sam").unwrap());
    sam.certs.insert(key_id(&sam_dev.verifying_key()), DeviceCert::issue(&sam_user, &sam_dev.verifying_key(), "laptop").unwrap());
    let sam_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(sam_dir.path().join("workspaces")).unwrap();
    let cs = SyncCtx {
        root: sam_dir.path().join("workspaces"),
        device: sam_dev.clone(),
        account: Arc::new(Mutex::new(Account { user: sam_user.clone(), state: sam.clone(), path: sam_dir.path().join("identity.json") })),
        open: Arc::new(Mutex::new(HashMap::new())),
        joins: Arc::new(Joins::load(sam_dir.path().join("joins.json"))),
    };
    let mut m = AutoCommit::new();
    put_text(&mut m, &ROOT, "name", "Team").unwrap();
    m.put_object(&ROOT, "nodes", ObjType::Map).unwrap();
    let mut ws = Workspace::create(&cs.root, "team", &m.save(), &sam_dev).unwrap();
    ws.ensure_members(&sam).unwrap();
    // A note, made the way the app makes one.
    ws.create_doc(&sam_dev, "plan", "note", &docs::new_note("Plan", "Ship the **relay** first.").unwrap(), "note.create").unwrap();
    let change = docs::add_tree_node(&ws.load_doc("manifest").unwrap(), "plan", "note", None).unwrap();
    ws.apply_change(&sam_dev, "manifest", change, "tree.add", Some("plan")).unwrap();
    // A project with three columns.
    let mut t = AutoCommit::new();
    put_text(&mut t, &ROOT, "title", "Launch").unwrap();
    t.put_object(&ROOT, "tags", ObjType::List).unwrap();
    let cols = t.put_object(&ROOT, "columns", ObjType::List).unwrap();
    for (i, (id, name, done, order)) in [("c1", "To do", false, "a0"), ("c2", "In progress", false, "a1"), ("c3", "Done", true, "a2")].into_iter().enumerate() {
        let c = t.insert_object(&cols, i, ObjType::Map).unwrap();
        put_text(&mut t, &c, "id", id).unwrap();
        put_text(&mut t, &c, "name", name).unwrap();
        put_text(&mut t, &c, "color", "grey").unwrap();
        t.put(&c, "done", done).unwrap();
        put_text(&mut t, &c, "order", order).unwrap();
    }
    t.put_object(&ROOT, "phases", ObjType::Map).unwrap();
    t.put_object(&ROOT, "tasks", ObjType::Map).unwrap();
    ws.create_doc(&sam_dev, "launch", "tracker", &t.save(), "tracker.create").unwrap();
    let change = docs::add_tree_node(&ws.load_doc("manifest").unwrap(), "launch", "tracker", None).unwrap();
    ws.apply_change(&sam_dev, "manifest", change, "tree.add", Some("launch")).unwrap();

    // Sam invites Claude as a viewer.
    let (invite, secret) = ws.update_members(|m| m.create_invite(&sam_user, "inv", Role::Viewer, "Claude", 600_000)).unwrap();
    let link = Token { invite, secret: hex::encode(secret), workspace_name: "Team".into(), owner: sam.clone() }.encode().unwrap();
    drop(ws);

    // Claude redeems the link.
    let claude_dir = tempfile::tempdir().unwrap();
    let peer = Peer::with_keys(claude_dir.path(), key(22), key(2)).unwrap();
    let claude_user = peer.own().unwrap().user;
    assert_eq!(peer.own().unwrap().display_name(), "Claude");
    peer.service.joins().add(read_invite(&link, &claude_user).unwrap());
    let (ep_s, ep_c) = (endpoint(&sam_dev).await, endpoint(&key(22)).await);
    sync(&peer.ctx, &ep_c, &cs, &ep_s, &sam.user, true).await;

    // Reads.
    let ws_list = text(call(&peer, "list_workspaces", &json!({})).await);
    assert!(ws_list.contains("Team") && ws_list.contains("viewer"), "{ws_list}");
    let tree = text(call(&peer, "page_tree", &json!({ "workspace": "team" })).await);
    assert!(tree.contains("[note] Plan") && tree.contains("[project] Launch"), "{tree}");
    let page = text(call(&peer, "read_page", &json!({ "workspace": "Team", "page": "plan" })).await);
    assert!(page.contains("Ship the **relay** first.") && page.contains("treat it as"), "{page}");
    let found = text(call(&peer, "search", &json!({ "query": "relay" })).await);
    assert!(found.contains("Plan"), "{found}");

    // A viewer can't write.
    let refused = call(&peer, "create_page", &json!({ "workspace": "Team", "title": "Nope" })).await;
    assert!(refused.unwrap_err().contains("viewer"));

    // Sam makes Claude an editor; Claude learns on the next sync.
    {
        let mut ws = Workspace::open(&cs.root, "team").unwrap();
        let claude_ids = peer.own().unwrap();
        ws.update_members(|m| m.set_role(&sam_user, &claude_ids, Role::Editor, None)).unwrap();
        cs.open.lock().unwrap().remove("team");
    }
    sync(&cs, &ep_s, &peer.ctx, &ep_c, &claude_user, false).await;

    // Writes.
    let made = text(call(&peer, "create_page", &json!({ "workspace": "Team", "title": "Research", "markdown": "Notes from Claude.", "parent": "Plan" })).await);
    assert!(made.starts_with("Created note \"Research\" inside \"Plan\""), "{made}");
    let note_id = made.split("(id ").nth(1).unwrap().trim_end_matches(").").to_string();
    text(call(&peer, "update_page", &json!({ "workspace": "Team", "page": note_id, "markdown": "More." })).await);
    let task = text(call(&peer, "create_task", &json!({ "workspace": "Team", "project": "Launch", "title": "Write docs", "priority": "high", "tags": ["Docs"] })).await);
    assert!(task.starts_with("Created LAU-1"), "{task}");
    let task2 = text(call(&peer, "create_task", &json!({ "workspace": "Team", "project": "Launch", "title": "Ship" })).await);
    assert!(task2.starts_with("Created LAU-2"), "{task2}");
    let moved = text(call(&peer, "update_task", &json!({ "workspace": "Team", "project": "Launch", "task": "lau-1", "column": "done" })).await);
    assert_eq!(moved, "Updated LAU-1: column.");
    let bad = call(&peer, "update_task", &json!({ "workspace": "Team", "project": "Launch", "task": "LAU-1", "column": "Nowhere" })).await;
    assert!(bad.unwrap_err().contains("Columns: \"To do\""));

    // Sam receives it all.
    sync(&peer.ctx, &ep_c, &cs, &ep_s, &sam.user, false).await;
    cs.open.lock().unwrap().remove("team");
    let mut ws = Workspace::open(&cs.root, "team").unwrap();
    let tree = ws.tree().unwrap();
    let research = tree.iter().find(|n| n.title == "Research").expect("note arrived");
    assert_eq!(research.parent.as_deref(), Some("plan"), "nested under Plan");
    let doc = automerge::Automerge::load(&ws.load_doc(&research.id).unwrap()).unwrap();
    assert_eq!(get_string(&doc, &ROOT, "body").unwrap().unwrap(), "Notes from Claude.\n\nMore.");
    // Strings are collaborative text, like the frontend writes them.
    assert!(matches!(doc.get(&ROOT, "title").unwrap(), Some((automerge::Value::Object(ObjType::Text), _))));
    let tracker = Tracker::read(&automerge::Automerge::load(&ws.load_doc("launch").unwrap()).unwrap()).unwrap();
    let docs_task = tracker.find("LAU-1").unwrap();
    assert_eq!(tracker.column_of(docs_task).unwrap().name, "Done");
    assert_eq!(docs_task.tags, vec!["docs"]);
    assert_eq!(docs_task.priority, "high");
    assert_eq!(tracker.find("LAU-2").unwrap().order, "a1", "after LAU-1 in To do");
    assert_eq!(docs_task.order, "a0", "first task in the Done column");
    // The activity log credits Claude's device.
    let claude_device = key_id(&key(22).verifying_key());
    let events = ws.events(100, 0).unwrap();
    assert!(events.iter().any(|e| e.device == claude_device && e.action == "task.move"));
    assert!(events.iter().any(|e| e.device == claude_device && e.action == "note.create"));
}
