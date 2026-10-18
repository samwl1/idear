use super::*;
use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjType, ReadDoc, ROOT};
use notes_core::identity::{DeviceCert, NameRecord};
use notes_core::members::InviteRecord;

fn key(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

/// A user with one device, named.
fn person(user: u8, device: u8, name: &str) -> (SigningKey, SigningKey, IdentityState) {
    let (u, d) = (key(user), key(device));
    let mut s = IdentityState::new(&u.verifying_key());
    s.name = Some(NameRecord::issue(&u, name).unwrap());
    s.certs.insert(key_id(&d.verifying_key()), DeviceCert::issue(&u, &d.verifying_key(), "laptop").unwrap());
    (u, d, s)
}

fn ctx(root: &std::path::Path, user: &SigningKey, device: &SigningKey, ids: &IdentityState) -> SyncCtx {
    std::fs::create_dir_all(root.join("workspaces")).unwrap();
    let account = Account { user: user.clone(), state: ids.clone(), path: root.join("identity.json") };
    SyncCtx {
        root: root.join("workspaces"),
        device: device.clone(),
        account: Arc::new(Mutex::new(account)),
        open: Arc::new(Mutex::new(HashMap::new())),
        joins: Arc::new(Joins::load(root.join("joins.json"))),
        approvals: Arc::new(Approvals::load(root.join("approvals.json"))),
    }
}

/// A join as the app builds one from a link, with the workspace already
/// known (as it is once the owner has answered, or from an old-style link).
fn pending(record: &InviteRecord, secret: [u8; 32], owner: &IdentityState, name: &str) -> PendingJoin {
    PendingJoin {
        workspace: record.workspace.clone(),
        invite_id: record.id.clone(),
        secret: hex::encode(secret),
        secret_hash: record.secret_hash.clone(),
        workspace_name: name.into(),
        owner: owner.clone(),
        via: None,
        expires: record.expires,
        added: now(),
        last_attempt: None,
        last_error: None,
        status: JoinStatus::Trying,
    }
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

/// One session: `a` dials `b`. Returns (what a got, what b got).
async fn sync_with_join(
    a: &SyncCtx,
    ep_a: &Endpoint,
    b: &SyncCtx,
    ep_b: &Endpoint,
    join: Option<JoinRequest>,
) -> Res<(Applied, Applied)> {
    let addr = EndpointAddr::new(ep_b.id()).with_ip_addr(ep_b.bound_sockets()[0]);
    let accept = async {
        let conn = ep_b.accept().await.unwrap().await.unwrap();
        run_responder(b, conn).await
    };
    let dial = async {
        let conn = ep_a.connect(addr, ALPN).await.map_err(err)?;
        run_initiator(a, conn, Some(b.own().unwrap().user), join).await
    };
    let (r, d) = tokio::join!(accept, dial);
    if let Err(e) = &r {
        eprintln!("responder: {e}");
    }
    let d = d?;
    Ok((d, r?.1))
}

async fn sync(a: &SyncCtx, ep_a: &Endpoint, b: &SyncCtx, ep_b: &Endpoint) -> Res<(Applied, Applied)> {
    sync_with_join(a, ep_a, b, ep_b, None).await
}

fn manifest(name: &str) -> AutoCommit {
    let mut m = AutoCommit::new();
    let t = m.put_object(ROOT, "name", ObjType::Text).unwrap();
    m.splice_text(&t, 0, 0, name).unwrap();
    m.put_object(ROOT, "nodes", ObjType::Map).unwrap();
    m
}

fn names(c: &SyncCtx) -> Vec<String> {
    notes_core::list_workspaces(&c.root).unwrap().into_iter().map(|w| w.name).collect()
}

/// Change the workspace name from this device's copy, logged as an ordinary
/// edit. Renaming the workspace itself ("workspace.rename") is the owner's
/// alone; these tests use the name field as a stand-in for any edit.
fn rename(c: &SyncCtx, id: &str, to: &str) {
    c.open.lock().unwrap().remove(id);
    let mut ws = Workspace::open(&c.root, id).unwrap();
    let mut m = AutoCommit::load(&ws.load_doc("manifest").unwrap()).unwrap();
    let t = match m.get(ROOT, "name").unwrap() {
        Some((_, id)) => id,
        None => panic!(),
    };
    let len = m.text(&t).unwrap().chars().count();
    m.splice_text(&t, 0, len as isize, to).unwrap();
    m.commit();
    let change = m.get_last_local_change().unwrap().raw_bytes().to_vec();
    ws.apply_change(&c.device, "manifest", change, "tree.rename", Some(id)).unwrap();
}

fn name_of(c: &SyncCtx, id: &str) -> String {
    c.open.lock().unwrap().remove(id);
    Workspace::open(&c.root, id).unwrap().name().unwrap()
}

fn role_of(c: &SyncCtx, id: &str, user: &str) -> Option<Role> {
    Workspace::open(&c.root, id).unwrap().members().and_then(|m| m.role(user))
}

#[tokio::test(flavor = "multi_thread")]
async fn own_devices_sync_over_iroh() {
    let (user, a, b, outsider) = (key(1), key(2), key(3), key(4));
    let mut ids = IdentityState::new(&user.verifying_key());
    ids.certs.insert(key_id(&a.verifying_key()), DeviceCert::issue(&user, &a.verifying_key(), "A").unwrap());
    // B was linked after A last heard anything: only B knows its own certificate.
    let mut ids_b = ids.clone();
    ids_b.certs.insert(key_id(&b.verifying_key()), DeviceCert::issue(&user, &b.verifying_key(), "B").unwrap());

    let (ra, rb, rc) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (ca, cb) = (ctx(ra.path(), &user, &a, &ids), ctx(rb.path(), &user, &b, &ids_b));
    Workspace::create(&ca.root, "wa", &manifest("From A").save(), &a).unwrap();
    Workspace::create(&cb.root, "wb", &manifest("From B").save(), &b).unwrap();

    let (ep_a, ep_b) = (endpoint(&a).await, endpoint(&b).await);
    let (got_a, got_b) = sync(&ca, &ep_a, &cb, &ep_b).await.unwrap();
    assert!(got_a.new_workspaces && got_b.new_workspaces);
    assert!(got_a.identity_changed, "A learned about B from B's intro");
    assert_eq!(names(&ca), vec!["From A", "From B"]);
    assert_eq!(names(&cb), vec!["From A", "From B"]);

    // Second round: nothing new either way.
    let (again_a, again_b) = sync(&ca, &ep_a, &cb, &ep_b).await.unwrap();
    assert!(again_a.is_empty() && again_b.is_empty(), "{again_a:?} {again_b:?}");

    // A device that isn't yours is turned away and learns nothing.
    let cc = ctx(rc.path(), &key(9), &outsider, &IdentityState::new(&key(9).verifying_key()));
    let ep_c = endpoint(&outsider).await;
    let refused = sync(&cc, &ep_c, &ca, &ep_a).await;
    assert!(refused.is_err());
    assert!(names(&cc).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_workspace_reaches_your_other_devices() {
    let (user, a, b) = (key(1), key(2), key(3));
    let mut ids = IdentityState::new(&user.verifying_key());
    ids.certs.insert(key_id(&a.verifying_key()), DeviceCert::issue(&user, &a.verifying_key(), "A").unwrap());
    ids.certs.insert(key_id(&b.verifying_key()), DeviceCert::issue(&user, &b.verifying_key(), "B").unwrap());
    let (ra, rb) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (ca, cb) = (ctx(ra.path(), &user, &a, &ids), ctx(rb.path(), &user, &b, &ids));
    Workspace::create(&ca.root, "keep", &manifest("Keep").save(), &a).unwrap();
    Workspace::create(&ca.root, "gone", &manifest("Gone").save(), &a).unwrap();
    let (ep_a, ep_b) = (endpoint(&a).await, endpoint(&b).await);
    sync(&ca, &ep_a, &cb, &ep_b).await.unwrap();
    assert_eq!(names(&cb), vec!["Gone", "Keep"]);

    // Deleted on A: B still has it, but syncing moves B's copy to the trash
    // instead of sending it back to A.
    ca.delete_workspace("gone", "Gone").unwrap();
    assert_eq!(names(&ca), vec!["Keep"]);
    let (got_a, got_b) = sync(&cb, &ep_b, &ca, &ep_a).await.unwrap();
    assert!(!got_b.new_workspaces, "A must not take it back: {got_b:?}");
    assert!(got_a.removed_workspaces.contains("gone"), "{got_a:?}");
    assert_eq!(names(&ca), vec!["Keep"]);
    assert_eq!(names(&cb), vec!["Keep"]);
    assert!(cb.trash().iter().any(|t| t.id == "gone" && t.restorable && t.name == "Gone"));

    // Restored on B: A restores its own trashed copy too.
    cb.restore_workspace("gone").unwrap();
    let (got_b, got_a) = sync(&cb, &ep_b, &ca, &ep_a).await.unwrap();
    assert!(got_a.new_workspaces, "{got_a:?}");
    assert!(got_b.is_empty() || !got_b.removed_workspaces.contains("gone"));
    assert_eq!(names(&ca), vec!["Gone", "Keep"]);

    // Deleted for good on A, after B forgot it too: nothing comes back.
    ca.delete_workspace("gone", "Gone").unwrap();
    ca.purge_workspace("gone").unwrap();
    sync(&ca, &ep_a, &cb, &ep_b).await.unwrap();
    assert!(names(&ca) == vec!["Keep"] && names(&cb) == vec!["Keep"]);
    assert!(!ca.trash()[0].restorable);
    // An id that tries to leave the data folder is ignored.
    let evil = [("../x".to_string(), crate::removals::Removal { deleted: true, at: i64::MAX, name: String::new() })];
    assert_eq!(ca.merge_removals(&evil.into_iter().collect()).unwrap(), (vec![], vec![]));
}

#[tokio::test(flavor = "multi_thread")]
async fn sharing_with_other_people() {
    let (sam_key, sam_dev, sam) = person(1, 11, "Sam");
    let (_, alex_dev, alex) = person(2, 12, "Alex");
    let (_, val_dev, val) = person(3, 13, "Val");
    let (_, zed_dev, zed) = person(4, 14, "Zed");
    let dirs: Vec<_> = (0..4).map(|_| tempfile::tempdir().unwrap()).collect();
    let cs = ctx(dirs[0].path(), &sam_key, &sam_dev, &sam);
    let ca = ctx(dirs[1].path(), &key(2), &alex_dev, &alex);
    let cv = ctx(dirs[2].path(), &key(3), &val_dev, &val);
    let cz = ctx(dirs[3].path(), &key(4), &zed_dev, &zed);
    let (ep_s, ep_a, ep_v, ep_z) =
        (endpoint(&sam_dev).await, endpoint(&alex_dev).await, endpoint(&val_dev).await, endpoint(&zed_dev).await);

    // Sam has a team workspace and a private one.
    let mut team = Workspace::create(&cs.root, "team", &manifest("Team").save(), &sam_dev).unwrap();
    team.ensure_members(&sam).unwrap();
    Workspace::create(&cs.root, "private", &manifest("Private").save(), &sam_dev).unwrap();

    // Sam invites Alex as an editor and Val as a viewer.
    let mut invite = |role: Role, id: &str| {
        let (record, secret) = team.update_members(|m| m.create_invite(&sam_key, id, role, "", 600_000, false)).unwrap();
        pending(&record, secret, &sam, "Team")
    };
    let (alex_invite, val_invite) = (invite(Role::Editor, "inv-a"), invite(Role::Viewer, "inv-v"));
    drop(team);

    // Alex redeems the invite and receives the team workspace, and only that one.
    ca.joins.add(alex_invite.clone());
    let (got, _) = sync_with_join(&ca, &ep_a, &cs, &ep_s, Some(alex_invite.request())).await.unwrap();
    assert!(got.new_workspaces, "{got:?}");
    assert_eq!(names(&ca), vec!["Team"]);
    assert_eq!(role_of(&ca, "team", &alex.user), Some(Role::Editor));

    // The same invite can't be used again by someone else.
    cz.joins.add(PendingJoin { ..alex_invite.clone() });
    let reused = sync_with_join(&cz, &ep_z, &cs, &ep_s, Some(alex_invite.request())).await;
    assert!(reused.unwrap_err().contains("already been used"));
    assert!(names(&cz).is_empty());

    // A stranger with no invite is refused, and learns nothing.
    let stranger = sync(&cz, &ep_z, &cs, &ep_s).await;
    assert!(stranger.unwrap_err().contains("don't share"));

    // Alex edits; Sam gets it.
    rename(&ca, "team", "Team (Alex)");
    sync(&ca, &ep_a, &cs, &ep_s).await.unwrap();
    assert_eq!(name_of(&cs, "team"), "Team (Alex)");

    // Val joins as a viewer, then syncs straight with Alex (no Sam needed).
    cv.joins.add(val_invite.clone());
    sync_with_join(&cv, &ep_v, &cs, &ep_s, Some(val_invite.request())).await.unwrap();
    assert_eq!(role_of(&cv, "team", &val.user), Some(Role::Viewer));
    rename(&ca, "team", "Team v2");
    let (val_got, alex_got) = sync(&cv, &ep_v, &ca, &ep_a).await.unwrap();
    assert_eq!(name_of(&cv, "team"), "Team v2", "{val_got:?} {alex_got:?}");

    // An edit from Val's copy (only possible with a modified app) is refused.
    rename(&cv, "team", "Val was here");
    let (_, sam_got) = sync(&cv, &ep_v, &cs, &ep_s).await.unwrap();
    assert!(sam_got.problems.iter().any(|p| p.contains("not signed")), "{sam_got:?}");
    assert_eq!(name_of(&cs, "team"), "Team v2");

    // Sam removes Alex. Alex is told on the next sync, and further edits are refused.
    {
        let mut ws = Workspace::open(&cs.root, "team").unwrap();
        ws.update_members(|m| m.set_role(&sam_key, &alex, Role::Removed, None)).unwrap();
        cs.open.lock().unwrap().remove("team");
    }
    let (alex_got, _) = sync(&ca, &ep_a, &cs, &ep_s).await.unwrap();
    assert!(alex_got.members_changed.contains("team"));
    assert_eq!(role_of(&ca, "team", &alex.user), Some(Role::Removed));
    rename(&ca, "team", "Alex after removal");
    // Alex's app wouldn't dial Sam for this workspace anymore; even if it did, nothing is shared.
    let after = sync(&ca, &ep_a, &cs, &ep_s).await;
    assert!(after.is_ok(), "the removal notice still flows");
    assert_eq!(name_of(&cs, "team"), "Team v2");

    // Sam restores Alex as a viewer and dials him. Alex's copy says he was
    // removed, but the restore record Sam brings lets the session through.
    {
        let mut ws = Workspace::open(&cs.root, "team").unwrap();
        ws.update_members(|m| m.set_role(&sam_key, &alex, Role::Viewer, None)).unwrap();
        cs.open.lock().unwrap().remove("team");
    }
    let (_, alex_got) = sync(&cs, &ep_s, &ca, &ep_a).await.unwrap();
    assert!(alex_got.members_changed.contains("team"), "{alex_got:?}");
    assert_eq!(role_of(&ca, "team", &alex.user), Some(Role::Viewer));

    // Sam's private workspace never left his device.
    assert!(!names(&ca).contains(&"Private".to_string()));
    assert!(!names(&cv).contains(&"Private".to_string()));
}

/// Alex, an editor in Sam's workspace, links a second computer "the wrong way
/// round": the computer with the membership joins the fresh account on the
/// other one. Its old account folds into the new one (a succession record
/// both keys sign). The fresh computer gets the workspace from its sibling,
/// Sam sees one Alex rather than two, and the new account's edits count.
/// Then Sam does the same with his own account: ownership changes hands.
/// A short link names only the owner; the invite asks for approval. The
/// joiner waits, the owner decides, the next try finishes the job.
#[tokio::test(flavor = "multi_thread")]
async fn short_links_and_approval() {
    use crate::invite::{read_invite, Link};
    let (sam_key, sam_dev, sam) = person(1, 11, "Sam");
    let (alex_key, alex_dev, alex) = person(2, 12, "Alex");
    let (zed_key, zed_dev, zed) = person(4, 14, "Zed");
    let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let cs = ctx(dirs[0].path(), &sam_key, &sam_dev, &sam);
    let ca = ctx(dirs[1].path(), &alex_key, &alex_dev, &alex);
    let cz = ctx(dirs[2].path(), &zed_key, &zed_dev, &zed);
    let (ep_s, ep_a, ep_z) = (endpoint(&sam_dev).await, endpoint(&alex_dev).await, endpoint(&zed_dev).await);

    let mut team = Workspace::create(&cs.root, "team", &manifest("Team").save(), &sam_dev).unwrap();
    team.ensure_members(&sam).unwrap();
    let (record, secret) = team.update_members(|m| m.create_invite(&sam_key, "00112233aabbccdd", Role::Editor, "friends", 600_000, true)).unwrap();
    drop(team);
    // One link, sealed under a passphrase, handed to two people.
    let link = Link::sealed(&sam.user, &key_id(&sam_dev.verifying_key()), None, &record.id, record.expires, &secret, "PASS-WORD").unwrap().encode().unwrap();
    assert!(read_invite(&link, None, &alex.user).unwrap_err().contains("passphrase"));
    assert!(read_invite(&link, Some("nope"), &alex.user).is_err());
    let join = read_invite(&link, Some("pass-word"), &alex.user).unwrap();
    assert!(join.workspace.is_empty() && join.owner.certs.is_empty(), "the link carries only the owner's key");
    ca.joins.add(join.clone());

    // First contact: held for approval. Alex learns the workspace and Sam's identity; nothing else moves.
    let (got, _) = sync_with_join(&ca, &ep_a, &cs, &ep_s, Some(join.request())).await.unwrap();
    assert!(got.joins_changed && names(&ca).is_empty(), "{got:?}");
    let held = ca.joins.list().remove(0);
    assert_eq!((held.status, held.workspace.as_str(), held.workspace_name.as_str()), (JoinStatus::Waiting, "team", "Team"));
    assert!(held.owner.certs.contains_key(&key_id(&sam_dev.verifying_key())));
    let asks = cs.approvals.list();
    assert_eq!(asks.len(), 1);
    assert_eq!((asks[0].name().as_str(), asks[0].role, asks[0].workspace.as_str()), ("Alex", Role::Editor, "team"));
    // Retrying before Sam decides changes nothing.
    sync_with_join(&ca, &ep_a, &cs, &ep_s, Some(held.request())).await.unwrap();
    assert_eq!(cs.approvals.list().len(), 1);

    // Sam approves: Alex is in on the next try.
    cs.decide_join(&record.id, &alex.user, true).unwrap();
    assert!(cs.approvals.list().is_empty());
    cs.open.lock().unwrap().clear();
    let (got, _) = sync_with_join(&ca, &ep_a, &cs, &ep_s, Some(held.request())).await.unwrap();
    assert!(got.new_workspaces, "{got:?}");
    assert_eq!(names(&ca), vec!["Team"]);
    assert_eq!(role_of(&ca, "team", &alex.user), Some(Role::Editor));

    // Zed uses the same link; Sam declines, and Zed's device stops asking.
    let zjoin = read_invite(&link, Some("PASS WORD"), &zed.user).unwrap();
    cz.joins.add(zjoin.clone());
    let r = sync_with_join(&cz, &ep_z, &cs, &ep_s, Some(zjoin.request())).await;
    assert!(r.is_err(), "the invite is used up once Alex is in: {r:?}");
    assert!(cs.approvals.list().is_empty());
    // A fresh invite for Zed, declined.
    let mut team = Workspace::open(&cs.root, "team").unwrap();
    let (record2, secret2) = team.update_members(|m| m.create_invite(&sam_key, "0011223344556677", Role::Viewer, "", 600_000, true)).unwrap();
    drop(team);
    cs.open.lock().unwrap().clear();
    let link2 = Link::new(&sam.user, &key_id(&sam_dev.verifying_key()), None, &record2.id, record2.expires, &secret2).encode().unwrap();
    let zjoin = read_invite(&link2, None, &zed.user).unwrap();
    cz.joins.add(zjoin.clone());
    sync_with_join(&cz, &ep_z, &cs, &ep_s, Some(zjoin.request())).await.unwrap();
    assert_eq!(cs.approvals.list().len(), 1);
    cs.decide_join(&record2.id, &zed.user, false).unwrap();
    let r = sync_with_join(&cz, &ep_z, &cs, &ep_s, Some(zjoin.request())).await;
    assert!(r.unwrap_err().contains("declined"));
    assert!(names(&cz).is_empty());
}

/// Pins live in a private doc per member. A viewer's two devices share it;
/// the owner, who gets every other doc, never sees it.
#[tokio::test(flavor = "multi_thread")]
async fn private_docs_stay_with_their_owner() {
    use notes_core::workspace::{private_doc_id, PRIVATE};
    let (sam_key, sam_dev, sam) = person(1, 11, "Sam");
    let (val_key, val_dev, mut val) = person(3, 13, "Val");
    // Val's second device.
    let val_dev2 = key(23);
    val.certs.insert(key_id(&val_dev2.verifying_key()), DeviceCert::issue(&val_key, &val_dev2.verifying_key(), "phone").unwrap());
    let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let cs = ctx(dirs[0].path(), &sam_key, &sam_dev, &sam);
    let cv = ctx(dirs[1].path(), &val_key, &val_dev, &val);
    let cv2 = ctx(dirs[2].path(), &val_key, &val_dev2, &val);
    let (ep_s, ep_v, ep_v2) = (endpoint(&sam_dev).await, endpoint(&val_dev).await, endpoint(&val_dev2).await);

    let mut team = Workspace::create(&cs.root, "team", &manifest("Team").save(), &sam_dev).unwrap();
    team.ensure_members(&sam).unwrap();
    let (record, secret) = team.update_members(|m| m.create_invite(&sam_key, "inv-v", Role::Viewer, "", 600_000, false)).unwrap();
    let invite = pending(&record, secret, &sam, "Team");
    drop(team);
    cv.joins.add(invite.clone());
    sync_with_join(&cv, &ep_v, &cs, &ep_s, Some(invite.request())).await.unwrap();
    assert_eq!(role_of(&cv, "team", &val.user), Some(Role::Viewer));

    // Val pins something: a change to her private doc, as a viewer.
    let pins_id = private_doc_id(&val.user);
    {
        let mut ws = Workspace::open(&cv.root, "team").unwrap();
        let mut d = AutoCommit::new();
        let list = d.put_object(&ROOT, "pins", ObjType::List).unwrap();
        d.insert(&list, 0, "node:abc").unwrap();
        ws.create_doc(&val_dev, &pins_id, PRIVATE, &d.save(), "private.create").unwrap();
        // A note can't be made by a viewer, but a private doc can.
        let mut n = AutoCommit::new();
        n.put(&ROOT, "title", "Val's note").unwrap();
        assert!(ws.create_doc(&val_dev, "n1", "note", &n.save(), "note.create").is_ok(), "core doesn't gate by role; sync does");
    }
    cv.open.lock().unwrap().remove("team");

    // Her other device gets the workspace, pins included, from her (a
    // workspace only arrives from your own devices or by invite).
    sync(&cv2, &ep_v2, &cv, &ep_v).await.unwrap();
    assert_eq!(names(&cv2), vec!["Team"]);
    sync(&cv2, &ep_v2, &cs, &ep_s).await.unwrap();
    {
        let mut ws = Workspace::open(&cv2.root, "team").unwrap();
        let bytes = ws.load_doc(&pins_id).expect("pins reached the other device");
        let d = automerge::Automerge::load(&bytes).unwrap();
        assert_eq!(notes_core::docs::get_string_list(&d, &ROOT, "pins").unwrap(), vec!["node:abc"]);
        assert!(ws.load_doc("n1").is_err(), "a viewer's note is refused even between her own devices");
    }

    // Sam never receives the private doc, and the viewer's private.* events don't poison her chain for him.
    let (_, got_s) = sync(&cv, &ep_v, &cs, &ep_s).await.unwrap();
    assert!(got_s.problems.iter().all(|p| !p.contains("private")), "{:?}", got_s.problems);
    let mut ws = Workspace::open(&cs.root, "team").unwrap();
    assert!(ws.load_doc(&pins_id).is_err(), "Sam has Val's pins");
    let events = ws.events(100, 0).unwrap();
    assert!(events.iter().any(|e| e.action == "private.create" && e.device == key_id(&val_dev.verifying_key())), "the event itself is fine to hold");
}

#[tokio::test(flavor = "multi_thread")]
async fn linking_folds_one_account_into_another() {
    use notes_core::identity::Succession;
    let (sam_key, sam_dev, sam) = person(1, 11, "Sam");
    let (alex_key, alex_dev, alex) = person(2, 12, "Alex");
    let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let cs = ctx(dirs[0].path(), &sam_key, &sam_dev, &sam);
    let ca = ctx(dirs[1].path(), &alex_key, &alex_dev, &alex);
    let (ep_s, ep_a) = (endpoint(&sam_dev).await, endpoint(&alex_dev).await);

    let mut team = Workspace::create(&cs.root, "team", &manifest("Team").save(), &sam_dev).unwrap();
    team.ensure_members(&sam).unwrap();
    let (record, secret) = team.update_members(|m| m.create_invite(&sam_key, "inv", Role::Editor, "", 600_000, false)).unwrap();
    drop(team);
    let join = pending(&record, secret, &sam, "Team");
    ca.joins.add(join.clone());
    sync_with_join(&ca, &ep_a, &cs, &ep_s, Some(join.request())).await.unwrap();
    assert_eq!(names(&ca), vec!["Team"]);
    drop(ca);

    // Alex's second computer (device 13) started with a fresh account (key 3)
    // and made the link code. The old computer joins it: it now signs as
    // account 3, which carries the succession from account 2.
    let (alex2_key, alex2_dev, mut alex2) = person(3, 13, "Alex");
    alex2.predecessors.push(Succession::issue(&alex_key, &alex2_key).unwrap());
    alex2.certs.insert(key_id(&alex_dev.verifying_key()), DeviceCert::issue(&alex2_key, &alex_dev.verifying_key(), "laptop").unwrap());
    let ca = ctx(dirs[1].path(), &alex2_key, &alex_dev, &alex2);
    let mut fresh = alex2.clone();
    fresh.certs.remove(&key_id(&alex_dev.verifying_key()));
    let ca2 = ctx(dirs[2].path(), &alex2_key, &alex2_dev, &fresh);
    let ep_a2 = endpoint(&alex2_dev).await;

    // The two computers are one account now: the fresh one gets Team.
    let (got, _) = sync(&ca2, &ep_a2, &ca, &ep_a).await.unwrap();
    assert!(got.new_workspaces, "{got:?}");
    assert_eq!(names(&ca2), vec!["Team"]);
    assert_eq!(role_of(&ca2, "team", &alex2.user), Some(Role::Editor), "the editor role follows the succession");

    // Sam has never heard of account 3. On sync it learns the succession,
    // shares Team with it, and lists one Alex under the new id.
    rename(&ca2, "team", "Team (Alex, new account)");
    let (got, sam_got) = sync(&ca2, &ep_a2, &cs, &ep_s).await.unwrap();
    assert!(sam_got.problems.is_empty(), "{sam_got:?} / {got:?}");
    assert_eq!(name_of(&cs, "team"), "Team (Alex, new account)");
    let people = Workspace::open(&cs.root, "team").unwrap().members().unwrap().people();
    assert_eq!(people.len(), 2, "{people:?}");
    assert_eq!(people[1].user, alex2.user);
    assert_eq!(people[1].role, Role::Editor);

    // Sam folds his account into a new one (key 4) the same way. The new
    // account owns Team: it can change roles, and Alex's copy accepts that.
    drop(cs);
    let (sam2_key, _, mut sam2) = person(4, 14, "Sam");
    sam2.predecessors.push(Succession::issue(&sam_key, &sam2_key).unwrap());
    sam2.certs.insert(key_id(&sam_dev.verifying_key()), DeviceCert::issue(&sam2_key, &sam_dev.verifying_key(), "laptop").unwrap());
    let cs = ctx(dirs[0].path(), &sam2_key, &sam_dev, &sam2);
    {
        let mut ws = Workspace::open(&cs.root, "team").unwrap();
        ws.ensure_members(&sam2).unwrap();
        let m = ws.members().unwrap().clone();
        assert!(m.is_owner(&sam2.user), "{:?}", m.owner_keys());
        ws.update_members(|m| m.set_role(&sam2_key, &alex2, Role::Viewer, None)).unwrap();
    }
    let (_, alex_got) = sync(&cs, &ep_s, &ca2, &ep_a2).await.unwrap();
    assert!(alex_got.members_changed.contains("team"), "{alex_got:?}");
    assert_eq!(role_of(&ca2, "team", &alex2.user), Some(Role::Viewer));
    let people = Workspace::open(&ca2.root, "team").unwrap().members().unwrap().people();
    assert_eq!(people[0].user, sam2.user, "the owner shows under the new id: {people:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn update_files_between_people() {
    use notes_core::bundle;
    use notes_core::identity::BoxKey;
    let (sam_key, sam_dev, mut sam) = person(1, 11, "Sam");
    let (alex_key, alex_dev, mut alex) = person(2, 12, "Alex");
    sam.box_key = Some(BoxKey::issue(&sam_key).unwrap());
    alex.box_key = Some(BoxKey::issue(&alex_key).unwrap());
    let dirs: Vec<_> = (0..3).map(|_| tempfile::tempdir().unwrap()).collect();
    let cs = ctx(dirs[0].path(), &sam_key, &sam_dev, &sam);
    let ca = ctx(dirs[1].path(), &alex_key, &alex_dev, &alex);
    let (ep_s, ep_a) = (endpoint(&sam_dev).await, endpoint(&alex_dev).await);

    let mut team = Workspace::create(&cs.root, "team", &manifest("Team").save(), &sam_dev).unwrap();
    team.ensure_members(&sam).unwrap();
    let (record, secret) = team.update_members(|m| m.create_invite(&sam_key, "inv", Role::Editor, "", 600_000, false)).unwrap();
    drop(team);
    Workspace::create(&cs.root, "private", &manifest("Private").save(), &sam_dev).unwrap();
    let join = pending(&record, secret, &sam, "Team");
    ca.joins.add(join.clone());
    sync_with_join(&ca, &ep_a, &cs, &ep_s, Some(join.request())).await.unwrap();

    // Sam edits while apart and hands Alex a file.
    rename(&cs, "team", "Offline edit");
    let path = dirs[2].path().join("u.notesupdate");
    let (b, to) = cs.export_bundle(&["team".into()], Some(&alex.user)).unwrap();
    bundle::write_for(&path, &to.unwrap(), &b).unwrap();
    assert!(bundle::read(&path, &key(4), None).is_err(), "only Alex can open it");
    assert!(bundle::read(&path, &sam_key, None).is_err(), "not even Sam");
    let got = ca.import_bundle(bundle::read(&path, &alex_key, None).unwrap()).unwrap();
    assert_eq!(got.from, "Sam (laptop)");
    assert_eq!(name_of(&ca, "team"), "Offline edit");

    // Workspaces that aren't shared with Alex can't go in a file for him.
    assert!(cs.export_bundle(&["private".into()], Some(&alex.user)).is_err());

    // And back.
    rename(&ca, "team", "Reply");
    let (b, to) = ca.export_bundle(&["team".into()], Some(&sam.user)).unwrap();
    bundle::write_for(&path, &to.unwrap(), &b).unwrap();
    cs.import_bundle(bundle::read(&path, &sam_key, None).unwrap()).unwrap();
    assert_eq!(name_of(&cs, "team"), "Reply");
}

/// Sync through a real relay, with direct paths disabled. Run against a
/// local `iroh-relay` whose allowlist holds devices 2 and 3 but not 4:
/// `RELAY_URL=http://127.0.0.1:3340 cargo test -p notes-app through_relay -- --ignored`
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn through_relay() {
    let url: RelayUrl = std::env::var("RELAY_URL").expect("set RELAY_URL").parse().unwrap();
    let relay_only = |k: SigningKey, url: RelayUrl| async move {
        Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::from_bytes(&k.to_bytes()))
            .relay_mode(RelayMode::custom([url]))
            .clear_ip_transports()
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .unwrap()
    };
    let (user, a, b, outsider) = (key(1), key(2), key(3), key(4));
    let mut ids = IdentityState::new(&user.verifying_key());
    for k in [&a, &b, &outsider] {
        ids.certs.insert(key_id(&k.verifying_key()), DeviceCert::issue(&user, &k.verifying_key(), "D").unwrap());
    }
    let (ra, rb) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (ca, cb) = (ctx(ra.path(), &user, &a, &ids), ctx(rb.path(), &user, &b, &ids));
    Workspace::create(&ca.root, "w", &manifest("Through the relay").save(), &a).unwrap();

    let (ep_a, ep_b) = (relay_only(a.clone(), url.clone()).await, relay_only(b.clone(), url.clone()).await);
    tokio::time::timeout(Duration::from_secs(20), ep_b.online()).await.expect("B reaches the relay");
    let dial = EndpointAddr::new(ep_b.id()).with_relay_url(url.clone());
    let accept = async {
        let conn = ep_b.accept().await.unwrap().await.unwrap();
        run_responder(&cb, conn).await.unwrap()
    };
    let connect = async {
        let conn = ep_a.connect(dial, ALPN).await.unwrap();
        run_initiator(&ca, conn, None, None).await.unwrap()
    };
    let (accepted, _) = tokio::time::timeout(Duration::from_secs(30), async { tokio::join!(accept, connect) })
        .await
        .expect("sync through the relay finished");
    assert!(accepted.1.new_workspaces, "B received the workspace");
    assert_eq!(names(&cb), vec!["Through the relay"]);

    // A device missing from the relay's allowlist never gets online.
    let ep_out = relay_only(outsider.clone(), url.clone()).await;
    let online = tokio::time::timeout(Duration::from_secs(8), ep_out.online()).await;
    assert!(online.is_err(), "a device not on the allowlist was let onto the relay");
}
