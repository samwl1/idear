//! Deleting workspaces, and keeping your devices agreed on it.
//!
//! Deleting moves a workspace's folder to `trash/` beside `workspaces/` and
//! records a tombstone in `removed.json`. Tombstones travel between your own
//! devices in each sync (last change wins), so a workspace deleted on one
//! device is moved to the trash on the others instead of syncing back.
//! Restoring is the same record with `deleted: false` and a newer time.
//!
//! Other people's copies are theirs: deleting a shared workspace removes it
//! from your devices only.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::sync::SyncCtx;

type Res<T> = Result<T, String>;

/// Trash older than this is cleared on startup.
pub const KEEP_TRASH_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub deleted: bool,
    /// When this was decided, in ms. The latest decision wins.
    pub at: i64,
    /// The workspace's name when it was deleted, for the trash list.
    #[serde(default)]
    pub name: String,
}

pub type Removals = BTreeMap<String, Removal>;

/// One file per data folder; sync and commands both touch it.
static FILE: Mutex<()> = Mutex::new(());

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn data_dir(root: &Path) -> &Path {
    root.parent().unwrap_or(root)
}

fn file(root: &Path) -> PathBuf {
    data_dir(root).join("removed.json")
}

pub fn trash_dir(root: &Path) -> PathBuf {
    data_dir(root).join("trash")
}

pub fn load(root: &Path) -> Removals {
    std::fs::read(file(root)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save(root: &Path, r: &Removals) -> Res<()> {
    let tmp = file(root).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(r).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file(root)).map_err(|e| e.to_string())
}

fn move_dir(from: &Path, to: &Path) -> Res<()> {
    if let Some(p) = to.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    if to.exists() {
        std::fs::remove_dir_all(to).map_err(|e| e.to_string())?;
    }
    std::fs::rename(from, to).map_err(|e| format!("Couldn't move {}: {e}", from.display()))
}

/// A deleted workspace, for the trash list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trashed {
    pub id: String,
    pub name: String,
    pub deleted_at: i64,
    /// Still in this device's trash, so it can be restored here.
    pub restorable: bool,
}

impl SyncCtx {
    fn forget_open(&self, id: &str) -> Res<()> {
        self.open.lock().map_err(|_| "workspace lock poisoned")?.remove(id);
        Ok(())
    }

    /// Move a workspace to the trash on this device, and on your other
    /// devices at their next sync.
    pub fn delete_workspace(&self, id: &str, name: &str) -> Res<()> {
        let _f = FILE.lock().map_err(|_| "removals lock poisoned")?;
        let dir = self.root.join(id);
        if !dir.exists() {
            return Err("That workspace isn't on this device.".into());
        }
        self.forget_open(id)?;
        move_dir(&dir, &trash_dir(&self.root).join(id))?;
        let mut r = load(&self.root);
        r.insert(id.into(), Removal { deleted: true, at: now(), name: name.into() });
        save(&self.root, &r)?;
        self.joins.remove(id);
        Ok(())
    }

    /// Bring a workspace back from the trash.
    pub fn restore_workspace(&self, id: &str) -> Res<()> {
        let _f = FILE.lock().map_err(|_| "removals lock poisoned")?;
        let from = trash_dir(&self.root).join(id);
        let to = self.root.join(id);
        if !from.exists() {
            return Err("That workspace is no longer in the trash on this device.".into());
        }
        if to.exists() {
            return Err("That workspace is already here.".into());
        }
        move_dir(&from, &to)?;
        let mut r = load(&self.root);
        let name = r.get(id).map(|x| x.name.clone()).unwrap_or_default();
        r.insert(id.into(), Removal { deleted: false, at: now(), name });
        save(&self.root, &r)
    }

    /// Empty one workspace out of the trash. The tombstone stays, so your
    /// other devices still drop their copies.
    pub fn purge_workspace(&self, id: &str) -> Res<()> {
        let _f = FILE.lock().map_err(|_| "removals lock poisoned")?;
        let dir = trash_dir(&self.root).join(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Clear trash older than `KEEP_TRASH_MS`.
    pub fn purge_old_trash(&self) {
        let cutoff = now() - KEEP_TRASH_MS;
        let old: Vec<String> = load(&self.root)
            .into_iter()
            .filter(|(_, r)| r.deleted && r.at < cutoff)
            .map(|(id, _)| id)
            .collect();
        for id in old {
            let _ = self.purge_workspace(&id);
        }
    }

    /// Deleted workspaces, newest first.
    pub fn trash(&self) -> Vec<Trashed> {
        let dir = trash_dir(&self.root);
        let mut out: Vec<Trashed> = load(&self.root)
            .into_iter()
            .filter(|(_, r)| r.deleted)
            .map(|(id, r)| Trashed { restorable: dir.join(&id).exists(), id, name: r.name, deleted_at: r.at })
            .collect();
        out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        out
    }

    pub(crate) fn removals(&self) -> Removals {
        load(&self.root)
    }

    /// The workspace is here again (joined anew): drop any tombstone, so your
    /// other devices take it too.
    pub(crate) fn mark_present(&self, id: &str) -> Res<()> {
        let _f = FILE.lock().map_err(|_| "removals lock poisoned")?;
        let mut r = load(&self.root);
        if r.get(id).is_some_and(|x| x.deleted) {
            let name = r[id].name.clone();
            r.insert(id.into(), Removal { deleted: false, at: now(), name });
            save(&self.root, &r)?;
        }
        Ok(())
    }

    /// Fold in another of your devices' decisions. Returns the workspaces
    /// this moved to the trash and the ones it brought back.
    pub(crate) fn merge_removals(&self, theirs: &Removals) -> Res<(Vec<String>, Vec<String>)> {
        if theirs.is_empty() {
            return Ok((vec![], vec![]));
        }
        let _f = FILE.lock().map_err(|_| "removals lock poisoned")?;
        let mut ours = load(&self.root);
        let (mut deleted, mut restored) = (vec![], vec![]);
        let mut changed = false;
        for (id, r) in theirs {
            // Ids are folder names: never follow anything that could leave the data folder.
            if id.is_empty() || id.contains(['/', '\\', '.']) {
                continue;
            }
            if ours.get(id).is_some_and(|o| o.at >= r.at) {
                continue;
            }
            ours.insert(id.clone(), r.clone());
            changed = true;
            let (live, trashed) = (self.root.join(id), trash_dir(&self.root).join(id));
            if r.deleted && live.exists() {
                self.forget_open(id)?;
                move_dir(&live, &trashed)?;
                self.joins.remove(id);
                deleted.push(id.clone());
            } else if !r.deleted && trashed.exists() && !live.exists() {
                move_dir(&trashed, &live)?;
                restored.push(id.clone());
            }
        }
        if changed {
            save(&self.root, &ours)?;
        }
        Ok((deleted, restored))
    }
}
