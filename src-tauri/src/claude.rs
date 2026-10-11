//! Claude, built in: the app itself serves Claude's MCP connection (`idear
//! mcp`), and this page gives Claude access to workspaces on this computer
//! and adds the connection to Claude Desktop.
//!
//! Claude is still its own person in each workspace, with its own keys and
//! its own copy: access goes through the same signed invites and roles as
//! anyone else's, delivered to Claude's inbox instead of pasted.

use std::path::PathBuf;

use notes_core::identity::IdentityState;
use notes_core::members::Role;
use notes_peer::inbox::{self, Letter};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::commands::{own_identity, with_ws, AppState, CmdResult};
use crate::share::{end_invite, make_invite, set_role};

/// The name Claude's connection goes by in Claude's own settings.
const SERVER: &str = "idear";

fn claude_dir() -> CmdResult<PathBuf> {
    inbox::claude_dir().ok_or_else(|| "Couldn't find your user data folder.".to_string())
}

/// What Claude runs: this app, with `mcp`.
fn command() -> CmdResult<String> {
    // An AppImage runs from a temporary mount; point at the AppImage itself.
    if let Some(p) = std::env::var_os("APPIMAGE") {
        return Ok(PathBuf::from(p).to_string_lossy().into_owned());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.canonicalize().unwrap_or(exe).to_string_lossy().into_owned();
    // Linux names a running binary that's since been replaced (an update) "<path> (deleted)".
    Ok(path.strip_suffix(" (deleted)").map(str::to_string).unwrap_or(path))
}

fn desktop_config() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("Claude").join("claude_desktop_config.json"))
}

fn quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        s.to_string()
    } else if cfg!(windows) {
        format!("\"{s}\"")
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// Claude's identity, once its connection has run at least once.
fn claude_identity() -> Option<IdentityState> {
    IdentityState::load(&claude_dir().ok()?.join("identity.json")).ok().flatten()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeWorkspace {
    id: String,
    name: String,
    /// Only the owner can give Claude access.
    can_manage: bool,
    /// Claude's role: owner never, editor, viewer, or none.
    access: String,
    /// Access given, but Claude hasn't connected to pick it up yet.
    waiting: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeDesktop {
    /// Claude Desktop's settings folder exists.
    found: bool,
    /// Its config has our connection, pointing at this copy of the app.
    connected: bool,
    /// Its config has our connection, pointing somewhere else (an old copy).
    stale: bool,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    command: String,
    /// Claude has connected at least once.
    seen: bool,
    name: String,
    desktop: ClaudeDesktop,
    /// Paste into a terminal to add the connection to Claude Code.
    code_command: String,
    workspaces: Vec<ClaudeWorkspace>,
}

fn desktop_status(cmd: &str) -> ClaudeDesktop {
    let Some(path) = desktop_config() else {
        return ClaudeDesktop { found: false, connected: false, stale: false, path: String::new() };
    };
    let found = path.parent().is_some_and(|d| d.exists());
    let entry = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("mcpServers").and_then(|m| m.get(SERVER)).cloned());
    let ours = entry.as_ref().is_some_and(|e| {
        e.get("command").and_then(Value::as_str) == Some(cmd)
            && e.get("args").and_then(Value::as_array).is_some_and(|a| a.len() == 1 && a[0] == "mcp")
    });
    ClaudeDesktop {
        found,
        connected: ours,
        stale: entry.is_some() && !ours,
        path: path.to_string_lossy().into_owned(),
    }
}

fn status(state: &AppState) -> CmdResult<ClaudeStatus> {
    let cmd = command()?;
    let own = own_identity(state)?;
    let claude = claude_identity();
    let dir = claude_dir()?;
    let waiting_joins: Vec<String> = notes_peer::sync::Joins::load(dir.join("joins.json"))
        .list()
        .into_iter()
        .map(|j| j.invite.workspace)
        .collect();
    let mut workspaces = Vec::new();
    for w in notes_core::list_workspaces(&state.root).map_err(|e| e.to_string())? {
        let item = with_ws(state, &w.id, |ws, _| {
            let name = ws.name()?;
            let m = ws.ensure_members(&own)?;
            let role = claude.as_ref().and_then(|c| m.role(&c.user)).filter(|r| r.has_access());
            let letter = inbox::get(&dir, &w.id);
            // An invite in the inbox, or picked up but not yet redeemed.
            let invited = letter.as_ref().is_some_and(|l| m.invites_view(now()).iter().any(|i| i.id == l.invite && i.status == "open"))
                || waiting_joins.contains(&w.id);
            Ok(ClaudeWorkspace {
                id: w.id.clone(),
                name,
                can_manage: m.role(&own.user) == Some(Role::Owner),
                access: match role {
                    Some(r) => r.as_str().to_string(),
                    None if invited => letter_role(&dir, &w.id, m).unwrap_or_else(|| "viewer".into()),
                    None => "none".into(),
                },
                waiting: role.is_none() && invited,
            })
        })?;
        workspaces.push(item);
    }
    workspaces.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    let q = quote(&cmd);
    Ok(ClaudeStatus {
        desktop: desktop_status(&cmd),
        code_command: format!("claude mcp add --transport stdio --scope user {SERVER} -- {q} mcp"),
        seen: claude.is_some(),
        name: claude.as_ref().map(|c| c.display_name()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Claude".into()),
        command: cmd,
        workspaces,
    })
}

/// The role on the invite waiting in Claude's inbox.
fn letter_role(dir: &std::path::Path, ws: &str, m: &notes_core::members::Members) -> Option<String> {
    let l = inbox::get(dir, ws)?;
    m.invites_view(now()).into_iter().find(|i| i.id == l.invite).map(|i| i.role.as_str().to_string())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn claude_status(state: State<'_, AppState>) -> CmdResult<ClaudeStatus> {
    status(&state)
}

/// Give Claude a role in a workspace you own, or take it away (`none`).
#[tauri::command]
pub async fn claude_set_access(state: State<'_, AppState>, workspace_id: String, access: String) -> CmdResult<ClaudeStatus> {
    let role = match access.as_str() {
        "editor" => Some(Role::Editor),
        "viewer" => Some(Role::Viewer),
        "none" => None,
        _ => return Err(format!("\"{access}\" isn't an access level.")),
    };
    let dir = claude_dir()?;
    let own = own_identity(&state)?;
    let claude = claude_identity();
    let (is_owner, member) = with_ws(&state, &workspace_id, |ws, _| {
        let m = ws.ensure_members(&own)?;
        let member = claude.as_ref().filter(|c| m.identities.contains_key(&c.user) && m.role(&c.user).is_some()).map(|c| c.user.clone());
        Ok((m.role(&own.user) == Some(Role::Owner), member))
    })?;
    if !is_owner {
        return Err("Only the workspace's owner can give Claude access.".into());
    }

    // Claude was part of this workspace before: change its role in place.
    if let Some(user) = member {
        set_role(&state, &workspace_id, &user, role.unwrap_or(Role::Removed))?;
        if role.is_none() {
            cancel_letter(&state, &dir, &workspace_id);
        }
        return status(&state);
    }

    // New to Claude: replace any invite still waiting with one for this role.
    cancel_letter(&state, &dir, &workspace_id);
    if let Some(role) = role {
        let (token, invite, _) = make_invite(&state, &workspace_id, role, "Claude", 30)?;
        inbox::put(&dir, &workspace_id, &Letter { token, invite })?;
    }
    status(&state)
}

fn cancel_letter(state: &AppState, dir: &std::path::Path, workspace: &str) {
    if let Some(l) = inbox::get(dir, workspace) {
        let _ = end_invite(state, workspace, &l.invite);
        inbox::remove(dir, workspace);
    }
}

/// Add (or update) idear in Claude Desktop's config. Keeps a backup.
#[tauri::command]
pub async fn claude_connect_desktop(state: State<'_, AppState>, connect: bool) -> CmdResult<ClaudeStatus> {
    let path = desktop_config().ok_or("Couldn't find your settings folder.")?;
    let mut config: Value = match std::fs::read(&path) {
        Ok(b) if !b.iter().all(u8::is_ascii_whitespace) => serde_json::from_slice(&b)
            .map_err(|e| format!("Claude Desktop's config isn't valid JSON ({e}), so it was left alone. Fix it, or add idear by hand."))?,
        _ => json!({}),
    };
    if !config.is_object() {
        return Err("Claude Desktop's config isn't a JSON object, so it was left alone.".into());
    }
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }
    let servers = config
        .as_object_mut()
        .expect("checked")
        .entry("mcpServers")
        .or_insert_with(|| json!({}));
    let servers = servers.as_object_mut().ok_or("\"mcpServers\" in Claude Desktop's config isn't an object.")?;
    if connect {
        servers.insert(SERVER.into(), json!({ "command": command()?, "args": ["mcp"] }));
    } else {
        servers.remove(SERVER);
    }
    std::fs::create_dir_all(path.parent().expect("has parent")).map_err(|e| e.to_string())?;
    let mut text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    status(&state)
}
