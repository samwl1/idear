use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ed25519_dalek::SigningKey;
use notes_core::eventlog::VerifyReport;
use notes_core::index::{HubRow, Links, TreeNode, ViewQuery, ViewRow};
use notes_core::workspace::device_id as device_hex;
use notes_core::identity::IdentityState;
use notes_core::members::Role;
use notes_core::{CoreError, Workspace};
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

pub struct AppState {
    pub root: PathBuf,
    pub key: SigningKey,
    pub account: Arc<Mutex<crate::account::Account>>,
    pub open: Arc<Mutex<HashMap<String, Workspace>>>,
    pub sync: Arc<crate::sync::SyncService>,
}

pub type CmdResult<T> = Result<T, String>;

pub fn own_identity(state: &AppState) -> CmdResult<IdentityState> {
    Ok(state.account.lock().map_err(|_| "account lock poisoned".to_string())?.state.clone())
}

/// Like `with_ws`, for changes: refused unless you can edit the workspace.
pub fn with_editable_ws<T>(
    state: &AppState,
    id: &str,
    f: impl FnOnce(&mut Workspace, &SigningKey) -> notes_core::Result<T>,
) -> CmdResult<T> {
    let own = own_identity(state)?;
    with_ws(state, id, |ws, key| {
        let role = ws.ensure_members(&own)?.role(&own.user);
        match role {
            Some(r) if r.can_edit() => f(ws, key),
            Some(Role::Viewer) => Err(CoreError::Invalid("You can view this workspace but not change it.".into())),
            Some(Role::Removed) => Err(CoreError::Invalid(
                "You were removed from this workspace, so it no longer accepts changes.".into(),
            )),
            _ => Err(CoreError::Invalid("You don't have access to change this workspace.".into())),
        }
    })
}

pub fn with_ws<T>(
    state: &AppState,
    id: &str,
    f: impl FnOnce(&mut Workspace, &SigningKey) -> notes_core::Result<T>,
) -> CmdResult<T> {
    let mut open = state.open.lock().map_err(|_| "workspace lock poisoned".to_string())?;
    if !open.contains_key(id) {
        let ws = Workspace::open(&state.root, id).map_err(|e| e.to_string())?;
        open.insert(id.to_string(), ws);
    }
    let ws = open.get_mut(id).expect("inserted above");
    f(ws, &state.key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_id(state: State<'_, AppState>) -> CmdResult<String> {
    Ok(device_hex(&state.key))
}

/// Turn the webview's spell checker on or off, with the languages to check
/// against ("en_US", "de_DE"; empty means the system's). On Linux, WebKitGTK
/// starts with it off and needs telling; the setting is shared by every
/// window, so each one applies it when it opens. macOS WebKit checks spelling
/// on its own, following the system settings, and ignores this.
#[tauri::command]
pub async fn set_spell_check(app: tauri::AppHandle, enabled: bool, languages: Vec<String>) -> CmdResult<()> {
    apply_spell_check(&app, enabled, &languages)
}

#[cfg(target_os = "linux")]
pub fn apply_spell_check(app: &tauri::AppHandle, enabled: bool, languages: &[String]) -> CmdResult<()> {
    use tauri::Manager;
    let languages: Vec<String> = languages.iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    for (_, w) in app.webview_windows() {
        let languages = languages.clone();
        w.with_webview(move |platform| {
            use webkit2gtk::{WebContextExt, WebViewExt};
            if let Some(ctx) = platform.inner().context() {
                ctx.set_spell_checking_enabled(enabled);
                if !languages.is_empty() {
                    let refs: Vec<&str> = languages.iter().map(String::as_str).collect();
                    ctx.set_spell_checking_languages(&refs);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn apply_spell_check(_app: &tauri::AppHandle, _enabled: bool, _languages: &[String]) -> CmdResult<()> {
    Ok(())
}

/// A workspace in the switcher, with your access to it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    pub id: String,
    pub name: String,
    /// Your role: owner, editor, viewer, or removed.
    pub role: Role,
    /// Shared with anyone besides its owner.
    pub shared: bool,
    pub owner_name: String,
}

pub fn workspace_item(ws: &mut Workspace, own: &IdentityState) -> notes_core::Result<WorkspaceItem> {
    let name = ws.name()?;
    let id = ws.id.clone();
    let m = ws.ensure_members(own)?;
    Ok(WorkspaceItem {
        id,
        name,
        role: m.role(&own.user).unwrap_or(Role::Removed),
        shared: m.is_shared(),
        owner_name: m.identities.get(&m.owner).map(|i| i.display_name()).unwrap_or_default(),
    })
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>) -> CmdResult<Vec<WorkspaceItem>> {
    let own = own_identity(&state)?;
    let list = notes_core::list_workspaces(&state.root).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for w in list {
        out.push(with_ws(&state, &w.id, |ws, _| workspace_item(ws, &own))?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn create_workspace(
    state: State<'_, AppState>,
    id: String,
    manifest: Vec<u8>,
) -> CmdResult<WorkspaceItem> {
    let own = own_identity(&state)?;
    let mut ws = Workspace::create(&state.root, &id, &manifest, &state.key).map_err(|e| e.to_string())?;
    let item = workspace_item(&mut ws, &own).map_err(|e| e.to_string())?;
    state.open.lock().map_err(|_| "workspace lock poisoned".to_string())?.insert(id, ws);
    state.sync.kick();
    Ok(item)
}

#[tauri::command]
pub async fn load_doc(
    state: State<'_, AppState>,
    workspace_id: String,
    doc_id: String,
) -> CmdResult<Response> {
    with_ws(&state, &workspace_id, |ws, _| ws.load_doc(&doc_id)).map(Response::new)
}

#[tauri::command]
pub async fn create_doc(
    state: State<'_, AppState>,
    workspace_id: String,
    doc_id: String,
    kind: String,
    bytes: Vec<u8>,
    action: String,
) -> CmdResult<()> {
    with_editable_ws(&state, &workspace_id, |ws, key| {
        ws.create_doc(key, &doc_id, &kind, &bytes, &action).map(|_| ())
    })?;
    state.sync.kick();
    Ok(())
}

/// Told to every window after a change made in one of them, so a popped-out
/// page and the main window stay in step. `from` is the window that made it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalApplied {
    pub workspace: String,
    pub doc: String,
    pub from: String,
}

#[tauri::command]
pub async fn apply_change(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    workspace_id: String,
    doc_id: String,
    change: Vec<u8>,
    action: String,
    subject: Option<String>,
) -> CmdResult<()> {
    let own = own_identity(&state)?;
    with_editable_ws(&state, &workspace_id, |ws, key| {
        if notes_core::members::owner_only(&action) && ws.ensure_members(&own)?.role(&own.user) != Some(Role::Owner) {
            return Err(CoreError::Invalid("Only the owner can rename a workspace.".into()));
        }
        ws.apply_change(key, &doc_id, change, &action, subject.as_deref()).map(|_| ())
    })?;
    state.sync.kick();
    use tauri::Emitter;
    let _ = app.emit(
        "local-applied",
        LocalApplied { workspace: workspace_id, doc: doc_id, from: window.label().to_string() },
    );
    Ok(())
}

#[tauri::command]
pub async fn get_tree(state: State<'_, AppState>, workspace_id: String) -> CmdResult<Vec<TreeNode>> {
    with_ws(&state, &workspace_id, |ws, _| ws.tree())
}

#[tauri::command]
pub async fn run_view(
    state: State<'_, AppState>,
    workspace_id: String,
    query: ViewQuery,
) -> CmdResult<Vec<ViewRow>> {
    with_ws(&state, &workspace_id, |ws, _| ws.query(&query))
}

#[tauri::command]
pub async fn notes_hub(state: State<'_, AppState>, workspace_id: String) -> CmdResult<Vec<HubRow>> {
    with_ws(&state, &workspace_id, |ws, _| ws.notes_hub())
}

#[tauri::command]
pub async fn links_of(state: State<'_, AppState>, workspace_id: String, id: String) -> CmdResult<Links> {
    with_ws(&state, &workspace_id, |ws, _| ws.links_of(&id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    seq: u64,
    ts: i64,
    action: String,
    target: String,
    target_title: Option<String>,
    device: String,
    /// The device's name from its certificate, if it's one of yours.
    device_name: Option<String>,
    this_device: bool,
    hash: String,
}

#[tauri::command]
pub async fn list_events(
    state: State<'_, AppState>,
    workspace_id: String,
    limit: u32,
    offset: u32,
) -> CmdResult<Vec<EventView>> {
    let me = device_hex(&state.key);
    let own = own_identity(&state)?;
    with_ws(&state, &workspace_id, |ws, _| {
        // Your devices by name; other people's as "Name (device)".
        let mut names: HashMap<String, String> = HashMap::new();
        if let Some(m) = ws.members() {
            for ids in m.identities.values().filter(|i| i.user != own.user) {
                let person = ids.display_name();
                for c in ids.certs.values() {
                    let label = if person.is_empty() { c.name.clone() } else { format!("{person} ({})", c.name) };
                    names.insert(c.device.clone(), label);
                }
            }
        }
        for c in own.certs.values() {
            names.insert(c.device.clone(), c.name.clone());
        }
        ws.events(limit.min(500), offset)?
            .into_iter()
            .map(|e| {
                // Current title if the item still exists, else the title logged with the event.
                let data = serde_json::from_str::<serde_json::Value>(&e.data).unwrap_or_default();
                let field = |k: &str| data.get(k).and_then(|v| v.as_str()).map(str::to_string);
                let logged = if e.action.starts_with("member.") || e.action.starts_with("invite.") {
                    // People and invites: "Alex (editor)", "Invite for Alex (viewer)".
                    let who = match e.action.starts_with("invite.") {
                        true => field("label").filter(|l| !l.is_empty()).map(|l| format!("Invite: {l}")).unwrap_or("Invite".into()),
                        false => field("name").filter(|n| !n.is_empty()).unwrap_or("Someone".into()),
                    };
                    Some(match field("role") {
                        Some(r) => format!("{who} ({r})"),
                        None => who,
                    })
                } else {
                    field("title")
                };
                Ok(EventView {
                    target_title: ws.title_of(&e.target)?.or(logged),
                    this_device: e.device == me,
                    device_name: names.get(&e.device).cloned(),
                    seq: e.seq,
                    ts: e.ts,
                    action: e.action,
                    target: e.target,
                    device: e.device,
                    hash: e.hash,
                })
            })
            .collect()
    })
}

#[tauri::command]
pub async fn verify_log(state: State<'_, AppState>, workspace_id: String) -> CmdResult<VerifyReport> {
    with_ws(&state, &workspace_id, |ws, _| ws.verify_log())
}

#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>) -> CmdResult<crate::sync::SyncStatus> {
    Ok(state.sync.status().await)
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> CmdResult<crate::sync::SyncStatus> {
    state.sync.sync_all().await;
    Ok(state.sync.status().await)
}

#[tauri::command]
pub async fn set_sync_settings(
    state: State<'_, AppState>,
    settings: crate::sync::Settings,
) -> CmdResult<crate::sync::SyncStatus> {
    state.sync.update_settings(settings).await?;
    Ok(state.sync.status().await)
}

/// Move a workspace to the trash, here and on your other devices.
#[tauri::command]
pub async fn delete_workspace(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let name = with_ws(&state, &id, |ws, _| ws.name())?;
    state.sync.ctx().delete_workspace(&id, &name)?;
    state.sync.kick();
    Ok(())
}

#[tauri::command]
pub async fn restore_workspace(state: State<'_, AppState>, id: String) -> CmdResult<WorkspaceItem> {
    state.sync.ctx().restore_workspace(&id)?;
    state.sync.kick();
    let own = own_identity(&state)?;
    with_ws(&state, &id, |ws, _| workspace_item(ws, &own))
}

/// Empty one workspace out of this device's trash.
#[tauri::command]
pub async fn purge_workspace(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.sync.ctx().purge_workspace(&id)
}

#[tauri::command]
pub async fn list_trash(state: State<'_, AppState>) -> CmdResult<Vec<notes_peer::removals::Trashed>> {
    Ok(state.sync.ctx().trash())
}

/// A folder linked from a task or project: is it a git checkout, and what
/// does it point at? Reads .git/config and .git/HEAD by hand; no git needed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub is_repo: bool,
    pub remote: Option<String>,
    pub branch: Option<String>,
}

#[tauri::command]
pub async fn git_info(path: String) -> CmdResult<GitInfo> {
    let dir = PathBuf::from(&path);
    let git = dir.join(".git");
    if !git.is_dir() {
        return Ok(GitInfo { is_repo: false, remote: None, branch: None });
    }
    let config = std::fs::read_to_string(git.join("config")).unwrap_or_default();
    let mut in_origin = false;
    let mut remote = None;
    for line in config.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_origin = l.eq_ignore_ascii_case("[remote \"origin\"]");
        } else if in_origin {
            if let Some(v) = l.strip_prefix("url") {
                if let Some(v) = v.trim_start().strip_prefix('=') {
                    remote = Some(v.trim().to_string());
                }
            }
        }
    }
    let branch = std::fs::read_to_string(git.join("HEAD"))
        .ok()
        .and_then(|h| h.trim().strip_prefix("ref: refs/heads/").map(str::to_string));
    Ok(GitInfo { is_repo: true, remote, branch })
}

#[tauri::command]
pub async fn path_exists(path: String) -> CmdResult<bool> {
    Ok(PathBuf::from(path).exists())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub branches: Vec<String>,
    pub source: &'static str,
    pub error: Option<String>,
}

/// Branches of a repository: a local checkout's `.git/refs/heads` and
/// `packed-refs` (no git needed), or a remote's via `git ls-remote --heads`,
/// which uses the user's own SSH keys and credential helper.
#[tauri::command]
pub async fn git_branches(path: Option<String>, url: Option<String>) -> CmdResult<GitBranches> {
    if let Some(path) = path {
        let git = PathBuf::from(&path).join(".git");
        let mut out = std::collections::BTreeSet::new();
        fn walk(dir: &std::path::Path, prefix: &str, out: &mut std::collections::BTreeSet<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let full = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
                if e.path().is_dir() {
                    walk(&e.path(), &full, out);
                } else {
                    out.insert(full);
                }
            }
        }
        walk(&git.join("refs").join("heads"), "", &mut out);
        if let Ok(packed) = std::fs::read_to_string(git.join("packed-refs")) {
            for line in packed.lines() {
                if let Some((_, r)) = line.split_once(" refs/heads/") {
                    out.insert(r.trim().to_string());
                }
            }
        }
        return Ok(GitBranches { branches: out.into_iter().collect(), source: "local", error: None });
    }
    let Some(url) = url else { return Err("path or url required".into()) };
    // The URL comes from the shared project doc, so any member wrote it. Only
    // plain web URLs run, never as an option, and git may not switch transports.
    let trimmed = url.trim().to_string();
    let web = trimmed.len() < 2048
        && (trimmed.starts_with("https://") || trimmed.starts_with("http://"))
        && !trimmed.chars().any(|c| c.is_control() || c.is_whitespace());
    if !web {
        return Ok(GitBranches {
            branches: Vec::new(),
            source: "remote",
            error: Some("Only http(s) repository URLs can be checked from here.".into()),
        });
    }
    let run = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("git")
            .args(["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.http.allow=always"])
            .args(["-c", "core.askPass=", "-c", "credential.helper="])
            .args(["ls-remote", "--heads", "--", &trimmed])
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
    })
    .await
    .map_err(|e| e.to_string())?;
    match run {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout);
            let branches = text
                .lines()
                .filter_map(|l| l.split_once("refs/heads/").map(|(_, b)| b.trim().to_string()))
                .collect();
            Ok(GitBranches { branches, source: "remote", error: None })
        }
        Ok(o) => Ok(GitBranches {
            branches: Vec::new(),
            source: "remote",
            error: Some(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        }),
        Err(e) => Ok(GitBranches { branches: Vec::new(), source: "remote", error: Some(format!("git not available: {e}")) }),
    }
}
