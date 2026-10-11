//! Keys live in the OS keychain (macOS Keychain, Linux Secret Service) and are
//! never written to disk:
//! - the device key, unique to this machine, signs this device's events;
//! - the user key, shared by all your linked devices, certifies them.
//!
//! The app and the Claude peer use different keychain services, so they're
//! different identities even on the same machine.

use ed25519_dalek::SigningKey;
use zeroize::Zeroize;

/// The desktop app's keychain service.
pub const APP: Keychain = Keychain { service: "notes-app" };
/// The Claude peer's (`idear-mcp`).
pub const CLAUDE: Keychain = Keychain { service: "notes-app-claude" };

pub const DEVICE_KEY: &str = "device-signing-key";
pub const USER_KEY: &str = "user-signing-key";

#[derive(Clone, Copy, Debug)]
pub struct Keychain {
    pub service: &'static str,
}

fn keychain_error(e: keyring::Error) -> String {
    format!(
        "Couldn't use the system keychain: {e}. \
         On Linux, make sure GNOME Keyring or KWallet is running and unlocked."
    )
}

impl Keychain {
    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(self.service, account).map_err(|e| e.to_string())
    }

    /// Load a key, or None if this keychain has never stored one.
    pub fn load(&self, account: &str) -> Result<Option<SigningKey>, String> {
        match self.entry(account)?.get_password() {
            Ok(mut encoded) => {
                let decoded = hex::decode(&encoded);
                encoded.zeroize();
                let mut bytes = decoded.map_err(|_| format!("Stored {account} is corrupt."))?;
                let seed: Result<[u8; 32], _> = bytes.as_slice().try_into();
                bytes.zeroize();
                let mut seed = seed.map_err(|_| format!("Stored {account} has the wrong length."))?;
                let key = SigningKey::from_bytes(&seed);
                seed.zeroize();
                Ok(Some(key))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(e)),
        }
    }

    /// Store (or replace) a key.
    pub fn store(&self, account: &str, key: &SigningKey) -> Result<(), String> {
        let mut encoded = hex::encode(key.to_bytes());
        let result = self.entry(account)?.set_password(&encoded);
        encoded.zeroize();
        result.map_err(keychain_error)
    }

    pub fn load_or_create(&self, account: &str) -> Result<SigningKey, String> {
        if let Some(key) = self.load(account)? {
            return Ok(key);
        }
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).map_err(|e| e.to_string())?;
        let key = SigningKey::from_bytes(&seed);
        seed.zeroize();
        self.store(account, &key)?;
        Ok(key)
    }
}

/// A readable default name for this machine, e.g. "Sams-MacBook-Pro".
pub fn default_device_name() -> String {
    let host = gethostname::gethostname().to_string_lossy().to_string();
    let host = host.trim_end_matches(".local").trim();
    if host.is_empty() { "This device".to_string() } else { host.to_string() }
}
