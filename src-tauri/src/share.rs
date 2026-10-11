//! Sharing workspaces with other people: invites, roles, and joining.
//!
//! An invite link is `notes-share-1.<base64url JSON>` holding the owner-signed
//! invite record, its one-time secret, the workspace name, and the owner's
//! public identity (so the joiner can find and check the owner's devices).
//! Joining is finished over live sync: the joiner's device keeps dialing the
//! owner's devices with the secret until one of them answers and adds them.

use std::collections::BTreeMap;

use notes_core::identity::IdentityState;
use notes_core::members::{InviteView, MemberView, Role};
use notes_peer::invite::{read_invite, Token};
use serde::Serialize;
use tauri::State;

use crate::commands::{own_identity, with_ws, AppState, CmdResult};
use crate::sync::PendingJoin;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

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
    info: ShareInfo,
}

fn user_key(state: &AppState) -> CmdResult<ed25519_dalek::SigningKey> {
    Ok(state.account.lock().map_err(|_| "account lock poisoned".to_string())?.user.clone())
}

#[tauri::command]
pub async fn create_invite(
    state: State<'_, AppState>,
    workspace_id: String,
    role: String,
    label: String,
    days: u32,
) -> CmdResult<CreatedInvite> {
    let (token, _, info) = make_invite(&state, &workspace_id, parse_role(&role)?, &label, days)?;
    Ok(CreatedInvite { token, info })
}

/// A new invite link: (link, invite id, the workspace's sharing info).
pub(crate) fn make_invite(
    state: &AppState,
    workspace_id: &str,
    role: Role,
    label: &str,
    days: u32,
) -> CmdResult<(String, String, ShareInfo)> {
    let label = label.trim().to_string();
    if label.len() > 80 {
        return Err("Keep the label under 80 characters.".into());
    }
    if !(1..=30).contains(&days) {
        return Err("Invites can last 1 to 30 days.".into());
    }
    if !matches!(role, Role::Editor | Role::Viewer) {
        return Err("Invites are for editors or viewers.".into());
    }
    let own = own_identity(state)?;
    let key = user_key(state)?;
    let mut id_bytes = [0u8; 8];
    getrandom::getrandom(&mut id_bytes).map_err(|e| e.to_string())?;
    let id = hex::encode(id_bytes);
    let (token, info) = with_ws(state, workspace_id, |ws, device| {
        ws.ensure_members(&own)?;
        let (invite, secret) = ws.update_members(|m| m.create_invite(&key, &id, role, &label, days as i64 * DAY_MS))?;
        ws.log_event(device, "invite.create", &id, serde_json::json!({ "role": role.as_str(), "label": label }))?;
        let token = Token { invite, secret: hex::encode(secret), workspace_name: ws.name()?, owner: own.clone() };
        Ok((token, share_view(ws, &own)?))
    })?;
    Ok((token.encode()?, id, info))
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
    workspace: String,
    workspace_name: String,
    owner_name: String,
    role: Role,
    added: i64,
    expires: i64,
    last_attempt: Option<i64>,
    last_error: Option<String>,
}

impl From<PendingJoin> for JoinView {
    fn from(j: PendingJoin) -> Self {
        Self {
            workspace: j.invite.workspace.clone(),
            workspace_name: j.workspace_name,
            owner_name: j.owner.display_name(),
            role: j.invite.role,
            added: j.added,
            expires: j.invite.expires,
            last_attempt: j.last_attempt,
            last_error: j.last_error,
        }
    }
}

#[tauri::command]
pub async fn join_shared(state: State<'_, AppState>, token: String) -> CmdResult<JoinView> {
    let own = own_identity(&state)?;
    let join = read_invite(&token, &own.user)?;
    if state.root.join(&join.invite.workspace).exists() {
        let has = with_ws(&state, &join.invite.workspace, |ws, _| {
            Ok(ws.members().and_then(|m| m.role(&own.user)).is_some_and(Role::has_access))
        })?;
        if has {
            return Err("You already have this workspace.".into());
        }
    }
    state.sync.joins().add(join.clone());
    state.sync.kick();
    Ok(join.into())
}

#[tauri::command]
pub async fn list_joins(state: State<'_, AppState>) -> CmdResult<Vec<JoinView>> {
    Ok(state.sync.joins().list().into_iter().map(JoinView::from).collect())
}

#[tauri::command]
pub async fn cancel_join(state: State<'_, AppState>, workspace: String) -> CmdResult<Vec<JoinView>> {
    state.sync.joins().remove(&workspace);
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
