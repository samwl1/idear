//! Update files: carry workspaces to your other devices, or to someone you
//! share them with, without any network.

use std::path::PathBuf;

use notes_core::bundle;
use notes_core::WorkspaceImport;
use serde::Serialize;
use tauri::State;

use crate::commands::{AppState, CmdResult};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportView {
    workspaces: usize,
    bytes: u64,
}

/// `recipient` is a person's user ID, or None for your own devices.
#[tauri::command]
pub async fn export_update(
    state: State<'_, AppState>,
    path: String,
    workspace_ids: Vec<String>,
    recipient: Option<String>,
) -> CmdResult<ExportView> {
    if workspace_ids.is_empty() {
        return Err("Pick at least one workspace to export.".into());
    }
    let ctx = state.sync.ctx();
    let (b, to) = ctx.export_bundle(&workspace_ids, recipient.as_deref())?;
    let path = PathBuf::from(path);
    match to {
        Some(theirs) => bundle::write_for(&path, &theirs, &b),
        None => {
            let user = state.account.lock().map_err(|_| "account lock poisoned")?.user.clone();
            bundle::write(&path, &user, &b)
        }
    }
    .map_err(|e| e.to_string())?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportView { workspaces: workspace_ids.len(), bytes })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportView {
    workspaces: Vec<WorkspaceImport>,
    /// Devices this device hadn't heard of (or heard were removed) until now.
    identity_changed: bool,
    from_device: String,
    created: i64,
}

#[tauri::command]
pub async fn import_update(state: State<'_, AppState>, path: String) -> CmdResult<ImportView> {
    let user = state.account.lock().map_err(|_| "account lock poisoned")?.user.clone();
    let b = bundle::read(&PathBuf::from(path), &user).map_err(|e| e.to_string())?;
    let created = b.created;
    let r = state.sync.ctx().import_bundle(b)?;
    state.sync.kick();
    Ok(ImportView {
        workspaces: r.applied.reports,
        identity_changed: r.applied.identity_changed,
        from_device: r.from,
        created,
    })
}
