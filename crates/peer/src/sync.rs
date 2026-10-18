//! Live sync over iroh: between your own devices, and with the people you
//! share workspaces with.
//!
//! Each device runs an iroh endpoint whose identity is its device key, so the
//! peer on the other end of a connection is cryptographically the device its
//! key says it is. A session is one bidirectional stream:
//!
//! ```text
//! dialer:    Intro { identity records, optional invite to redeem }
//! answerer:  Welcome { identity records } or Refused { reason }
//! both:      Hello { per shared workspace: what I have, and its membership }
//! both:      Delta { only what the other side lacks }
//! ```
//!
//! After the intros each side knows who the other is:
//! - **One of your devices** (certified by your user key, not removed): every
//!   workspace syncs.
//! - **Someone else:** only workspaces where both of you currently have
//!   access. A stranger, or someone removed from everything you share, is
//!   refused before learning anything about you.
//!
//! Every event and change in a Delta is checked against the workspace's
//! membership (see `notes_core::members`) and goes through the same verified
//! import as update files. Devices dial each other using signed address
//! records carried in identities, plus mDNS on the local network.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::SigningKey;
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointAddr, RelayMode, RelayUrl, SecretKey};
use notes_core::bundle::{Bundle, WorkspaceBundle};
use notes_core::identity::{key_id, AddrRecord, IdentityState};
use notes_core::members::{InviteRecord, MemberRecord, Members, Role};
use notes_core::{Workspace, WorkspaceImport, WorkspaceSummary};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use crate::account::Account;

pub const ALPN: &[u8] = b"notes-app/sync/2";
/// iroh's NA East relay, run by n0. One fixed relay keeps every device's address stable.
pub const DEFAULT_RELAY: &str = "https://use1-1.relay.n0.iroh.link./";
const INTRO_LIMIT: usize = 4 * 1024 * 1024;
const HELLO_LIMIT: usize = 32 * 1024 * 1024;
const DELTA_LIMIT: usize = 512 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_TIMEOUT: Duration = Duration::from_secs(300);
const INTERVAL: Duration = Duration::from_secs(30);
/// After a local change, wait this long for more before syncing.
const DEBOUNCE: Duration = Duration::from_secs(2);

type Res<T> = Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- wire messages ------------------------------------------------------------

/// Redeem an invite: the secret from the invite link.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    pub workspace: String,
    pub invite: String,
    /// Hex of the 32-byte invite secret.
    pub secret: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intro {
    identity: IdentityState,
    join: Option<JoinRequest>,
    /// Owner-signed records of the sender's own memberships, so a member who
    /// joined after the other side last heard from the owner is still let in.
    #[serde(default)]
    proofs: Vec<MemberRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Reply {
    Welcome(Intro),
    Refused(String),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Shared {
    pub summary: WorkspaceSummary,
    pub members: Members,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hello {
    pub workspaces: Vec<Shared>,
    /// Records that removed the other side from a workspace, so their app
    /// knows to stop syncing it.
    pub removed: Vec<MemberRecord>,
    /// Workspaces deleted or restored, sent only to your own devices.
    #[serde(default)]
    pub deleted: crate::removals::Removals,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Delta {
    pub workspaces: Vec<WorkspaceBundle>,
}

/// Who's on the other end of a session.
#[derive(Clone)]
pub(crate) enum Peer {
    Own,
    Other(IdentityState),
}

impl Peer {
    fn user<'a>(&'a self, own: &'a IdentityState) -> &'a str {
        match self {
            Peer::Own => &own.user,
            Peer::Other(ids) => &ids.user,
        }
    }
}

/// What a session brought in, for the UI.
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// Workspace id to the docs that changed in it.
    pub changed: BTreeMap<String, Vec<String>>,
    pub new_workspaces: bool,
    pub identity_changed: bool,
    /// Workspaces whose people or roles changed.
    pub members_changed: BTreeSet<String>,
    /// Workspaces another of your devices deleted, now in this one's trash.
    pub removed_workspaces: BTreeSet<String>,
    pub problems: Vec<String>,
    /// Per-workspace detail, for update files.
    #[serde(skip)]
    pub reports: Vec<WorkspaceImport>,
}

impl Applied {
    pub fn is_empty(&self) -> bool {
        self.changed.is_empty()
            && !self.new_workspaces
            && !self.identity_changed
            && self.members_changed.is_empty()
            && self.removed_workspaces.is_empty()
    }

}

// ---- pending joins -----------------------------------------------------------------

/// An invite this device is redeeming, retried until the owner is online.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingJoin {
    pub invite: InviteRecord,
    pub secret: String,
    pub workspace_name: String,
    pub owner: IdentityState,
    pub added: i64,
    #[serde(default)]
    pub last_attempt: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl PendingJoin {
    pub fn request(&self) -> JoinRequest {
        JoinRequest {
            workspace: self.invite.workspace.clone(),
            invite: self.invite.id.clone(),
            secret: self.secret.clone(),
        }
    }
}

pub struct Joins {
    path: PathBuf,
    list: Mutex<Vec<PendingJoin>>,
}

impl Joins {
    pub fn load(path: PathBuf) -> Self {
        let list = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, list: Mutex::new(list) }
    }

    fn save(&self, list: &[PendingJoin]) {
        if let Ok(bytes) = serde_json::to_vec_pretty(list) {
            let _ = std::fs::write(&self.path, bytes);
        }
    }

    pub fn list(&self) -> Vec<PendingJoin> {
        self.list.lock().map(|l| l.clone()).unwrap_or_default()
    }

    pub fn add(&self, join: PendingJoin) {
        if let Ok(mut l) = self.list.lock() {
            l.retain(|j| j.invite.workspace != join.invite.workspace);
            l.push(join);
            self.save(&l);
        }
    }

    pub fn remove(&self, workspace: &str) {
        if let Ok(mut l) = self.list.lock() {
            l.retain(|j| j.invite.workspace != workspace);
            self.save(&l);
        }
    }

    fn get(&self, workspace: &str) -> Option<PendingJoin> {
        self.list().into_iter().find(|j| j.invite.workspace == workspace)
    }

    fn note(&self, workspace: &str, error: Option<String>) {
        if let Ok(mut l) = self.list.lock() {
            if let Some(j) = l.iter_mut().find(|j| j.invite.workspace == workspace) {
                j.last_attempt = Some(now());
                j.last_error = error;
            }
            self.save(&l);
        }
    }
}

// ---- shared state ---------------------------------------------------------------

/// What a sync session reads and writes. Shared with the app's commands.
#[derive(Clone)]
pub struct SyncCtx {
    pub root: PathBuf,
    pub device: SigningKey,
    pub account: Arc<Mutex<Account>>,
    pub open: Arc<Mutex<HashMap<String, Workspace>>>,
    pub joins: Arc<Joins>,
}

impl SyncCtx {
    fn me(&self) -> String {
        key_id(&self.device.verifying_key())
    }

    fn own(&self) -> Res<IdentityState> {
        Ok(self.account.lock().map_err(|_| "account lock poisoned")?.state.clone())
    }

    fn user_key(&self) -> Res<SigningKey> {
        Ok(self.account.lock().map_err(|_| "account lock poisoned")?.user.clone())
    }

    /// Fold in records signed by your own user key. Returns whether anything changed.
    fn learn_own(&self, theirs: &IdentityState) -> Res<bool> {
        let mut a = self.account.lock().map_err(|_| "account lock poisoned")?;
        let changed = a.state.merge(theirs);
        if changed {
            a.save()?;
        }
        Ok(changed)
    }

    /// Run `f` with every workspace open and its membership set up.
    fn with_workspaces<T>(&self, f: impl FnOnce(&mut HashMap<String, Workspace>, &[String], &IdentityState) -> Res<T>) -> Res<T> {
        let own = self.own()?;
        let ids: Vec<String> = notes_core::list_workspaces(&self.root).map_err(err)?.into_iter().map(|w| w.id).collect();
        let mut open = self.open.lock().map_err(|_| "workspace lock poisoned")?;
        for id in &ids {
            if !open.contains_key(id) {
                open.insert(id.clone(), Workspace::open(&self.root, id).map_err(err)?);
            }
            open.get_mut(id).expect("opened").ensure_members(&own).map_err(err)?;
        }
        f(&mut open, &ids, &own)
    }

    /// Check who's on the other end of a connection.
    pub(crate) fn authorize(&self, device: &str, theirs: &IdentityState) -> Res<(Peer, bool)> {
        let theirs = theirs.clone().validated();
        if !theirs.is_trusted(device) {
            return Err(format!("device {} isn't one of the devices it claims to belong to", short(device)));
        }
        let own = self.own()?;
        if theirs.user == own.user {
            let changed = self.learn_own(&theirs)?;
            if !self.own()?.is_trusted(device) {
                return Err(format!("device {} was removed from your devices", short(device)));
            }
            return Ok((Peer::Own, changed));
        }
        Ok((Peer::Other(theirs), false))
    }

    /// Membership records to open a session with: your own, to prove your
    /// access, and the other person's, so they learn a new role (like being
    /// restored after removal) even while their copy would refuse you.
    ///
    /// Only workspaces the other side is already part of are mentioned. The
    /// Intro goes out before anyone is authorized, so a stranger must not
    /// learn which workspaces you are in from it. `device` is who we are
    /// talking to; `peer_user` is who we expect that to be, when known.
    fn proofs(&self, peer_user: Option<&str>, device: &str) -> Res<Vec<MemberRecord>> {
        self.with_workspaces(|open, ids, own| {
            Ok(ids
                .iter()
                .filter_map(|id| open.get(id).and_then(|w| w.members()))
                .filter(|m| {
                    m.device_has_access(device, own)
                        || peer_user.is_some_and(|u| m.role(u).is_some())
                })
                .flat_map(|m| {
                    m.records
                        .iter()
                        .filter(|r| r.user == own.user || Some(r.user.as_str()) == peer_user)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .collect())
        })
    }

    /// Fold in membership records about the other person or about you. Each
    /// is checked against the owner of the local copy, so only real grants count.
    fn learn_proofs(&self, user: &str, proofs: &[MemberRecord]) -> Res<BTreeSet<String>> {
        let own = self.own()?.user;
        let mut changed = BTreeSet::new();
        let mut open = self.open.lock().map_err(|_| "workspace lock poisoned")?;
        for r in proofs.iter().filter(|r| r.user == user || r.user == own) {
            if !self.root.join(&r.workspace).exists() {
                continue;
            }
            if !open.contains_key(&r.workspace) {
                let Ok(ws) = Workspace::open(&self.root, &r.workspace) else { continue };
                open.insert(r.workspace.clone(), ws);
            }
            let ws = open.get_mut(&r.workspace).expect("opened");
            let Some(m) = ws.members().cloned() else { continue };
            let notice = Members { records: vec![r.clone()], invites: Default::default(), identities: Default::default(), ..m };
            if ws.merge_members(&notice).unwrap_or(false) {
                changed.insert(r.workspace.clone());
            }
        }
        Ok(changed)
    }

    /// Workspaces to sync with this peer, plus removal notices for them.
    fn shared_with(&self, peer: &Peer) -> Res<(Vec<String>, Vec<MemberRecord>)> {
        self.with_workspaces(|open, ids, own| {
            let mut shared = Vec::new();
            let mut removed = Vec::new();
            for id in ids {
                let ws = open.get_mut(id).expect("opened");
                let m = ws.members().expect("ensured").clone();
                match peer {
                    Peer::Own => shared.push(id.clone()),
                    Peer::Other(theirs) => {
                        let me_ok = m.role(&own.user).is_some_and(Role::has_access);
                        match m.role(&theirs.user) {
                            Some(r) if r.has_access() && me_ok => {
                                // Keep their devices and addresses current.
                                ws.learn_identity(theirs).map_err(err)?;
                                shared.push(id.clone());
                            }
                            Some(Role::Removed) => {
                                if let Some(r) = m.records.iter().rev().find(|r| r.user == theirs.user) {
                                    removed.push(r.clone());
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Ok((shared, removed))
        })
    }

    fn hello_for(&self, peer: &Peer, shared: &[String], removed: Vec<MemberRecord>) -> Res<Hello> {
        self.with_workspaces(|open, _, own| {
            let user = peer.user(own).to_string();
            let mut workspaces = Vec::new();
            for id in shared {
                let ws = open.get_mut(id).expect("opened");
                let members = ws.members().expect("ensured").for_user(&user);
                workspaces.push(Shared { summary: ws.summary().map_err(err)?, members });
            }
            let deleted = match peer {
                Peer::Own => self.removals(),
                Peer::Other(_) => Default::default(),
            };
            Ok(Hello { workspaces, removed, deleted })
        })
    }

    /// Which of the peer's workspaces to accept changes for, with the
    /// membership to check those changes against.
    pub(crate) fn accepted(&self, peer: &Peer, theirs: &Hello) -> Res<BTreeMap<String, (Members, Members)>> {
        let own = self.own()?;
        let removals = self.removals();
        let mut out = BTreeMap::new();
        let open = self.open.lock().map_err(|_| "workspace lock poisoned")?;
        for s in &theirs.workspaces {
            // Deleted here: don't let a copy elsewhere bring it back.
            if removals.get(&s.summary.id).is_some_and(|r| r.deleted) {
                continue;
            }
            let incoming = s.members.clone().validated();
            if incoming.workspace != s.summary.id {
                continue;
            }
            let known = open.contains_key(&s.summary.id) || self.root.join(&s.summary.id).exists();
            let local = match open.get(&s.summary.id) {
                Some(ws) => ws.members().cloned(),
                None => Workspace::open(&self.root, &s.summary.id).ok().and_then(|w| w.members().cloned()),
            };
            // A copy we already hold without membership records is one this
            // account made before sharing existed: it is ours, whatever the
            // sender's records say. Only a workspace new to this device takes
            // the sender's word, and then only from its owner (checked below).
            let local = local.or_else(|| known.then(|| Members::new(&s.summary.id, &own)));
            let effective = match local {
                Some(mut l) => {
                    if l.merge(&incoming).is_err() {
                        continue; // names a different owner than ours
                    }
                    l
                }
                None => incoming.clone(),
            };
            let ok = match peer {
                Peer::Own => true,
                Peer::Other(ids) => {
                    let they = effective.role(&ids.user).is_some_and(Role::has_access);
                    let me = effective.role(&own.user).is_some_and(Role::has_access);
                    // A workspace new to this device only comes from its owner, for an invite we redeemed.
                    let invited = self
                        .joins
                        .get(&s.summary.id)
                        .is_some_and(|j| j.owner.user == ids.user && j.invite.workspace == s.summary.id);
                    they && me && (known || (invited && effective.owner == ids.user))
                }
            };
            if ok {
                out.insert(s.summary.id.clone(), (incoming, effective));
            }
        }
        Ok(out)
    }

    fn delta_for(&self, shared: &[String], theirs: &Hello) -> Res<Delta> {
        let by_id: BTreeMap<&str, &WorkspaceSummary> =
            theirs.workspaces.iter().map(|w| (w.summary.id.as_str(), &w.summary)).collect();
        self.with_workspaces(|open, _, _| {
            let mut out = Vec::new();
            for id in shared {
                // Moved to the trash since the Hello went out.
                let Some(ws) = open.get_mut(id) else { continue };
                let d = ws.delta_for(by_id.get(id.as_str()).copied()).map_err(err)?;
                if !d.docs.is_empty() || !d.events.is_empty() {
                    out.push(d);
                }
            }
            Ok(Delta { workspaces: out })
        })
    }

    pub(crate) fn apply(&self, accepted: &BTreeMap<String, (Members, Members)>, removed: &[MemberRecord], delta: &Delta) -> Res<Applied> {
        let own = self.own()?;
        let me = self.me();
        let mut applied = Applied::default();
        let mut open = self.open.lock().map_err(|_| "workspace lock poisoned")?;

        // Membership first, including for workspaces with no new content.
        for (id, (incoming, _)) in accepted {
            if !delta.workspaces.iter().any(|w| &w.id == id) {
                if let Ok(mut ws) = Workspace::open(&self.root, id) {
                    if ws.merge_members(incoming).unwrap_or(false) {
                        applied.members_changed.insert(id.clone());
                        open.remove(id);
                    }
                }
            }
        }
        for wb in &delta.workspaces {
            let Some((incoming, effective)) = accepted.get(&wb.id) else {
                applied.problems.push(format!("ignored \"{}\": it isn't shared between you", wb.name));
                continue;
            };
            // Any open copy caches docs that are about to change on disk.
            open.remove(&wb.id);
            let trusted = |d: &str, ts: i64, action: &str| effective.trusts_event(d, ts, action, &own);
            let r = match Workspace::import(&self.root, wb, Some(incoming), &trusted, &me) {
                Ok(r) => r,
                Err(e) => {
                    applied.problems.push(e.to_string());
                    continue;
                }
            };
            applied.new_workspaces |= r.created;
            if r.created {
                self.mark_present(&r.id)?;
            }
            if r.members_changed {
                applied.members_changed.insert(r.id.clone());
            }
            if !r.changed_docs.is_empty() {
                applied.changed.insert(r.id.clone(), r.changed_docs.clone());
            }
            applied.problems.extend(r.problems.iter().map(|p| format!("{}: {p}", r.name)));
            applied.reports.push(r);
        }

        // Someone told us we were removed: record it so this copy stops syncing.
        for r in removed {
            if r.user != own.user || r.role != Role::Removed {
                continue;
            }
            if let Ok(mut ws) = Workspace::open(&self.root, &r.workspace) {
                let Some(m) = ws.members().cloned() else { continue };
                let notice = Members { records: vec![r.clone()], invites: Default::default(), identities: Default::default(), ..m };
                if ws.merge_members(&notice).unwrap_or(false) {
                    applied.members_changed.insert(r.workspace.clone());
                    open.remove(&r.workspace);
                }
            }
        }
        Ok(applied)
    }

    /// The owner's side of redeeming an invite: check it and add the person.
    fn accept_join(&self, req: &JoinRequest, theirs: &IdentityState) -> Res<()> {
        let own = self.own()?;
        let user_key = self.user_key()?;
        let secret = hex::decode(&req.secret).map_err(|_| "That invite link is damaged.".to_string())?;
        let mut open = self.open.lock().map_err(|_| "workspace lock poisoned")?;
        if !open.contains_key(&req.workspace) {
            let ws = Workspace::open(&self.root, &req.workspace)
                .map_err(|_| "This workspace no longer exists on the owner's device.".to_string())?;
            open.insert(req.workspace.clone(), ws);
        }
        let ws = open.get_mut(&req.workspace).expect("opened");
        let m = ws.ensure_members(&own).map_err(err)?.clone();
        if m.owner != own.user {
            return Err("This device doesn't own that workspace.".into());
        }
        // Already redeemed by this person (e.g. a retry after a dropped connection): fine.
        if m.invite_used_by(&req.invite).is_some_and(|r| r.user == theirs.user) {
            return Ok(());
        }
        let role = m.check_invite(&req.invite, &secret, now()).map_err(err)?.role;
        if m.role(&theirs.user).is_some_and(Role::has_access) {
            return Err("You already have access to this workspace.".into());
        }
        let record = ws
            .update_members(|mm| mm.set_role(&user_key, theirs, role, Some(&req.invite)))
            .map_err(err)?;
        ws.log_event(
            &self.device,
            "member.add",
            &theirs.user,
            serde_json::json!({ "name": record.name, "role": role.as_str(), "invite": req.invite }),
        )
        .map_err(err)?;
        Ok(())
    }
}

// ---- update files -----------------------------------------------------------------

/// Who an update file came from, and what it brought.
pub struct BundleImport {
    pub applied: Applied,
    /// "Laptop" for one of your devices, "Alex (laptop)" for someone else's.
    pub from: String,
}

impl SyncCtx {
    /// The contents of an update file: for your own devices (`recipient`
    /// None), or for one person you share these workspaces with. Returns the
    /// recipient's identity, to seal the file for them.
    pub fn export_bundle(&self, workspace_ids: &[String], recipient: Option<&str>) -> Res<(Bundle, Option<IdentityState>)> {
        let (workspaces, members, to) = self.with_workspaces(|open, ids, own| {
            let mut workspaces = Vec::new();
            let mut members = BTreeMap::new();
            let mut to: Option<IdentityState> = None;
            for id in workspace_ids {
                if !ids.contains(id) {
                    return Err("One of those workspaces no longer exists.".to_string());
                }
                let ws = open.get_mut(id).expect("opened");
                let m = ws.members().expect("ensured").clone();
                match recipient {
                    None => {
                        members.insert(id.clone(), m);
                    }
                    Some(user) => {
                        let both = m.role(user).is_some_and(Role::has_access) && m.role(&own.user).is_some_and(Role::has_access);
                        if !both {
                            return Err(format!("\"{}\" isn't shared between you and them.", ws.name().map_err(err)?));
                        }
                        if let Some(theirs) = m.identities.get(user) {
                            match &mut to {
                                Some(t) => {
                                    t.merge(theirs);
                                }
                                None => to = Some(theirs.clone()),
                            }
                        }
                        members.insert(id.clone(), m.for_user(user));
                    }
                }
                workspaces.push(ws.export().map_err(err)?);
            }
            Ok((workspaces, members, to))
        })?;
        if recipient.is_some() && to.is_none() {
            return Err("This app doesn't know that person's devices yet. Sync with them once first.".into());
        }
        let bundle = Bundle { created_by: self.me(), created: now(), identity: self.own()?, workspaces, members };
        Ok((bundle, to))
    }

    /// Bring in an update file, with the same checks as live sync.
    pub fn import_bundle(&self, b: Bundle) -> Res<BundleImport> {
        let (peer, identity_changed) = self.authorize(&b.created_by, &b.identity)?;
        let device_name = b.identity.certs.get(&b.created_by).map(|c| c.name.clone()).unwrap_or_else(|| "a device".into());
        let from = match &peer {
            Peer::Own => device_name,
            Peer::Other(theirs) => format!("{} ({device_name})", theirs.display_name()),
        };
        let mut shared = Vec::new();
        for wb in &b.workspaces {
            let members = match (b.members.get(&wb.id), &peer) {
                (Some(m), _) => m.clone(),
                // Files from before sharing existed: every workspace was yours.
                (None, Peer::Own) => Members::new(&wb.id, &b.identity),
                (None, Peer::Other(_)) => continue,
            };
            let summary = WorkspaceSummary { id: wb.id.clone(), docs: Default::default(), seqs: Default::default() };
            shared.push(Shared { summary, members });
        }
        let accepted = self.accepted(&peer, &Hello { workspaces: shared, removed: Vec::new(), deleted: Default::default() })?;
        if accepted.is_empty() && !b.workspaces.is_empty() {
            return Err(match peer {
                Peer::Own => "Nothing in this file could be used.".into(),
                Peer::Other(_) => "None of the workspaces in this file are shared between you and the sender.".into(),
            });
        }
        let ids: Vec<String> = accepted.keys().cloned().collect();
        let mut applied = self.apply(&accepted, &[], &Delta { workspaces: b.workspaces })?;
        applied.identity_changed |= identity_changed;
        if let Peer::Other(theirs) = &peer {
            self.with_workspaces(|open, _, _| {
                for id in &ids {
                    if let Some(ws) = open.get_mut(id) {
                        ws.learn_identity(theirs).map_err(err)?;
                    }
                }
                Ok(())
            })?;
        }
        Ok(BundleImport { applied, from })
    }
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

// ---- wire format ----------------------------------------------------------------

async fn write_frame(send: &mut SendStream, value: &impl Serialize) -> Res<()> {
    let bytes = serde_json::to_vec(value).map_err(err)?;
    send.write_all(&(bytes.len() as u64).to_be_bytes()).await.map_err(err)?;
    send.write_all(&bytes).await.map_err(err)?;
    Ok(())
}

async fn read_frame<T: for<'de> Deserialize<'de>>(recv: &mut RecvStream, limit: usize) -> Res<T> {
    let mut len = [0u8; 8];
    recv.read_exact(&mut len).await.map_err(err)?;
    let len = u64::from_be_bytes(len) as usize;
    if len > limit {
        return Err(format!("peer sent {len} bytes, more than the {limit} allowed"));
    }
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf).await.map_err(err)?;
    serde_json::from_slice(&buf).map_err(err)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tokio::task::spawn_blocking(f).await.map_err(err)?
}

// ---- sessions -------------------------------------------------------------------

/// The part after both sides know who the other is: exchange Hellos, then
/// Deltas, both directions at once so neither blocks on a full stream window.
async fn exchange(
    ctx: &SyncCtx,
    peer: Peer,
    shared: Vec<String>,
    removed: Vec<MemberRecord>,
    send: &mut SendStream,
    recv: &mut RecvStream,
) -> Res<Applied> {
    let ours = { let (c, p, s) = (ctx.clone(), peer.clone(), shared.clone()); blocking(move || c.hello_for(&p, &s, removed)).await? };
    let (wrote, got) = tokio::join!(write_frame(send, &ours), read_frame::<Hello>(recv, HELLO_LIMIT));
    wrote?;
    let theirs = Arc::new(got?);

    // Your other device deleted or restored workspaces: do the same here first.
    let mut moved = (vec![], vec![]);
    if matches!(peer, Peer::Own) {
        let (c, t) = (ctx.clone(), theirs.clone());
        moved = blocking(move || c.merge_removals(&t.deleted)).await?;
    }

    let accepted = { let (c, p, t) = (ctx.clone(), peer.clone(), theirs.clone()); blocking(move || c.accepted(&p, &t)).await? };
    let delta = { let (c, s, t) = (ctx.clone(), shared.clone(), theirs.clone()); blocking(move || c.delta_for(&s, &t)).await? };
    let (wrote, got) = tokio::join!(write_frame(send, &delta), read_frame::<Delta>(recv, DELTA_LIMIT));
    wrote?;
    let incoming = got?;
    send.finish().map_err(err)?;
    let c = ctx.clone();
    let mut applied = blocking(move || c.apply(&accepted, &theirs.removed, &incoming)).await?;
    applied.removed_workspaces.extend(moved.0);
    applied.new_workspaces |= !moved.1.is_empty();
    // Closing before the peer has everything we sent would cut it off.
    let _ = tokio::time::timeout(Duration::from_secs(10), send.stopped()).await;
    Ok(applied)
}

/// Dial side. `peer_user` is who we expect to reach; `join` redeems an
/// invite with the workspace's owner.
pub async fn run_initiator(
    ctx: &SyncCtx,
    conn: Connection,
    peer_user: Option<String>,
    join: Option<JoinRequest>,
) -> Res<Applied> {
    let (mut send, mut recv) = conn.open_bi().await.map_err(err)?;
    let device = hex::encode(conn.remote_id().as_bytes());
    let proofs = { let (c, d) = (ctx.clone(), device.clone()); blocking(move || c.proofs(peer_user.as_deref(), &d)).await? };
    write_frame(&mut send, &Intro { identity: ctx.own()?, join, proofs }).await?;
    let theirs = match read_frame::<Reply>(&mut recv, INTRO_LIMIT).await? {
        Reply::Welcome(intro) => intro,
        Reply::Refused(reason) => return Err(reason),
    };
    let (peer, identity_changed) = ctx.authorize(&device, &theirs.identity)?;
    let learned = learn_proofs(ctx, &peer, theirs.proofs).await?;
    let (shared, removed) = { let (c, p) = (ctx.clone(), peer.clone()); blocking(move || c.shared_with(&p)).await? };
    let mut applied = exchange(ctx, peer, shared, removed, &mut send, &mut recv).await?;
    applied.identity_changed |= identity_changed;
    applied.members_changed.extend(learned);
    // Let the peer finish reading before the connection goes away.
    let _ = tokio::time::timeout(Duration::from_secs(5), conn.closed()).await;
    Ok(applied)
}

/// Membership records from someone else's intro.
async fn learn_proofs(ctx: &SyncCtx, peer: &Peer, proofs: Vec<MemberRecord>) -> Res<BTreeSet<String>> {
    let Peer::Other(theirs) = peer else { return Ok(BTreeSet::new()) };
    let (c, user) = (ctx.clone(), theirs.user.clone());
    blocking(move || c.learn_proofs(&user, &proofs)).await
}

/// Tell the dialer why, then let them read it before the connection closes.
async fn refuse(mut send: SendStream, conn: &Connection, reason: String) -> Res<(String, Applied)> {
    let _ = write_frame(&mut send, &Reply::Refused(reason.clone())).await;
    let _ = send.finish();
    let _ = tokio::time::timeout(Duration::from_secs(3), conn.closed()).await;
    Err(reason)
}

/// Answer side. Returns the peer device and what came in.
pub async fn run_responder(ctx: &SyncCtx, conn: Connection) -> Res<(String, Applied)> {
    let (mut send, mut recv) = conn.accept_bi().await.map_err(err)?;
    let intro: Intro = read_frame(&mut recv, INTRO_LIMIT).await?;
    let device = hex::encode(conn.remote_id().as_bytes());

    let (peer, identity_changed) = match ctx.authorize(&device, &intro.identity) {
        Ok(p) => p,
        Err(e) => return refuse(send, &conn, e).await,
    };
    let mut joined = None;
    if let (Some(req), Peer::Other(theirs)) = (&intro.join, &peer) {
        let (c, r, t) = (ctx.clone(), req.clone(), theirs.clone());
        if let Err(e) = blocking(move || c.accept_join(&r, &t)).await {
            return refuse(send, &conn, e).await;
        }
        joined = Some(req.workspace.clone());
    }
    let learned = learn_proofs(ctx, &peer, intro.proofs).await?;
    let (shared, removed) = { let (c, p) = (ctx.clone(), peer.clone()); blocking(move || c.shared_with(&p)).await? };
    if matches!(peer, Peer::Other(_)) && shared.is_empty() && removed.is_empty() {
        return refuse(send, &conn, "You don't share any workspaces with this person.".into()).await;
    }
    let peer_user = match &peer {
        Peer::Own => None,
        Peer::Other(theirs) => Some(theirs.user.clone()),
    };
    let proofs = { let (c, d) = (ctx.clone(), device.clone()); blocking(move || c.proofs(peer_user.as_deref(), &d)).await? };
    write_frame(&mut send, &Reply::Welcome(Intro { identity: ctx.own()?, join: None, proofs })).await?;
    let mut applied = exchange(ctx, peer, shared, removed, &mut send, &mut recv).await?;
    applied.identity_changed |= identity_changed;
    applied.members_changed.extend(learned);
    // Someone just joined one of our workspaces.
    applied.members_changed.extend(joined);
    conn.close(0u32.into(), b"done");
    Ok((device, applied))
}

// ---- settings and status ----------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    /// Relay server URL, or empty for local network only.
    pub relay: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: true, relay: DEFAULT_RELAY.to_string() }
    }
}

impl Settings {
    pub fn load(path: &std::path::Path) -> Self {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &std::path::Path) -> Res<()> {
        std::fs::write(path, serde_json::to_vec_pretty(self).map_err(err)?).map_err(err)
    }

    fn relay_mode(&self) -> Res<RelayMode> {
        let r = self.relay.trim();
        if r.is_empty() {
            return Ok(RelayMode::Disabled);
        }
        let url: RelayUrl = r.parse().map_err(|_| format!("\"{r}\" isn't a valid relay URL"))?;
        Ok(RelayMode::custom([url]))
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerStatus {
    /// The user the device belongs to.
    pub user: String,
    pub last_sync: Option<i64>,
    pub last_attempt: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub settings: Settings,
    pub running: bool,
    pub relay_connected: bool,
    /// Keyed by device.
    pub peers: BTreeMap<String, PeerStatus>,
    pub problems: Vec<String>,
}

// ---- service ---------------------------------------------------------------------

pub type OnApplied = Arc<dyn Fn(Applied) + Send + Sync>;

/// One device to dial this round.
struct Target {
    user: String,
    addr: EndpointAddr,
    join: Option<JoinRequest>,
}

pub struct SyncService {
    ctx: SyncCtx,
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    endpoint: tokio::sync::Mutex<Option<Endpoint>>,
    peers: Mutex<BTreeMap<String, PeerStatus>>,
    problems: Mutex<Vec<String>>,
    kick: Notify,
    on_applied: OnApplied,
}

impl SyncService {
    pub fn new(ctx: SyncCtx, settings_path: PathBuf, on_applied: OnApplied) -> Arc<Self> {
        let settings = Settings::load(&settings_path);
        Arc::new(Self {
            ctx,
            settings_path,
            settings: Mutex::new(settings),
            endpoint: tokio::sync::Mutex::new(None),
            peers: Mutex::new(BTreeMap::new()),
            problems: Mutex::new(Vec::new()),
            kick: Notify::new(),
            on_applied,
        })
    }

    pub fn joins(&self) -> &Joins {
        &self.ctx.joins
    }

    pub fn ctx(&self) -> &SyncCtx {
        &self.ctx
    }

    /// Bind the endpoint (if enabled) and run the accept and sync loops.
    pub async fn start(self: &Arc<Self>) {
        self.rebind().await;
        let me = self.clone();
        tokio::spawn(async move { me.tick_loop().await });
    }

    /// Ask for a sync soon, e.g. after a local change.
    pub fn kick(&self) {
        self.kick.notify_one();
    }

    async fn rebind(self: &Arc<Self>) {
        let mut slot = self.endpoint.lock().await;
        if let Some(old) = slot.take() {
            old.close().await;
        }
        let settings = self.settings.lock().map(|s| s.clone()).unwrap_or_default();
        if !settings.enabled {
            return;
        }
        match self.bind(&settings).await {
            Ok(ep) => {
                let me = self.clone();
                let accept_ep = ep.clone();
                tokio::spawn(async move { me.accept_loop(accept_ep).await });
                *slot = Some(ep);
                drop(slot);
                self.kick();
            }
            Err(e) => self.problem(format!("Couldn't start sync: {e}")),
        }
    }

    async fn bind(&self, settings: &Settings) -> Res<Endpoint> {
        let secret = SecretKey::from_bytes(&self.ctx.device.to_bytes());
        let mdns = iroh_mdns_address_lookup::MdnsAddressLookup::builder().service_name("notesapp");
        Endpoint::builder(presets::Minimal)
            .secret_key(secret)
            .relay_mode(settings.relay_mode()?)
            .address_lookup(mdns)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .map_err(err)
    }

    fn problem(&self, msg: String) {
        if let Ok(mut p) = self.problems.lock() {
            p.push(msg);
            let n = p.len();
            if n > 20 {
                p.drain(..n - 20);
            }
        }
    }

    async fn accept_loop(self: Arc<Self>, ep: Endpoint) {
        while let Some(incoming) = ep.accept().await {
            let me = self.clone();
            tokio::spawn(async move {
                let Ok(conn) = incoming.await else { return };
                let session = tokio::time::timeout(SESSION_TIMEOUT, run_responder(&me.ctx, conn)).await;
                match session {
                    Ok(Ok((peer, applied))) => {
                        me.record(&peer, None, None);
                        me.publish(applied);
                    }
                    Ok(Err(e)) => me.problem(e),
                    Err(_) => me.problem("A sync from another device timed out.".into()),
                }
            });
        }
    }

    async fn tick_loop(self: Arc<Self>) {
        loop {
            let kicked = tokio::time::timeout(INTERVAL, self.kick.notified()).await.is_ok();
            if kicked {
                tokio::time::sleep(DEBOUNCE).await;
            }
            self.sync_all().await;
        }
    }

    /// Everyone to dial: your other devices, the devices of people you share
    /// workspaces with, and owners of invites you're redeeming.
    fn targets(&self, own_relay: Option<RelayUrl>) -> Res<BTreeMap<String, Target>> {
        let own = self.ctx.own()?;
        let me = self.ctx.me();
        let mut out: BTreeMap<String, Target> = BTreeMap::new();
        let mut add = |ids: &IdentityState, device: &str, join: Option<JoinRequest>| {
            if device == me {
                return;
            }
            let Ok(addr) = dial_addr(ids, device, own_relay.clone()) else { return };
            let t = out.entry(device.to_string()).or_insert(Target { user: ids.user.clone(), addr, join: None });
            if t.join.is_none() {
                t.join = join;
            }
        };
        for d in own.certs.keys().filter(|d| own.is_trusted(d)) {
            add(&own, d, None);
        }
        self.ctx.with_workspaces(|open, ids, own| {
            for id in ids {
                let m = open.get(id).and_then(|w| w.members()).expect("ensured");
                if !m.role(&own.user).is_some_and(Role::has_access) {
                    continue;
                }
                for (user, device) in m.peer_devices(&own.user) {
                    if let Some(theirs) = m.identities.get(&user) {
                        add(theirs, &device, None);
                    }
                }
            }
            Ok(())
        })?;
        for j in self.ctx.joins.list() {
            for d in j.owner.certs.keys().filter(|d| j.owner.is_trusted(d)) {
                add(&j.owner, d, Some(j.request()));
            }
        }
        Ok(out)
    }

    /// Publish this device's current address, then sync with everyone reachable.
    pub async fn sync_all(&self) {
        let Some(ep) = self.endpoint.lock().await.clone() else { return };
        self.refresh_address(&ep);
        let own_relay = ep.addr().relay_urls().next().cloned();
        let targets = match self.targets(own_relay) {
            Ok(t) => t,
            Err(e) => {
                self.problem(e);
                return;
            }
        };
        for (device, t) in targets {
            if let Ok(mut p) = self.peers.lock() {
                let s = p.entry(device.clone()).or_default();
                s.user = t.user.clone();
                s.last_attempt = Some(now());
            }
            let joining = t.join.as_ref().map(|j| j.workspace.clone());
            let result = async {
                let conn = tokio::time::timeout(CONNECT_TIMEOUT, ep.connect(t.addr, ALPN))
                    .await
                    .map_err(|_| "not reachable right now".to_string())?
                    .map_err(err)?;
                tokio::time::timeout(SESSION_TIMEOUT, run_initiator(&self.ctx, conn, Some(t.user.clone()), t.join))
                    .await
                    .map_err(|_| "sync timed out".to_string())?
            }
            .await;
            if let Some(ws) = &joining {
                self.finish_join(ws, result.as_ref().err().cloned());
            }
            match result {
                Ok(applied) => {
                    self.record(&device, Some(&t.user), None);
                    self.publish(applied);
                }
                Err(e) => self.record(&device, Some(&t.user), Some(e)),
            }
        }
    }

    /// After trying to redeem an invite: done once membership says we're in.
    fn finish_join(&self, workspace: &str, error: Option<String>) {
        let own_user = self.ctx.own().map(|o| o.user).unwrap_or_default();
        let joined = Workspace::open(&self.ctx.root, workspace)
            .ok()
            .and_then(|w| w.members().map(|m| m.role(&own_user).is_some_and(Role::has_access)))
            .unwrap_or(false);
        if joined {
            self.ctx.joins.remove(workspace);
        } else {
            self.ctx.joins.note(workspace, error.or_else(|| Some("Waiting for the owner to come online".into())));
        }
    }

    fn refresh_address(&self, ep: &Endpoint) {
        let addr = ep.addr();
        let relay = addr.relay_urls().next().map(|u| u.to_string());
        let mut addrs: Vec<String> = addr.ip_addrs().map(|a| a.to_string()).collect();
        addrs.sort();
        let Ok(mut account) = self.ctx.account.lock() else { return };
        let me = self.ctx.me();
        if account.state.addresses.get(&me).is_some_and(|r| r.same_place(&relay, &addrs)) {
            return;
        }
        if let Ok(rec) = AddrRecord::issue(&self.ctx.device, relay, addrs) {
            account.state.addresses.insert(me, rec);
            let _ = account.save();
        }
    }

    fn record(&self, device: &str, user: Option<&str>, error: Option<String>) {
        if let Ok(mut p) = self.peers.lock() {
            let s = p.entry(device.to_string()).or_default();
            if let Some(u) = user {
                s.user = u.to_string();
            }
            if error.is_none() {
                s.last_sync = Some(now());
            }
            s.last_error = error;
        }
    }

    fn publish(&self, applied: Applied) {
        for p in &applied.problems {
            self.problem(p.clone());
        }
        if !applied.is_empty() {
            (self.on_applied)(applied);
        }
    }

    pub async fn status(&self) -> SyncStatus {
        let ep = self.endpoint.lock().await.clone();
        let relay_connected = ep
            .as_ref()
            .map(|e| {
                use iroh::Watcher;
                e.home_relay_status().get().iter().any(|s| s.is_connected())
            })
            .unwrap_or(false);
        SyncStatus {
            settings: self.settings.lock().map(|s| s.clone()).unwrap_or_default(),
            running: ep.is_some(),
            relay_connected,
            peers: self.peers.lock().map(|p| p.clone()).unwrap_or_default(),
            problems: self.problems.lock().map(|p| p.clone()).unwrap_or_default(),
        }
    }

    pub async fn update_settings(self: &Arc<Self>, next: Settings) -> Res<()> {
        next.relay_mode()?;
        next.save(&self.settings_path)?;
        *self.settings.lock().map_err(|_| "settings lock poisoned")? = next;
        self.rebind().await;
        Ok(())
    }
}

/// How to reach a device: its signed address record, if any. Without one,
/// mDNS may still find it on the local network.
fn dial_addr(identity: &IdentityState, device: &str, fallback_relay: Option<RelayUrl>) -> Res<EndpointAddr> {
    let bytes: [u8; 32] = hex::decode(device).ok().and_then(|b| b.try_into().ok()).ok_or("bad device id")?;
    let id = iroh::PublicKey::from_bytes(&bytes).map_err(err)?;
    let mut addr = EndpointAddr::new(id);
    let rec = identity.addresses.get(device);
    // Before a device has published where it is, try our own relay: devices
    // on default settings all share it.
    if rec.and_then(|r| r.relay.as_ref()).is_none() {
        if let Some(relay) = fallback_relay {
            addr = addr.with_relay_url(relay);
        }
    }
    if let Some(rec) = rec {
        if let Some(relay) = rec.relay.as_ref().and_then(|r| r.parse::<RelayUrl>().ok()) {
            addr = addr.with_relay_url(relay);
        }
        for a in rec.addrs.iter().filter_map(|a| a.parse().ok()) {
            addr = addr.with_ip_addr(a);
        }
    }
    Ok(addr)
}

#[cfg(test)]
mod tests;
