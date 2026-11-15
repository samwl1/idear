//! Handing workspaces to Claude on the same computer.
//!
//! When you give Claude access to a workspace in the app, the app makes an
//! invite and drops it in Claude's inbox (`inbox/<workspace>.json` in Claude's
//! data folder). Claude's peer picks it up the next time it runs, redeems it
//! over live sync like anyone else would, and deletes the file.

use std::path::{Path, PathBuf};

use notes_core::members::{InviteView, Members, Role};
use serde::{Deserialize, Serialize};

/// The label the app puts on every invite it makes for Claude.
pub const CLAUDE_LABEL: &str = "Claude";

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

/// Every invite in a workspace that is still open and was made for Claude:
/// labelled for it, named by the letter in its inbox, or already picked up
/// by its peer (`picked_up`: the invite ids in Claude's pending joins).
/// Claude's peer deletes the letter as soon as it reads it, so the letter
/// alone doesn't say what is still outstanding. Newest first.
pub fn claude_invites(m: &Members, letter: Option<&Letter>, picked_up: &[String], now: i64) -> Vec<InviteView> {
    m.invites_view(now)
        .into_iter()
        .filter(|i| i.status == "open")
        .filter(|i| i.label == CLAUDE_LABEL || letter.is_some_and(|l| l.invite == i.id) || picked_up.contains(&i.id))
        .collect()
}

/// The role Claude is waiting to be given: that of the newest open invite
/// it can still redeem (in its inbox, or picked up and not finished).
pub fn waiting_role(m: &Members, letter: Option<&Letter>, picked_up: &[String], now: i64) -> Option<Role> {
    claude_invites(m, letter, picked_up, now)
        .into_iter()
        .find(|i| letter.is_some_and(|l| l.invite == i.id) || picked_up.contains(&i.id))
        .map(|i| i.role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use notes_core::identity::IdentityState;

    const HOUR: i64 = 60 * 60 * 1000;

    fn now() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
    }

    /// Claude's peer deletes the letter when it picks the invite up. The
    /// invite is still open then, and still Claude's to cancel.
    #[test]
    fn invites_for_claude_are_found_after_the_letter_is_gone() {
        let owner = SigningKey::from_bytes(&[1; 32]);
        let mut m = Members::new("w", &IdentityState::new(&owner.verifying_key()));
        m.create_invite(&owner, "forclaude", Role::Editor, CLAUDE_LABEL, HOUR, false).unwrap();
        m.create_invite(&owner, "foralex", Role::Viewer, "Alex", HOUR, false).unwrap();
        let ids = |m: &Members, letter: Option<&Letter>, picked: &[String]| {
            claude_invites(m, letter, picked, now()).into_iter().map(|i| i.id).collect::<Vec<_>>()
        };
        let letter = Letter { token: String::new(), invite: "forclaude".into() };
        let picked = vec!["forclaude".to_string()];

        // In the inbox: found, and Claude waits as an editor.
        assert_eq!(ids(&m, Some(&letter), &[]), vec!["forclaude"]);
        assert_eq!(waiting_role(&m, Some(&letter), &[], now()), Some(Role::Editor));
        // Picked up, letter deleted: still found, and still an editor.
        assert_eq!(ids(&m, None, &picked), vec!["forclaude"]);
        assert_eq!(waiting_role(&m, None, &picked, now()), Some(Role::Editor));
        // Neither (Claude's folder was cleared): the label still finds it
        // to cancel, but Claude can't redeem it, so nothing is waiting.
        assert_eq!(ids(&m, None, &[]), vec!["forclaude"]);
        assert_eq!(waiting_role(&m, None, &[], now()), None);

        // Cancelled: nothing left, even while Claude's peer keeps retrying it.
        m.cancel_invite(&owner, "forclaude").unwrap();
        assert!(ids(&m, None, &picked).is_empty());
        assert_eq!(waiting_role(&m, None, &picked, now()), None);
        // Other people's invites were never touched.
        assert!(m.invites_view(now()).iter().any(|i| i.id == "foralex" && i.status == "open"));
    }
}
