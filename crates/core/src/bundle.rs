//! Update files: one or more workspaces, sealed so only your linked devices
//! can open them. Carry one over USB, a phone, or a cloud drive and import it
//! on another device.
//!
//! File layout:
//! ```text
//! "NOTESUPD" | version (1 byte) | user id (32 bytes) | nonce (24 bytes) | ciphertext
//! ```
//! The ciphertext is XChaCha20-Poly1305 under a key derived (HKDF-SHA256) from
//! the user key; the header is authenticated as associated data. Inside is
//! JSON: the identity records, and per workspace every doc and every event.
//!
//! Encryption keeps the file private in transit. It isn't what decides whether
//! content is accepted: every event is signature-checked against a trusted
//! device, and every Automerge change must be vouched for by such an event.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
use automerge::ReadDoc;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};
use crate::eventlog::Event;
use crate::identity::{key_id, IdentityState};

const MAGIC: &[u8; 8] = b"NOTESUPD";
/// Sealed for your own devices with a key derived from your user key.
const VERSION_OWN: u8 = 1;
/// Sealed for another person with their box key (X25519, ephemeral sender key).
const VERSION_TO: u8 = 2;
const HEADER_LEN: usize = 8 + 1 + 32;
const HEADER_TO_LEN: usize = HEADER_LEN + 32;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocBundle {
    pub id: String,
    pub kind: String,
    /// Base64 of the whole Automerge doc. Empty when `changes` is used.
    #[serde(default)]
    pub data: String,
    /// Just the changes the receiver is missing, each base64. Used by live sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBundle {
    pub id: String,
    pub name: String,
    pub docs: Vec<DocBundle>,
    pub events: Vec<Event>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub created_by: String,
    pub created: i64,
    /// The sender's public identity records.
    pub identity: IdentityState,
    pub workspaces: Vec<WorkspaceBundle>,
    /// Membership of each workspace in the file, by workspace id.
    #[serde(default)]
    pub members: std::collections::BTreeMap<String, crate::members::Members>,
}

impl DocBundle {
    pub fn new(id: &str, kind: &str, bytes: &[u8]) -> Self {
        Self { id: id.to_string(), kind: kind.to_string(), data: B64.encode(bytes), changes: None }
    }

    pub fn from_changes(id: &str, kind: &str, changes: &[automerge::Change]) -> Self {
        let encoded = changes.iter().map(|c| B64.encode(c.raw_bytes())).collect();
        Self { id: id.to_string(), kind: kind.to_string(), data: String::new(), changes: Some(encoded) }
    }

    /// The incoming changes, whichever form they came in, relative to `local`.
    pub fn changes_missing_from(&self, local: Option<&automerge::Automerge>) -> Result<Vec<automerge::Change>> {
        let empty = automerge::Automerge::new();
        let local = local.unwrap_or(&empty);
        match &self.changes {
            Some(list) => {
                let mut out = Vec::with_capacity(list.len());
                for c in list {
                    let bytes = B64.decode(c).map_err(|_| CoreError::Invalid(format!("doc {} is damaged", self.id)))?;
                    let change = automerge::Change::from_bytes(bytes)
                        .map_err(|_| CoreError::Invalid(format!("doc {} has a damaged change", self.id)))?;
                    if local.get_change_by_hash(&change.hash()).is_none() {
                        out.push(change);
                    }
                }
                Ok(out)
            }
            None => Ok(local.get_changes_added(&automerge::Automerge::load(&self.bytes()?)?)),
        }
    }

    pub fn bytes(&self) -> Result<Vec<u8>> {
        B64.decode(&self.data).map_err(|_| CoreError::Invalid(format!("doc {} is damaged", self.id)))
    }
}

fn file_key(user: &SigningKey) -> Zeroizing<[u8; 32]> {
    let secret = Zeroizing::new(user.to_bytes());
    let hk = Hkdf::<Sha256>::new(None, secret.as_ref());
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(b"notes-app/update-file/v1", key.as_mut()).expect("32 bytes is a valid HKDF length");
    key
}

pub fn seal(user: &SigningKey, bundle: &Bundle) -> Result<Vec<u8>> {
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.push(VERSION_OWN);
    header.extend_from_slice(&user.verifying_key().to_bytes());
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| CoreError::Invalid(e.to_string()))?;
    let plain = Zeroizing::new(serde_json::to_vec(bundle)?);
    let key = file_key(user);
    let sealed = XChaCha20Poly1305::new(key.as_ref().into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: &header })
        .map_err(|_| CoreError::Invalid("encryption failed".into()))?;
    let mut out = header;
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// The symmetric key for a file sent to someone, from an X25519 exchange.
fn to_key(shared: &x25519_dalek::SharedSecret, ephemeral: &[u8; 32], recipient_box: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(ephemeral);
    salt[32..].copy_from_slice(recipient_box);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(b"notes-app/update-file-to/v1", key.as_mut()).expect("32 bytes is a valid HKDF length");
    key
}

/// Seal a bundle for another person, so only their devices can open it.
pub fn seal_for(recipient: &IdentityState, bundle: &Bundle) -> Result<Vec<u8>> {
    let box_key = recipient
        .box_key
        .as_ref()
        .filter(|b| b.user == recipient.user && b.is_valid())
        .and_then(|b| b.public())
        .ok_or_else(|| {
            CoreError::Invalid(format!(
                "{} needs to sync with you once before you can send them update files.",
                if recipient.display_name().is_empty() { "That person".to_string() } else { recipient.display_name() }
            ))
        })?;
    let user: [u8; 32] =
        hex::decode(&recipient.user).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| CoreError::Invalid("bad user id".into()))?;
    let ephemeral = x25519_dalek::EphemeralSecret::random_from_rng(rand_core::OsRng);
    let ephemeral_pub = x25519_dalek::PublicKey::from(&ephemeral);
    let shared = ephemeral.diffie_hellman(&box_key);
    let key = to_key(&shared, ephemeral_pub.as_bytes(), box_key.as_bytes());

    let mut header = Vec::with_capacity(HEADER_TO_LEN);
    header.extend_from_slice(MAGIC);
    header.push(VERSION_TO);
    header.extend_from_slice(&user);
    header.extend_from_slice(ephemeral_pub.as_bytes());
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| CoreError::Invalid(e.to_string()))?;
    let plain = Zeroizing::new(serde_json::to_vec(bundle)?);
    let sealed = XChaCha20Poly1305::new(key.as_ref().into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: &header })
        .map_err(|_| CoreError::Invalid("encryption failed".into()))?;
    let mut out = header;
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn open_to(user: &SigningKey, bytes: &[u8]) -> Result<Bundle> {
    if bytes.len() < HEADER_TO_LEN + 24 + 16 {
        return Err(CoreError::Invalid("That isn't an update file.".into()));
    }
    let header = &bytes[..HEADER_TO_LEN];
    if header[9..HEADER_LEN] != user.verifying_key().to_bytes() {
        return Err(CoreError::Invalid("This update file was made for someone else.".into()));
    }
    let ephemeral: [u8; 32] = header[HEADER_LEN..HEADER_TO_LEN].try_into().expect("32 bytes");
    let secret = crate::identity::box_secret(user);
    let own_box = x25519_dalek::PublicKey::from(&secret);
    let shared = secret.diffie_hellman(&x25519_dalek::PublicKey::from(ephemeral));
    let key = to_key(&shared, &ephemeral, own_box.as_bytes());
    let nonce = &bytes[HEADER_TO_LEN..HEADER_TO_LEN + 24];
    let sealed = &bytes[HEADER_TO_LEN + 24..];
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(key.as_ref().into())
            .decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad: header })
            .map_err(|_| CoreError::Invalid("The update file is damaged or was changed.".into()))?,
    );
    Ok(serde_json::from_slice(&plain)?)
}

/// Open a file sealed for your devices (by one of them) or for you (by someone else).
pub fn open(user: &SigningKey, bytes: &[u8]) -> Result<Bundle> {
    if bytes.len() < HEADER_LEN + 24 + 16 || &bytes[..8] != MAGIC {
        return Err(CoreError::Invalid("That isn't an update file.".into()));
    }
    match bytes[8] {
        VERSION_OWN => {}
        VERSION_TO => return open_to(user, bytes),
        _ => return Err(CoreError::Invalid("This update file needs a newer version of the app.".into())),
    }
    let header = &bytes[..HEADER_LEN];
    if header[9..HEADER_LEN] != user.verifying_key().to_bytes() {
        return Err(CoreError::Invalid(
            "This update file was made by another account. Add this device to that account first (Settings → Devices → Add this device to an account).".into(),
        ));
    }
    let nonce = &bytes[HEADER_LEN..HEADER_LEN + 24];
    let sealed = &bytes[HEADER_LEN + 24..];
    let key = file_key(user);
    let plain = Zeroizing::new(
        XChaCha20Poly1305::new(key.as_ref().into())
            .decrypt(XNonce::from_slice(nonce), Payload { msg: sealed, aad: header })
            .map_err(|_| CoreError::Invalid("The update file is damaged or was changed.".into()))?,
    );
    let bundle: Bundle = serde_json::from_slice(&plain)?;
    if bundle.identity.user != key_id(&user.verifying_key()) {
        return Err(CoreError::Invalid("The update file's identity records don't match its header.".into()));
    }
    Ok(bundle)
}

pub fn write(path: &Path, user: &SigningKey, bundle: &Bundle) -> Result<()> {
    write_bytes(path, &seal(user, bundle)?)
}

pub fn write_for(path: &Path, recipient: &IdentityState, bundle: &Bundle) -> Result<()> {
    write_bytes(path, &seal_for(recipient, bundle)?)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("partial");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read(path: &Path, user: &SigningKey) -> Result<Bundle> {
    open(user, &std::fs::read(path)?)
}
