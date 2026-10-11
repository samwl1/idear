//! Claude's peer: its own identity and devices, its own copy of the
//! workspaces it was invited to, and live sync with the people who invited it.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use notes_core::identity::{key_id, IdentityState, NameRecord};
use notes_core::members::Role;
use notes_core::Workspace;
use notes_peer::account::Account;
use notes_peer::keychain::{self, CLAUDE};
use notes_peer::sync::{Joins, SyncCtx, SyncService};

use crate::docs::{err, Res};

/// Reads sync first when the last sync is older than this.
const FRESH_FOR: Duration = Duration::from_secs(20);
/// How long a read waits for that sync before answering with what's here.
const FRESH_WAIT: Duration = Duration::from_secs(8);

/// `IDEAR_CLAUDE_DIR` if set (the earlier `SCRAMBLE_CLAUDE_DIR` and
/// `NOTES_CLAUDE_DIR` also work), else the user data folder.
fn dir_override() -> Option<std::ffi::OsString> {
    ["IDEAR_CLAUDE_DIR", "SCRAMBLE_CLAUDE_DIR", "NOTES_CLAUDE_DIR"].iter().find_map(std::env::var_os)
}

pub fn data_dir() -> PathBuf {
    if let Some(d) = dir_override() {
        return PathBuf::from(d);
    }
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = notes_peer::inbox::claude_dir().unwrap_or_else(|| base.join("dev.sam.idear-claude"));
    // Carry over Claude's data from the app's earlier names.
    for old in ["dev.sam.scramble-claude", "dev.sam.notes-claude"] {
        if let Err(e) = notes_peer::migrate_dir(&base.join(old), &dir) {
            eprintln!("idear mcp: couldn't move data from {old}: {e}");
        }
    }
    dir
}

pub struct Peer {
    pub ctx: SyncCtx,
    pub service: Arc<SyncService>,
    last_sync: Mutex<Option<Instant>>,
    dir: PathBuf,
    /// Held for the process's lifetime: one Claude peer per data folder.
    _lock: File,
}

impl Peer {
    pub fn open(dir: &Path) -> Res<Self> {
        // Each data folder is its own Claude, with its own keys: two copies
        // must never sign as the same device, or their histories would fork.
        let suffix = match dir_override() {
            Some(_) => {
                let digest = Sha256::digest(dir.to_string_lossy().as_bytes());
                format!(":{}", &hex::encode(digest)[..16])
            }
            None => String::new(),
        };
        let device = CLAUDE.load_or_create(&format!("{}{suffix}", keychain::DEVICE_KEY))?;
        let user = CLAUDE.load_or_create(&format!("{}{suffix}", keychain::USER_KEY))?;
        Self::with_keys(dir, device, user)
    }

    /// Open with keys from somewhere other than the keychain (tests).
    pub fn with_keys(dir: &Path, device: SigningKey, user: SigningKey) -> Res<Self> {
        std::fs::create_dir_all(dir.join("workspaces")).map_err(err)?;
        let lock = File::create(dir.join("lock")).map_err(err)?;
        if lock.try_lock().is_err() {
            return Err(format!(
                "Another copy of Claude's idear connection is already using {}. Only one can run at a time; close the other first.",
                dir.display()
            ));
        }
        let host = keychain::default_device_name();
        let mut account = Account::with_user(dir.join("identity.json"), &device, user, &host)?;
        if account.state.name.is_none() {
            account.state.name = Some(NameRecord::issue(&account.user, "Claude").map_err(err)?);
            account.save()?;
        }
        let ctx = SyncCtx {
            root: dir.join("workspaces"),
            device,
            account: Arc::new(Mutex::new(account)),
            open: Arc::new(Mutex::new(HashMap::new())),
            joins: Arc::new(Joins::load(dir.join("joins.json"))),
        };
        let service = SyncService::new(ctx.clone(), dir.join("sync.json"), Arc::new(|_| {}));
        Ok(Self { ctx, service, last_sync: Mutex::new(None), dir: dir.to_path_buf(), _lock: lock })
    }

    pub fn own(&self) -> Res<IdentityState> {
        Ok(self.ctx.account.lock().map_err(|_| "account lock poisoned")?.state.clone())
    }

    /// Pick up workspaces given to Claude in the app on this computer: each
    /// is an invite left in the inbox. Returns how many were new.
    pub fn take_inbox(&self) -> usize {
        let Ok(own) = self.own() else { return 0 };
        let mut n = 0;
        for (path, token) in notes_peer::inbox::read(&self.dir) {
            match notes_peer::invite::read_invite(&token, &own.user) {
                Ok(pending) => {
                    self.service.joins().add(pending);
                    n += 1;
                }
                Err(e) => eprintln!("idear mcp: skipped an invite from the app: {e}"),
            }
            let _ = std::fs::remove_file(path);
        }
        n
    }

    pub fn device_id(&self) -> String {
        key_id(&self.ctx.device.verifying_key())
    }

    /// Sync now if it's been a while, so reads see recent changes. Gives up
    /// waiting after a few seconds and answers from what's already here.
    pub async fn fresh(&self) {
        if self.take_inbox() > 0 {
            *self.last_sync.lock().expect("lock") = None;
        }
        let stale = self.last_sync.lock().map(|l| l.is_none_or(|t| t.elapsed() > FRESH_FOR)).unwrap_or(true);
        if stale {
            let _ = tokio::time::timeout(FRESH_WAIT, self.service.sync_all()).await;
            if let Ok(mut l) = self.last_sync.lock() {
                *l = Some(Instant::now());
            }
        }
    }

    /// Run `f` on an open workspace.
    pub fn with_ws<T>(&self, id: &str, f: impl FnOnce(&mut Workspace) -> Res<T>) -> Res<T> {
        let mut open = self.ctx.open.lock().map_err(|_| "workspace lock poisoned")?;
        if !open.contains_key(id) {
            let ws = Workspace::open(&self.ctx.root, id).map_err(|_| format!("No workspace with id {id}."))?;
            open.insert(id.to_string(), ws);
        }
        f(open.get_mut(id).expect("opened"))
    }

    /// Claude's role in a workspace.
    pub fn role(&self, ws: &Workspace) -> Res<Role> {
        let own = self.own()?;
        Ok(ws.members().and_then(|m| m.role(&own.user)).unwrap_or(Role::Removed))
    }

    /// Refuse writes unless Claude is an editor here.
    pub fn require_edit(&self, ws: &Workspace) -> Res<()> {
        match self.role(ws)? {
            Role::Owner | Role::Editor => Ok(()),
            Role::Viewer => Err(
                "Claude is a viewer in this workspace, so it can read but not change it. The owner can make Claude \
                 an editor in Settings, Claude."
                    .into(),
            ),
            Role::Removed => Err("Claude was removed from this workspace.".into()),
        }
    }

    /// Workspaces here: (id, name, role, owner name).
    pub fn workspaces(&self) -> Res<Vec<(String, String, Role, String)>> {
        let mut out = Vec::new();
        for w in notes_core::list_workspaces(&self.ctx.root).map_err(err)? {
            let (role, owner) = self.with_ws(&w.id, |ws| {
                let owner = ws
                    .members()
                    .and_then(|m| m.identities.get(&m.owner).map(|i| i.display_name()))
                    .unwrap_or_default();
                Ok((self.role(ws)?, owner))
            })?;
            out.push((w.id, w.name, role, owner));
        }
        Ok(out)
    }

    /// A workspace by id or name (case-insensitive), with access.
    pub fn resolve_workspace(&self, which: &str) -> Res<String> {
        let all = self.workspaces()?;
        let w = which.trim();
        let found = all
            .iter()
            .find(|x| x.0 == w)
            .or_else(|| {
                let named: Vec<_> = all.iter().filter(|x| x.1.trim().eq_ignore_ascii_case(w)).collect();
                if named.len() == 1 { Some(named[0]) } else { None }
            })
            .ok_or_else(|| {
                let names: Vec<_> = all.iter().filter(|x| x.2.has_access()).map(|x| format!("\"{}\"", x.1)).collect();
                if names.is_empty() {
                    "Claude hasn't been invited to any workspaces yet.".to_string()
                } else {
                    format!("No workspace called \"{w}\". Claude has: {}.", names.join(", "))
                }
            })?;
        if !found.2.has_access() {
            return Err(format!("Claude was removed from \"{}\".", found.1));
        }
        Ok(found.0.clone())
    }
}
