//! Who this peer is: its user key (from the keychain) and its public identity
//! records (in `identity.json`).

use std::path::PathBuf;

use ed25519_dalek::SigningKey;
use notes_core::identity::{key_id, BoxKey, DeviceCert, IdentityState};

use crate::keychain::{self, Keychain};

pub struct Account {
    pub user: SigningKey,
    pub state: IdentityState,
    pub path: PathBuf,
}

impl Account {
    /// Load (or set up) the user identity and make sure this device is certified.
    pub fn open(path: PathBuf, device: &SigningKey, keys: Keychain, device_name: &str) -> Result<Self, String> {
        let user = keys.load_or_create(keychain::USER_KEY)?;
        Self::with_user(path, device, user, device_name)
    }

    /// Like `open`, with the user key already in hand.
    pub fn with_user(path: PathBuf, device: &SigningKey, user: SigningKey, device_name: &str) -> Result<Self, String> {
        let user_id = key_id(&user.verifying_key());
        let mut state = match IdentityState::load(&path).map_err(|e| e.to_string())? {
            Some(s) if s.user == user_id => s,
            Some(s) => {
                // The records on disk belong to a different user than the key
                // in the keychain. Starting over here would silently make this
                // device a stranger to every shared workspace, so stop instead.
                return Err(format!(
                    "The identity records in {} are for account {} but this device's keychain holds the key for {}. \
                     If the keychain was reset, restore it from a backup, or link this device to one of your others \
                     again after moving {} aside.",
                    path.display(),
                    short(&s.user),
                    short(&user_id),
                    path.display()
                ));
            }
            None => IdentityState::new(&user.verifying_key()),
        };
        let device_id = key_id(&device.verifying_key());
        if !state.certs.contains_key(&device_id) {
            let cert = DeviceCert::issue(&user, &device.verifying_key(), device_name).map_err(|e| e.to_string())?;
            state.certs.insert(device_id, cert);
        }
        ensure_box_key(&user, &mut state)?;
        let account = Self { user, state, path };
        account.save()?;
        Ok(account)
    }

    pub fn save(&self) -> Result<(), String> {
        self.state.save(&self.path).map_err(|e| e.to_string())
    }
}

/// Publish the key other people seal update files to.
pub fn ensure_box_key(user: &SigningKey, state: &mut IdentityState) -> Result<(), String> {
    let ok = state.box_key.as_ref().is_some_and(|b| b.user == state.user && b.is_valid());
    if !ok {
        state.box_key = Some(BoxKey::issue(user).map_err(|e| e.to_string())?);
    }
    Ok(())
}

fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}
