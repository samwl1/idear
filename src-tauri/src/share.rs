//! Sharing workspaces with other people: invites, roles, and joining.
//!
//! An invite link is `idear-share-2.<base64url>`: the owner's user key, the
//! device that made it and its relay, the invite id, the expiry, and the
//! one-time secret (sealed under a passphrase if the owner chose one).
//! Joining is finished over live sync: the joiner's device keeps dialing the
//! owner's devices with the secret until one answers. By default the owner
//! then approves the person before they're added.

use std::collections::BTreeMap;

use notes_core::identity::IdentityState;
use notes_core::members::{InviteView, MemberView, Role};
use notes_peer::invite::{read_invite, Link};
use notes_peer::sync::{Approval, JoinStatus};
use serde::Serialize;
use tauri::State;

use crate::commands::{own_identity, with_ws, AppState, CmdResult};
use crate::sync::PendingJoin;

const HOUR_MS: i64 = 60 * 60 * 1000;
/// How long an invite may last: a month.
const MAX_HOURS: u32 = 30 * 24;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_role(role: &str) -> CmdResult<Role> {
    match role {
        "editor" => Ok(Role::Editor),
        "viewer" => Ok(Role::Viewer),
        "removed" => Ok(Role::Removed),
        _ => Err(format!("\"{role}\" isn't a role you can give someone.")),
    }
}

// ---- workspace sharing info -----------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonView {
    #[serde(flatten)]
    member: MemberView,
    is_you: bool,
    /// Their devices that may sync, for matching against sync status.
    devices: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    role: Role,
    is_owner: bool,
    owner_name: String,
    people: Vec<PersonView>,
    /// Only the owner sees invites.
    invites: Vec<InviteView>,
}

fn share_view(ws: &mut notes_core::Workspace, own: &IdentityState) -> notes_core::Result<ShareInfo> {
    let m = ws.ensure_members(own)?;
    let role = m.role(&own.user).unwrap_or(Role::Removed);
    let people = m
        .people()
        .into_iter()
        .map(|p| {
            let devices = m
                .identities
                .get(&p.user)
                .map(|ids| ids.certs.keys().filter(|d| ids.is_trusted(d)).cloned().collect())
                .unwrap_or_default();
            PersonView { is_you: p.user == own.user, devices, member: p }
        })
        .collect();
    Ok(ShareInfo {
        role,
        is_owner: role == Role::Owner,
        owner_name: m.identities.get(&m.owner).map(|i| i.display_name()).unwrap_or_default(),
        people,
        invites: if role == Role::Owner { m.invites_view(now()) } else { Vec::new() },
    })
}

#[tauri::command]
pub async fn share_info(state: State<'_, AppState>, workspace_id: String) -> CmdResult<ShareInfo> {
    let own = own_identity(&state)?;
    with_ws(&state, &workspace_id, |ws, _| share_view(ws, &own))
}

// ---- invites ------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedInvite {
    token: String,
    /// Set when the link is sealed: send it by another route than the link.
    passphrase: Option<String>,
    info: ShareInfo,
}

fn user_key(state: &AppState) -> CmdResult<ed25519_dalek::SigningKey> {
    Ok(state.account.lock().map_err(|_| "account lock poisoned".to_string())?.user.clone())
}

/// `hours`: how long the link works (1 to 720). `approve`: you confirm each
/// person before they're added. `passphrase`: seal the link's secret under a
/// generated passphrase, returned alongside, to send by a different route.
#[tauri::command]
pub async fn create_invite(
    state: State<'_, AppState>,
    workspace_id: String,
    role: String,
    label: String,
    hours: u32,
    approve: bool,
    passphrase: bool,
) -> CmdResult<CreatedInvite> {
    let pass = if passphrase { Some(notes_core::identity::new_passphrase().map_err(|e| e.to_string())?) } else { None };
    let (token, _, info) = make_invite(&state, &workspace_id, parse_role(&role)?, &label, hours, approve, pass.as_deref())?;
    Ok(CreatedInvite { token, passphrase: pass, info })
}

/// A new invite link: (link, invite id, the workspace's sharing info).
pub(crate) fn make_invite(
    state: &AppState,
    workspace_id: &str,
    role: Role,
    label: &str,
    hours: u32,
    approve: bool,
    passphrase: Option<&str>,
) -> CmdResult<(String, String, ShareInfo)> {
    let label = label.trim().to_string();
    if label.len() > 80 {
        return Err("Keep the label under 80 characters.".into());
    }
    if !(1..=MAX_HOURS).contains(&hours) {
        return Err("Invites can last from an hour to 30 days.".into());
    }
    if !matches!(role, Role::Editor | Role::Viewer) {
        return Err("Invites are for editors or viewers.".into());
    }
    let own = own_identity(state)?;
    let key = user_key(state)?;
    let mut id_bytes = [0u8; 8];
    getrandom::getrandom(&mut id_bytes).map_err(|e| e.to_string())?;
    let id = hex::encode(id_bytes);
    let me = notes_core::workspace::device_id(&state.key);
    let relay = own.addresses.get(&me).and_then(|r| r.relay.clone());
    let (link, info) = with_ws(state, workspace_id, |ws, device| {
        ws.ensure_members(&own)?;
        let (invite, secret) = ws.update_members(|m| m.create_invite(&key, &id, role, &label, hours as i64 * HOUR_MS, approve))?;
        ws.log_event(device, "invite.create", &id, serde_json::json!({ "role": role.as_str(), "label": label, "approve": approve }))?;
        let link = match passphrase {
            Some(p) => Link::sealed(&own.user, &me, relay.as_deref(), &id, invite.expires, &secret, p)
                .map_err(notes_core::CoreError::Invalid)?,
            None => Link::new(&own.user, &me, relay.as_deref(), &id, invite.expires, &secret),
        };
        Ok((link, share_view(ws, &own)?))
    })?;
    Ok((link.encode()?, id, info))
}

#[tauri::command]
pub async fn cancel_invite(state: State<'_, AppState>, workspace_id: String, invite: String) -> CmdResult<ShareInfo> {
    end_invite(&state, &workspace_id, &invite)
}

pub(crate) fn end_invite(state: &AppState, workspace_id: &str, invite: &str) -> CmdResult<ShareInfo> {
    let own = own_identity(state)?;
    let key = user_key(state)?;
    let info = with_ws(state, workspace_id, |ws, device| {
        ws.ensure_members(&own)?;
        ws.update_members(|m| m.cancel_invite(&key, invite))?;
        ws.log_event(device, "invite.cancel", invite, serde_json::json!({}))?;
        share_view(ws, &own)
    })?;
    state.sync.kick();
    Ok(info)
}

#[tauri::command]
pub async fn set_member_role(
    state: State<'_, AppState>,
    workspace_id: String,
    user: String,
    role: String,
) -> CmdResult<ShareInfo> {
    set_role(&state, &workspace_id, &user, parse_role(&role)?)
}

pub(crate) fn set_role(state: &AppState, workspace_id: &str, user: &str, role: Role) -> CmdResult<ShareInfo> {
    let own = own_identity(state)?;
    let key = user_key(state)?;
    let info = with_ws(state, workspace_id, |ws, device| {
        let m = ws.ensure_members(&own)?;
        let theirs = m
            .identities
            .get(user)
            .cloned()
            .ok_or_else(|| notes_core::CoreError::Invalid("That person isn't part of this workspace.".into()))?;
        if m.role(user) == Some(role) {
            return share_view(ws, &own);
        }
        let record = ws.update_members(|m| m.set_role(&key, &theirs, role, None))?;
        let action = if role == Role::Removed { "member.remove" } else { "member.role" };
        ws.log_event(device, action, user, serde_json::json!({ "name": record.name, "role": role.as_str() }))?;
        share_view(ws, &own)
    })?;
    state.sync.kick();
    Ok(info)
}

// ---- joining ------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinView {
    /// The invite id: what to cancel by.
    id: String,
    /// Empty until the owner has answered.
    workspace: String,
    workspace_name: String,
    owner_name: String,
    added: i64,
    expires: i64,
    last_attempt: Option<i64>,
    last_error: Option<String>,
    /// "trying", "waiting" (for the owner's approval), or "declined".
    status: JoinStatus,
}

impl From<PendingJoin> for JoinView {
    fn from(j: PendingJoin) -> Self {
        Self {
            id: j.invite_id.clone(),
            workspace: j.workspace.clone(),
            workspace_name: j.workspace_name,
            owner_name: j.owner.display_name(),
            added: j.added,
            expires: j.expires,
            last_attempt: j.last_attempt,
            last_error: j.last_error,
            status: j.status,
        }
    }
}

/// Whether a link needs a passphrase before it can be used.
#[tauri::command]
pub async fn inspect_invite(token: String) -> CmdResult<bool> {
    Ok(Link::decode(&token)?.needs_passphrase())
}

#[tauri::command]
pub async fn join_shared(state: State<'_, AppState>, token: String, passphrase: Option<String>) -> CmdResult<JoinView> {
    let own = own_identity(&state)?;
    let join = read_invite(&token, passphrase.as_deref(), &own.user)?;
    state.sync.joins().add(join.clone());
    state.sync.kick();
    Ok(join.into())
}

// ---- approving people -----------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    workspace: String,
    workspace_name: String,
    invite: String,
    user: String,
    name: String,
    role: Role,
    asked: i64,
    /// A readable fingerprint of their user key, to check over another channel.
    fingerprint: String,
}

impl From<Approval> for ApprovalView {
    fn from(a: Approval) -> Self {
        Self {
            fingerprint: a.user().to_string(),
            name: a.name(),
            user: a.user().to_string(),
            workspace: a.workspace,
            workspace_name: a.workspace_name,
            invite: a.invite,
            role: a.role,
            asked: a.asked,
        }
    }
}

/// People who redeemed an invite and are waiting for you.
#[tauri::command]
pub async fn list_approvals(state: State<'_, AppState>) -> CmdResult<Vec<ApprovalView>> {
    Ok(state.sync.approvals().list().into_iter().filter(|a| a.approved.is_none()).map(ApprovalView::from).collect())
}

#[tauri::command]
pub async fn decide_join(state: State<'_, AppState>, invite: String, user: String, approve: bool) -> CmdResult<Vec<ApprovalView>> {
    state.sync.ctx().decide_join(&invite, &user, approve)?;
    state.sync.kick();
    Ok(state.sync.approvals().list().into_iter().filter(|a| a.approved.is_none()).map(ApprovalView::from).collect())
}

#[tauri::command]
pub async fn list_joins(state: State<'_, AppState>) -> CmdResult<Vec<JoinView>> {
    Ok(state.sync.joins().list().into_iter().map(JoinView::from).collect())
}

#[tauri::command]
pub async fn cancel_join(state: State<'_, AppState>, id: String) -> CmdResult<Vec<JoinView>> {
    state.sync.joins().remove(&id);
    Ok(state.sync.joins().list().into_iter().map(JoinView::from).collect())
}

// ---- contacts -----------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    user: String,
    name: String,
    /// Workspaces you both have access to.
    workspaces: Vec<String>,
    /// Whether update files can be sealed for them yet.
    can_receive_files: bool,
}

/// Everyone you share at least one workspace with.
#[tauri::command]
pub async fn share_contacts(state: State<'_, AppState>) -> CmdResult<Vec<Contact>> {
    let own = own_identity(&state)?;
    let list = notes_core::list_workspaces(&state.root).map_err(|e| e.to_string())?;
    let mut out: BTreeMap<String, Contact> = BTreeMap::new();
    for w in list {
        with_ws(&state, &w.id, |ws, _| {
            let m = ws.ensure_members(&own)?;
            if !m.role(&own.user).is_some_and(Role::has_access) {
                return Ok(());
            }
            for p in m.people() {
                if p.user == own.user || !p.role.has_access() {
                    continue;
                }
                let boxed = m.identities.get(&p.user).is_some_and(|i| i.box_key.is_some());
                let c = out.entry(p.user.clone()).or_insert(Contact {
                    user: p.user.clone(),
                    name: p.name.clone(),
                    workspaces: Vec::new(),
                    can_receive_files: false,
                });
                c.workspaces.push(w.id.clone());
                c.can_receive_files |= boxed;
            }
            Ok(())
        })?;
    }
    let mut v: Vec<Contact> = out.into_values().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(v)
}
