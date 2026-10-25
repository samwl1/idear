//! Identity, keys, and live sync, shared by the desktop app and the headless
//! Claude peer (`idear-mcp`).

pub mod account;
pub mod invite;
pub mod inbox;
pub mod keychain;
pub mod removals;
pub mod sync;

use std::path::Path;

/// Create a data folder (and its `workspaces`) readable by this user alone.
/// It holds identity records, pending invite secrets, and every workspace in
/// the clear, and the platform's data directory isn't always private (on
/// Linux `~/.local/share` is often world-readable). An existing folder is
/// tightened the same way. Does nothing about modes on Windows.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("workspaces"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for d in [dir, &dir.join("workspaces")] {
            let mut perms = std::fs::metadata(d)?.permissions();
            if perms.mode() & 0o077 != 0 {
                perms.set_mode(0o700);
                std::fs::set_permissions(d, perms)?;
            }
        }
    }
    Ok(())
}

/// Whether a data folder holds any workspaces.
fn has_workspaces(dir: &Path) -> bool {
    std::fs::read_dir(dir.join("workspaces")).is_ok_and(|mut d| d.next().is_some())
}

/// Carry a data folder over from one of the app's earlier names. Runs
/// before anything opens either folder. If the new folder already exists but
/// has no workspaces (a first launch made it), the old one replaces it; once
/// the new one has workspaces, the old one is left alone.
pub fn migrate_dir(old: &Path, new: &Path) -> std::io::Result<bool> {
    if !old.exists() || has_workspaces(new) {
        return Ok(false);
    }
    if new.exists() {
        std::fs::remove_dir_all(new)?;
    }
    std::fs::rename(old, new)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::migrate_dir;

    #[test]
    fn migrates_once() {
        let t = tempfile::tempdir().unwrap();
        let (old, new) = (t.path().join("old"), t.path().join("new"));
        std::fs::create_dir_all(old.join("workspaces/w1")).unwrap();
        std::fs::create_dir_all(new.join("workspaces")).unwrap(); // an empty first launch
        assert!(migrate_dir(&old, &new).unwrap());
        assert!(new.join("workspaces/w1").exists() && !old.exists());
        std::fs::create_dir_all(old.join("workspaces/w2")).unwrap();
        assert!(!migrate_dir(&old, &new).unwrap(), "never replaces a folder with workspaces");
        assert!(old.exists());
    }
}
