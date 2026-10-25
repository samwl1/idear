//! Who you are, across devices.
//!
//! - A **user key** (Ed25519) is you. Every one of your devices holds a copy.
//! - Each device has its own **device key**, which signs that device's events.
//! - The user key signs a **device certificate** for each device, binding the
//!   device key to you. A **revocation** signed by the user key retires one.
//!
//! Records are self-verifying, so the identity state can travel over any
//! channel (update files, network sync) and is merged by keeping every valid
//! record: the newest certificate per device, and any revocation, which wins.
//!
//! Linking a device hands it a copy of the user key inside an **invite**: an
//! encrypted code opened with a passphrase that's shown on screen and never
//! written into the code itself.

use std::collections::BTreeMap;
use std::path::Path;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{CoreError, Result};
use crate::now_ms;

pub fn key_id(key: &VerifyingKey) -> String {
    hex::encode(key.to_bytes())
}

fn verifying_key(hex_str: &str) -> Result<VerifyingKey> {
    let bytes: [u8; 32] = hex::decode(hex_str)
        .map_err(|_| CoreError::Invalid("key encoding".into()))?
        .try_into()
        .map_err(|_| CoreError::Invalid("key length".into()))?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| CoreError::Invalid("not a valid public key".into()))
}

/// Sign `fields` with a domain label so a signature for one record type can
/// never be replayed as another.
fn sign(key: &SigningKey, domain: &str, fields: &impl Serialize) -> Result<String> {
    Ok(hex::encode(key.sign(&signed_bytes(domain, fields)?).to_bytes()))
}

fn verify(user: &str, domain: &str, fields: &impl Serialize, sig: &str) -> bool {
    let Ok(vk) = verifying_key(user) else { return false };
    let Ok(bytes) = hex::decode(sig) else { return false };
    let Ok(arr) = <[u8; 64]>::try_from(bytes.as_slice()) else { return false };
    let Ok(msg) = signed_bytes(domain, fields) else { return false };
    vk.verify(&msg, &Signature::from_bytes(&arr)).is_ok()
}

fn signed_bytes(domain: &str, fields: &impl Serialize) -> Result<Vec<u8>> {
    let mut out = format!("notes-app/{domain}/v1\0").into_bytes();
    out.extend(serde_json::to_vec(fields)?);
    Ok(out)
}

// ---- records --------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCert {
    pub user: String,
    pub device: String,
    pub name: String,
    pub issued: i64,
    pub sig: String,
}

#[derive(Serialize)]
struct CertFields<'a> {
    user: &'a str,
    device: &'a str,
    name: &'a str,
    issued: i64,
}

impl DeviceCert {
    pub fn issue(user: &SigningKey, device: &VerifyingKey, name: &str) -> Result<Self> {
        let (user_id, device_id, issued) = (key_id(&user.verifying_key()), key_id(device), now_ms());
        let sig = sign(user, "device-cert", &CertFields { user: &user_id, device: &device_id, name, issued })?;
        Ok(Self { user: user_id, device: device_id, name: name.to_string(), issued, sig })
    }

    /// The same, for a device known only by its id (re-certifying a folded
    /// account's devices under the account that took it over).
    pub fn issue_by_id(user: &SigningKey, device: &str, name: &str) -> Result<Self> {
        Self::issue(user, &verifying_key(device)?, name)
    }

    pub fn is_valid(&self) -> bool {
        let f = CertFields { user: &self.user, device: &self.device, name: &self.name, issued: self.issued };
        verify(&self.user, "device-cert", &f, &self.sig)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    pub user: String,
    pub device: String,
    pub revoked: i64,
    pub sig: String,
}

#[derive(Serialize)]
struct RevokeFields<'a> {
    user: &'a str,
    device: &'a str,
    revoked: i64,
}

impl Revocation {
    pub fn issue(user: &SigningKey, device: &str) -> Result<Self> {
        let (user_id, revoked) = (key_id(&user.verifying_key()), now_ms());
        let sig = sign(user, "revocation", &RevokeFields { user: &user_id, device, revoked })?;
        Ok(Self { user: user_id, device: device.to_string(), revoked, sig })
    }

    pub fn is_valid(&self) -> bool {
        let f = RevokeFields { user: &self.user, device: &self.device, revoked: self.revoked };
        verify(&self.user, "revocation", &f, &self.sig)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameRecord {
    pub user: String,
    pub name: String,
    pub set: i64,
    pub sig: String,
}

#[derive(Serialize)]
struct NameFields<'a> {
    user: &'a str,
    name: &'a str,
    set: i64,
}

impl NameRecord {
    pub fn issue(user: &SigningKey, name: &str) -> Result<Self> {
        let (user_id, set) = (key_id(&user.verifying_key()), now_ms());
        let sig = sign(user, "user-name", &NameFields { user: &user_id, name, set })?;
        Ok(Self { user: user_id, name: name.to_string(), set, sig })
    }

    pub fn is_valid(&self) -> bool {
        verify(&self.user, "user-name", &NameFields { user: &self.user, name: &self.name, set: self.set }, &self.sig)
    }
}

/// Where a device can currently be reached, signed by that device's own key.
/// Devices dial each other with these, so no lookup service is needed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddrRecord {
    pub device: String,
    pub relay: Option<String>,
    pub addrs: Vec<String>,
    pub updated: i64,
    pub sig: String,
}

#[derive(Serialize)]
struct AddrFields<'a> {
    device: &'a str,
    relay: Option<&'a str>,
    addrs: &'a [String],
    updated: i64,
}

impl AddrRecord {
    pub fn issue(device: &SigningKey, relay: Option<String>, addrs: Vec<String>) -> Result<Self> {
        let (id, updated) = (key_id(&device.verifying_key()), now_ms());
        let f = AddrFields { device: &id, relay: relay.as_deref(), addrs: &addrs, updated };
        let sig = sign(device, "device-addr", &f)?;
        Ok(Self { device: id, relay, addrs, updated, sig })
    }

    pub fn is_valid(&self) -> bool {
        let f = AddrFields { device: &self.device, relay: self.relay.as_deref(), addrs: &self.addrs, updated: self.updated };
        // Signed by the device itself, not the user key.
        verify(&self.device, "device-addr", &f, &self.sig)
    }

    /// Same place as another record, ignoring when it was signed.
    pub fn same_place(&self, relay: &Option<String>, addrs: &[String]) -> bool {
        &self.relay == relay && self.addrs == addrs
    }
}

/// A user's X25519 public key for receiving encrypted update files. The
/// secret half is derived from the user key, so every linked device has it
/// without syncing anything secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxKey {
    pub user: String,
    pub key: String,
    pub sig: String,
}

#[derive(Serialize)]
struct BoxKeyFields<'a> {
    user: &'a str,
    key: &'a str,
}

/// The secret half of a user's box key.
pub fn box_secret(user: &SigningKey) -> x25519_dalek::StaticSecret {
    let seed = Zeroizing::new(user.to_bytes());
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, seed.as_ref());
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(b"notes-app/box-key/v1", out.as_mut()).expect("32 bytes is a valid HKDF length");
    x25519_dalek::StaticSecret::from(*out)
}

impl BoxKey {
    pub fn issue(user: &SigningKey) -> Result<Self> {
        let public = x25519_dalek::PublicKey::from(&box_secret(user));
        let (user_id, key) = (key_id(&user.verifying_key()), hex::encode(public.as_bytes()));
        let sig = sign(user, "box-key", &BoxKeyFields { user: &user_id, key: &key })?;
        Ok(Self { user: user_id, key, sig })
    }

    pub fn is_valid(&self) -> bool {
        verify(&self.user, "box-key", &BoxKeyFields { user: &self.user, key: &self.key }, &self.sig)
    }

    pub fn public(&self) -> Option<x25519_dalek::PublicKey> {
        let bytes: [u8; 32] = hex::decode(&self.key).ok()?.try_into().ok()?;
        Some(x25519_dalek::PublicKey::from(bytes))
    }
}

// ---- state ----------------------------------------------------------------------

/// One account folding into another, signed by both: `from` agrees to be
/// succeeded, `to` agrees to take over. Everything `from` was (owner of a
/// workspace, editor in another) is read as `to` from then on. `to`
/// re-certifies `from`'s devices as its own, so every change they ever
/// signed stays valid, while `from`'s own key stops counting for new
/// devices: whoever still holds it can't add a device to the account with
/// it. An account folds into another once; later claims are ignored.
/// Linking two devices that each have history makes one of these; either
/// device can be the one that joins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Succession {
    pub from: String,
    pub to: String,
    pub at: i64,
    pub from_sig: String,
    pub to_sig: String,
}

#[derive(Serialize)]
struct SuccessionFields<'a> {
    from: &'a str,
    to: &'a str,
    at: i64,
}

impl Succession {
    pub fn issue(from: &SigningKey, to: &SigningKey) -> Result<Self> {
        let (from_id, to_id, at) = (key_id(&from.verifying_key()), key_id(&to.verifying_key()), now_ms());
        if from_id == to_id {
            return Err(CoreError::Invalid("an account can't succeed itself".into()));
        }
        let fields = SuccessionFields { from: &from_id, to: &to_id, at };
        Ok(Self {
            from: from_id.clone(),
            to: to_id.clone(),
            at,
            from_sig: sign(from, "succession", &fields)?,
            to_sig: sign(to, "succession", &fields)?,
        })
    }

    pub fn is_valid(&self) -> bool {
        let f = SuccessionFields { from: &self.from, to: &self.to, at: self.at };
        self.from != self.to && verify(&self.from, "succession", &f, &self.from_sig) && verify(&self.to, "succession", &f, &self.to_sig)
    }
}

/// Everything public about one user: their name and devices.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityState {
    pub user: String,
    pub name: Option<NameRecord>,
    /// Newest certificate per device.
    pub certs: BTreeMap<String, DeviceCert>,
    pub revocations: BTreeMap<String, Revocation>,
    /// Newest known address per device.
    #[serde(default)]
    pub addresses: BTreeMap<String, AddrRecord>,
    /// For receiving update files from other people.
    #[serde(default)]
    pub box_key: Option<BoxKey>,
    /// Accounts that were folded into this one, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub predecessors: Vec<Succession>,
    /// Accounts this one was folded into, learned from their devices. A device
    /// still signing as this account should link to one of those.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub successors: Vec<Succession>,
}

impl IdentityState {
    pub fn new(user: &VerifyingKey) -> Self {
        Self { user: key_id(user), ..Default::default() }
    }

    pub fn load(path: &Path) -> Result<Option<Self>> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let mut state: Self = serde_json::from_slice(&bytes)?;
                state.drop_invalid();
                Ok(Some(state))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Remove anything not validly signed by this user.
    fn drop_invalid(&mut self) {
        let user = self.user.clone();
        if self.name.as_ref().is_some_and(|n| n.user != user || !n.is_valid()) {
            self.name = None;
        }
        self.certs.retain(|id, c| c.user == user && &c.device == id && c.is_valid());
        self.revocations.retain(|id, r| r.user == user && &r.device == id && r.is_valid());
        self.addresses.retain(|id, a| &a.device == id && a.is_valid());
        if self.box_key.as_ref().is_some_and(|b| b.user != user || !b.is_valid()) {
            self.box_key = None;
        }
        self.predecessors.retain(|p| p.to == user && p.is_valid());
        self.predecessors.sort_by_key(|p| p.at);
        self.predecessors.dedup_by(|a, b| a.from == b.from);
        self.successors.retain(|p| p.from == user && p.is_valid());
        self.successors.sort_by_key(|p| p.at);
        self.successors.dedup_by(|a, b| a.to == b.to);
    }

    /// Note that another account (with `theirs` records) took this one over.
    /// Returns whether that was news.
    pub fn learn_successor(&mut self, theirs: &IdentityState) -> bool {
        let mut changed = false;
        for p in &theirs.predecessors {
            if p.from == self.user && p.is_valid() && !self.successors.iter().any(|s| s.to == p.to) {
                self.successors.push(p.clone());
                changed = true;
            }
        }
        changed
    }

    /// The accounts this one stands for: itself and every predecessor.
    pub fn is_or_succeeds(&self, user: &str) -> bool {
        self.user == user || self.predecessors.iter().any(|p| p.from == user)
    }

    /// The same records with anything not validly signed removed.
    pub fn validated(mut self) -> Self {
        self.drop_invalid();
        self
    }

    /// Fold in records from another copy of the same user's state. Returns
    /// whether anything changed. Records for a different user are ignored.
    pub fn merge(&mut self, other: &IdentityState) -> bool {
        if other.user != self.user {
            return false;
        }
        let before = self.clone();
        if let Some(n) = &other.name {
            if n.user == self.user && n.is_valid() && self.name.as_ref().is_none_or(|cur| n.set > cur.set) {
                self.name = Some(n.clone());
            }
        }
        for (id, c) in &other.certs {
            if c.user == self.user && &c.device == id && c.is_valid()
                && self.certs.get(id).is_none_or(|cur| c.issued > cur.issued)
            {
                self.certs.insert(id.clone(), c.clone());
            }
        }
        for (id, r) in &other.revocations {
            if r.user == self.user && &r.device == id && r.is_valid() && !self.revocations.contains_key(id) {
                self.revocations.insert(id.clone(), r.clone());
            }
        }
        if let Some(b) = &other.box_key {
            if self.box_key.is_none() && b.user == self.user && b.is_valid() {
                self.box_key = Some(b.clone());
            }
        }
        for (id, a) in &other.addresses {
            if &a.device == id && a.is_valid() && self.addresses.get(id).is_none_or(|cur| a.updated > cur.updated) {
                self.addresses.insert(id.clone(), a.clone());
            }
        }
        for p in &other.predecessors {
            if p.to == self.user && p.is_valid() && !self.predecessors.iter().any(|cur| cur.from == p.from) {
                self.predecessors.push(p.clone());
            }
        }
        self.predecessors.sort_by_key(|p| p.at);
        for p in &other.successors {
            if p.from == self.user && p.is_valid() && !self.successors.iter().any(|cur| cur.to == p.to) {
                self.successors.push(p.clone());
            }
        }
        *self != before
    }

    /// A device that may connect and sync now: certified and not removed.
    pub fn is_trusted(&self, device: &str) -> bool {
        self.certs.contains_key(device) && !self.revocations.contains_key(device)
    }

    /// Whether an event a device signed at `ts` counts. A removed device's
    /// events from before its removal still do, so history it already wrote
    /// stays valid for devices that receive it later.
    pub fn trusted_at(&self, device: &str, ts: i64) -> bool {
        self.certs.contains_key(device) && self.revocations.get(device).is_none_or(|r| ts <= r.revoked)
    }

    pub fn display_name(&self) -> String {
        self.name.as_ref().map(|n| n.name.clone()).unwrap_or_default()
    }
}

// ---- invites --------------------------------------------------------------------

const INVITE_PREFIX: &str = "notes-invite-1.";

/// What a new device receives when it joins.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePayload {
    pub user_secret: String,
    pub state: IdentityState,
    pub issued_by: String,
    pub expires: i64,
}

impl Drop for InvitePayload {
    fn drop(&mut self) {
        self.user_secret.zeroize();
    }
}

impl InvitePayload {
    pub fn user_key(&self) -> Result<SigningKey> {
        let mut bytes = Zeroizing::new(
            hex::decode(&self.user_secret).map_err(|_| CoreError::Invalid("invite key encoding".into()))?,
        );
        let seed: [u8; 32] = bytes.as_slice().try_into().map_err(|_| CoreError::Invalid("invite key length".into()))?;
        bytes.zeroize();
        let key = SigningKey::from_bytes(&seed);
        if key_id(&key.verifying_key()) != self.state.user {
            return Err(CoreError::Invalid("invite key doesn't match its identity".into()));
        }
        Ok(key)
    }
}

/// A random passphrase: 16 characters in groups of four, about 80 bits.
pub fn new_passphrase() -> Result<String> {
    // Crockford base32 without I, L, O, U: nothing to misread.
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| CoreError::Invalid(e.to_string()))?;
    let chars: Vec<char> = bytes.iter().map(|b| ALPHABET[(*b as usize) % 32] as char).collect();
    bytes.zeroize();
    Ok(chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-"))
}

fn normalize_passphrase(p: &str) -> String {
    p.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(64 * 1024, 3, 1, Some(32)).map_err(|e| CoreError::Invalid(e.to_string()))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(normalize_passphrase(passphrase).as_bytes(), salt, key.as_mut())
        .map_err(|e| CoreError::Invalid(e.to_string()))?;
    Ok(key)
}

/// Seal `plain` under a passphrase: Argon2id key, XChaCha20-Poly1305.
/// Output is salt (16) + nonce (24) + ciphertext.
pub fn seal_with_passphrase(plain: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut salt).map_err(|e| CoreError::Invalid(e.to_string()))?;
    getrandom::getrandom(&mut nonce).map_err(|e| CoreError::Invalid(e.to_string()))?;
    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let sealed = cipher
        .encrypt(XNonce::from_slice(&nonce), plain)
        .map_err(|_| CoreError::Invalid("encryption failed".into()))?;
    let mut out = Vec::with_capacity(16 + 24 + sealed.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// The inverse of `seal_with_passphrase`. `what` names the thing for the error.
pub fn open_with_passphrase(bytes: &[u8], passphrase: &str, what: &str) -> Result<Zeroizing<Vec<u8>>> {
    if bytes.len() < 16 + 24 + 16 {
        return Err(CoreError::Invalid(format!("The {what} is damaged or incomplete.")));
    }
    let (salt, rest) = bytes.split_at(16);
    let (nonce, sealed) = rest.split_at(24);
    let key = derive_key(passphrase, salt)?;
    Ok(Zeroizing::new(
        XChaCha20Poly1305::new(key.as_ref().into())
            .decrypt(XNonce::from_slice(nonce), sealed)
            .map_err(|_| CoreError::Invalid(format!("Wrong passphrase, or the {what} was changed.")))?,
    ))
}

/// Seal an invite. The code is safe to send over anything; the passphrase
/// must travel separately (read it off one screen, type it on the other).
pub fn create_invite(
    user: &SigningKey,
    state: &IdentityState,
    issued_by: &str,
    passphrase: &str,
    valid_for_ms: i64,
) -> Result<String> {
    let payload = InvitePayload {
        user_secret: hex::encode(user.to_bytes()),
        state: state.clone(),
        issued_by: issued_by.to_string(),
        expires: now_ms() + valid_for_ms,
    };
    let plain = Zeroizing::new(serde_json::to_vec(&payload)?);
    Ok(format!("{INVITE_PREFIX}{}", B64.encode(seal_with_passphrase(&plain, passphrase)?)))
}

pub fn open_invite(code: &str, passphrase: &str) -> Result<InvitePayload> {
    let body = code.trim().strip_prefix(INVITE_PREFIX).ok_or_else(|| {
        CoreError::Invalid("That isn't a device link code. It should start with \"notes-invite-1.\"".into())
    })?;
    let raw: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = B64.decode(raw).map_err(|_| CoreError::Invalid("The link code is damaged or incomplete.".into()))?;
    let plain = open_with_passphrase(&bytes, passphrase, "link code")?;
    let mut payload: InvitePayload = serde_json::from_slice(&plain)?;
    if payload.expires < now_ms() {
        return Err(CoreError::Invalid("This link code has expired. Create a new one on your other device.".into()));
    }
    payload.state.drop_invalid();
    payload.user_key()?;
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    #[test]
    fn certs_merge_and_revocation_wins() {
        let user = key(1);
        let (a, b) = (key(2), key(3));
        let mut s = IdentityState::new(&user.verifying_key());
        s.certs.insert(key_id(&a.verifying_key()), DeviceCert::issue(&user, &a.verifying_key(), "Mac").unwrap());

        let mut other = s.clone();
        let b_id = key_id(&b.verifying_key());
        other.certs.insert(b_id.clone(), DeviceCert::issue(&user, &b.verifying_key(), "Linux").unwrap());
        assert!(s.merge(&other));
        assert!(s.is_trusted(&b_id));
        assert!(!s.merge(&other), "merging the same records twice changes nothing");

        let mut revoked = s.clone();
        revoked.revocations.insert(b_id.clone(), Revocation::issue(&user, &b_id).unwrap());
        s.merge(&revoked);
        assert!(!s.is_trusted(&b_id));

        // Its events from before removal still count; later ones don't.
        let when = s.revocations[&b_id].revoked;
        assert!(s.trusted_at(&b_id, when - 1));
        assert!(!s.trusted_at(&b_id, when + 1));

        // A newer cert for the revoked device doesn't bring it back.
        let mut again = s.clone();
        again.certs.insert(b_id.clone(), DeviceCert::issue(&user, &b.verifying_key(), "Linux 2").unwrap());
        s.merge(&again);
        assert!(!s.is_trusted(&b_id));
    }

    #[test]
    fn forged_records_are_ignored() {
        let user = key(1);
        let attacker = key(9);
        let mut s = IdentityState::new(&user.verifying_key());
        let mut forged = s.clone();
        let evil = key_id(&key(5).verifying_key());
        // Signed by the wrong key, then relabelled as the real user.
        let mut cert = DeviceCert::issue(&attacker, &key(5).verifying_key(), "Evil").unwrap();
        cert.user = s.user.clone();
        forged.certs.insert(evil.clone(), cert);
        assert!(!s.merge(&forged));
        assert!(!s.is_trusted(&evil));

        // A real cert with its name edited no longer verifies.
        let mut tampered = DeviceCert::issue(&user, &key(5).verifying_key(), "Mac").unwrap();
        tampered.name = "Renamed".into();
        assert!(!tampered.is_valid());
    }

    #[test]
    fn address_records_are_signed_by_their_device() {
        let user = key(1);
        let dev = key(2);
        let mut s = IdentityState::new(&user.verifying_key());
        let mut other = s.clone();
        let rec = AddrRecord::issue(&dev, Some("https://relay.example./".into()), vec!["10.0.0.2:4433".into()]).unwrap();
        other.addresses.insert(rec.device.clone(), rec.clone());
        assert!(s.merge(&other));

        // Someone else can't publish an address for this device.
        let mut forged = AddrRecord::issue(&key(9), None, vec!["6.6.6.6:1".into()]).unwrap();
        forged.device = rec.device.clone();
        let mut evil = s.clone();
        forged.updated = rec.updated + 1;
        evil.addresses.insert(rec.device.clone(), forged);
        assert!(!s.merge(&evil));
        assert_eq!(s.addresses[&rec.device].addrs, vec!["10.0.0.2:4433".to_string()]);
    }

    #[test]
    fn invite_round_trip() {
        let user = key(1);
        let mut s = IdentityState::new(&user.verifying_key());
        s.name = Some(NameRecord::issue(&user, "Sam").unwrap());
        let pass = new_passphrase().unwrap();
        let code = create_invite(&user, &s, "dev", &pass, 600_000).unwrap();
        assert!(!code.contains(&hex::encode(user.to_bytes())), "the key must not be readable in the code");

        // Typed lowercase, without dashes: still opens.
        let typed = pass.replace('-', "").to_lowercase();
        let got = open_invite(&code, &typed).unwrap();
        assert_eq!(got.user_key().unwrap().to_bytes(), user.to_bytes());
        assert_eq!(got.state.display_name(), "Sam");

        assert!(open_invite(&code, "AAAA-AAAA-AAAA-AAAA").is_err());
        let mut damaged = code.clone();
        damaged.pop();
        damaged.push(if code.ends_with('A') { 'B' } else { 'A' });
        assert!(open_invite(&damaged, &pass).is_err());

        let expired = create_invite(&user, &s, "dev", &pass, -1).unwrap();
        assert!(open_invite(&expired, &pass).is_err());
    }
}
