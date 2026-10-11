use super::*;
use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjType, ReadDoc, ROOT};
use notes_core::identity::{DeviceCert, NameRecord};

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

/// Rename a workspace from this device's copy, the way the app would.
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
    ws.apply_change(&c.device, "manifest", change, "workspace.rename", Some(id)).unwrap();
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
        let (record, secret) = team.update_members(|m| m.create_invite(&sam_key, id, role, "", 600_000)).unwrap();
        PendingJoin {
            invite: record,
            secret: hex::encode(secret),
            workspace_name: "Team".into(),
            owner: sam.clone(),
            added: now(),
            last_attempt: None,
            last_error: None,
        }
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
    let (record, secret) = team.update_members(|m| m.create_invite(&sam_key, "inv", Role::Editor, "", 600_000)).unwrap();
    drop(team);
    Workspace::create(&cs.root, "private", &manifest("Private").save(), &sam_dev).unwrap();
    let join = PendingJoin {
        invite: record,
        secret: hex::encode(secret),
        workspace_name: "Team".into(),
        owner: sam.clone(),
        added: now(),
        last_attempt: None,
        last_error: None,
    };
    ca.joins.add(join.clone());
    sync_with_join(&ca, &ep_a, &cs, &ep_s, Some(join.request())).await.unwrap();

    // Sam edits while apart and hands Alex a file.
    rename(&cs, "team", "Offline edit");
    let path = dirs[2].path().join("u.notesupdate");
    let (b, to) = cs.export_bundle(&["team".into()], Some(&alex.user)).unwrap();
    bundle::write_for(&path, &to.unwrap(), &b).unwrap();
    assert!(bundle::read(&path, &key(4)).is_err(), "only Alex can open it");
    assert!(bundle::read(&path, &sam_key).is_err(), "not even Sam");
    let got = ca.import_bundle(bundle::read(&path, &alex_key).unwrap()).unwrap();
    assert_eq!(got.from, "Sam (laptop)");
    assert_eq!(name_of(&ca, "team"), "Offline edit");

    // Workspaces that aren't shared with Alex can't go in a file for him.
    assert!(cs.export_bundle(&["private".into()], Some(&alex.user)).is_err());

    // And back.
    rename(&ca, "team", "Reply");
    let (b, to) = ca.export_bundle(&["team".into()], Some(&sam.user)).unwrap();
    bundle::write_for(&path, &to.unwrap(), &b).unwrap();
    cs.import_bundle(bundle::read(&path, &sam_key).unwrap()).unwrap();
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
