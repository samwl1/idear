//! Handing workspaces to Claude on the same computer.
//!
//! When you give Claude access to a workspace in the app, the app makes an
//! invite and drops it in Claude's inbox (`inbox/<workspace>.json` in Claude's
//! data folder). Claude's peer picks it up the next time it runs, redeems it
//! over live sync like anyone else would, and deletes the file.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Claude's data folder on this computer (without any override Claude may
/// have been started with).
pub fn claude_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("dev.sam.idear-claude"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Letter {
    /// The invite link.
    pub token: String,
    /// The invite's id, so the app can cancel it.
    pub invite: String,
}

fn path(dir: &Path, workspace: &str) -> PathBuf {
    dir.join("inbox").join(format!("{workspace}.json"))
}

pub fn put(dir: &Path, workspace: &str, letter: &Letter) -> Result<(), String> {
    let p = path(dir, workspace);
    std::fs::create_dir_all(p.parent().expect("has parent")).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(letter).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// The letter waiting for a workspace, if Claude hasn't picked it up yet.
pub fn get(dir: &Path, workspace: &str) -> Option<Letter> {
    std::fs::read(path(dir, workspace)).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn remove(dir: &Path, workspace: &str) {
    let _ = std::fs::remove_file(path(dir, workspace));
}

/// Every waiting letter, as (file, invite link).
pub fn read(dir: &Path) -> Vec<(PathBuf, String)> {
    let Ok(entries) = std::fs::read_dir(dir.join("inbox")) else { return vec![] };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| {
            let letter: Letter = serde_json::from_slice(&std::fs::read(&p).ok()?).ok()?;
            Some((p, letter.token))
        })
        .collect()
}
