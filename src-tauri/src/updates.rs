//! Update files: carry workspaces to your other devices, or to someone you
//! share them with, without any network.

use std::path::PathBuf;

use notes_core::bundle;
use notes_core::WorkspaceImport;
use serde::Serialize;
use tauri::State;

use crate::commands::{AppState, CmdResult};

/// The largest update file that gets read into memory. Live sync has its own
/// per-message limit; files had none.
const IMPORT_LIMIT: u64 = 512 * 1024 * 1024;

/// File extensions update files are written and read under (the dialog's filter).
const EXTENSIONS: &[&str] = &["idear", "scramble", "notesupdate"];

/// An update-file path the frontend chose: it has to look like one (the
/// extension the save dialog offers) and lie outside the app's own data,
/// so a webview talked into calling these can't read or overwrite anything
/// else on disk.
fn update_path(state: &AppState, path: &str) -> CmdResult<PathBuf> {
    let p = PathBuf::from(path);
    let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    if !p.is_absolute() || !ext.is_some_and(|e| EXTENSIONS.contains(&e.as_str())) {
        return Err("Update files end in .idear.".into());
    }
    let root = state.root.canonicalize().unwrap_or_else(|_| state.root.clone());
    let parent = p.parent().and_then(|d| d.canonicalize().ok()).unwrap_or_else(|| p.clone());
    if parent.starts_with(&root) {
        return Err("Update files can't be kept inside the app's own data folder.".into());
    }
    Ok(p)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportView {
    workspaces: usize,
    bytes: u64,
    /// Set when the file was sealed under a generated passphrase.
    passphrase: Option<String>,
}

/// `recipient` is a person's user ID, or None for your own devices.
/// `passphrase`: seal under a generated passphrase instead of to a key, so a
/// device that isn't yours (or isn't known yet) can open it with the phrase.
/// Such a file for a person holds only what you share with them, as usual;
/// one for your own devices holds everything, so keep the phrase close.
#[tauri::command]
pub async fn export_update(
    state: State<'_, AppState>,
    path: String,
    workspace_ids: Vec<String>,
    recipient: Option<String>,
    passphrase: Option<bool>,
) -> CmdResult<ExportView> {
    if workspace_ids.is_empty() {
        return Err("Pick at least one workspace to export.".into());
    }
    let ctx = state.sync.ctx();
    let (b, to) = match ctx.export_bundle(&workspace_ids, recipient.as_deref()) {
        Ok(x) => x,
        // The recipient's key isn't known yet: a passphrase file doesn't need it.
        Err(e) if passphrase == Some(true) && recipient.is_some() && e.contains("doesn't know") => {
            let (b, _) = ctx.export_bundle_unsealed(&workspace_ids, recipient.as_deref())?;
            (b, None)
        }
        Err(e) => return Err(e),
    };
    let path = update_path(&state, &path)?;
    let user = state.account.lock().map_err(|_| "account lock poisoned")?.user.clone();
    let mut phrase = None;
    if passphrase == Some(true) {
        let p = notes_core::identity::new_passphrase().map_err(|e| e.to_string())?;
        bundle::write_with(&path, &user, &b, &p).map_err(|e| e.to_string())?;
        phrase = Some(p);
    } else {
        match to {
            Some(theirs) => bundle::write_for(&path, &theirs, &b),
            None => bundle::write(&path, &user, &b),
        }
        .map_err(|e| e.to_string())?;
    }
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(ExportView { workspaces: workspace_ids.len(), bytes, passphrase: phrase })
}

/// Whether an update file needs a passphrase to open.
#[tauri::command]
pub async fn inspect_update(state: State<'_, AppState>, path: String) -> CmdResult<bool> {
    let path = update_path(&state, &path)?;
    let mut head = [0u8; 16];
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    use std::io::Read;
    let n = f.read(&mut head).map_err(|e| e.to_string())?;
    Ok(bundle::needs_passphrase(&head[..n]))
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
pub async fn import_update(state: State<'_, AppState>, path: String, passphrase: Option<String>) -> CmdResult<ImportView> {
    let user = state.account.lock().map_err(|_| "account lock poisoned")?.user.clone();
    let path = update_path(&state, &path)?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > IMPORT_LIMIT {
        return Err(format!(
            "That update file is {} MB; the most this app opens is {} MB.",
            size / (1024 * 1024),
            IMPORT_LIMIT / (1024 * 1024)
        ));
    }
    let b = bundle::read(&path, &user, passphrase.as_deref()).map_err(|e| e.to_string())?;
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
