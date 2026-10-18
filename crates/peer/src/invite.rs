//! Invite links: `idear-share-2.<base64url>` holding just enough to reach the
//! owner and prove the invite: the owner's user key, the device that made
//! the link and its relay, the invite id, when it expires, and the one-time
//! secret (sealed under a passphrase when the owner asked for one). The
//! workspace's name, the role, and the owner's other devices come from the
//! owner at the first contact. About 150 characters; the old links carried
//! the owner's whole identity and ran to a couple of thousand.

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use notes_core::identity::{open_with_passphrase, seal_with_passphrase, IdentityState};
use notes_core::members::hash_secret;
use zeroize::Zeroizing;

use crate::sync::{JoinStatus, PendingJoin, Via};

pub const TOKEN_PREFIX: &str = "idear-share-2.";
const OLD_PREFIX: &str = "notes-share-1.";
const VERSION: u8 = 2;
const FLAG_SEALED: u8 = 1;

/// What an invite link holds.
#[derive(Debug)]
pub struct Link {
    /// The owner's user key, hex.
    pub user: String,
    /// The owner's device that made the link, hex: the first one to dial.
    pub device: String,
    /// That device's relay, if it has one.
    pub relay: Option<String>,
    pub invite_id: String,
    /// Milliseconds since the epoch.
    pub expires: i64,
    /// The 32-byte secret, or its sealed form (salt, nonce, ciphertext).
    secret: Vec<u8>,
    sealed: bool,
}

impl Link {
    /// A link with its secret in the clear: the link itself is the key.
    pub fn new(user: &str, device: &str, relay: Option<&str>, invite_id: &str, expires: i64, secret: &[u8; 32]) -> Self {
        Self {
            user: user.to_string(),
            device: device.to_string(),
            relay: relay.map(str::to_string),
            invite_id: invite_id.to_string(),
            expires,
            secret: secret.to_vec(),
            sealed: false,
        }
    }

    /// The same, with the secret sealed under `passphrase`: the link alone
    /// is then useless to whoever intercepts it.
    pub fn sealed(user: &str, device: &str, relay: Option<&str>, invite_id: &str, expires: i64, secret: &[u8; 32], passphrase: &str) -> Result<Self, String> {
        let mut l = Self::new(user, device, relay, invite_id, expires, secret);
        l.secret = seal_with_passphrase(secret, passphrase).map_err(|e| e.to_string())?;
        l.sealed = true;
        Ok(l)
    }

    pub fn needs_passphrase(&self) -> bool {
        self.sealed
    }

    /// The secret, opening it with the passphrase when it's sealed.
    pub fn secret(&self, passphrase: Option<&str>) -> Result<Zeroizing<Vec<u8>>, String> {
        if !self.sealed {
            return Ok(Zeroizing::new(self.secret.clone()));
        }
        let p = passphrase.map(str::trim).filter(|p| !p.is_empty()).ok_or("This invite needs its passphrase.")?;
        open_with_passphrase(&self.secret, p, "invite link").map_err(|e| e.to_string())
    }

    pub fn encode(&self) -> Result<String, String> {
        let user = hex::decode(&self.user).map_err(|_| "bad user key")?;
        let device = hex::decode(&self.device).map_err(|_| "bad device id")?;
        let invite = hex::decode(&self.invite_id).map_err(|_| "bad invite id")?;
        if user.len() != 32 || device.len() != 32 || invite.len() != 8 {
            return Err("bad key lengths".into());
        }
        let relay = self.relay.as_deref().unwrap_or("").as_bytes();
        if relay.len() > 255 {
            return Err("relay URL too long".into());
        }
        let mut out = Vec::with_capacity(2 + 32 + 32 + 8 + 8 + 1 + relay.len() + self.secret.len());
        out.push(VERSION);
        out.push(if self.sealed { FLAG_SEALED } else { 0 });
        out.extend_from_slice(&user);
        out.extend_from_slice(&device);
        out.extend_from_slice(&invite);
        out.extend_from_slice(&(self.expires / 1000).to_be_bytes());
        out.push(relay.len() as u8);
        out.extend_from_slice(relay);
        out.extend_from_slice(&self.secret);
        Ok(format!("{TOKEN_PREFIX}{}", B64.encode(out)))
    }

    pub fn decode(token: &str) -> Result<Self, String> {
        let damaged = || "That doesn't look like a complete invite link.".to_string();
        let t = token.trim();
        if t.starts_with(OLD_PREFIX) {
            return Err("That invite link was made by an older version of idear. Ask for a new one.".into());
        }
        let body = t.strip_prefix(TOKEN_PREFIX).ok_or_else(damaged)?;
        let raw: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        let bytes = B64.decode(raw).map_err(|_| damaged())?;
        if bytes.len() < 2 + 32 + 32 + 8 + 8 + 1 || bytes[0] != VERSION {
            return Err(damaged());
        }
        let sealed = bytes[1] & FLAG_SEALED != 0;
        let mut at = 2;
        let mut take = |n: usize| -> Result<&[u8], String> {
            let s = bytes.get(at..at + n).ok_or_else(damaged)?;
            at += n;
            Ok(s)
        };
        let user = hex::encode(take(32)?);
        let device = hex::encode(take(32)?);
        let invite_id = hex::encode(take(8)?);
        let expires = i64::from_be_bytes(take(8)?.try_into().map_err(|_| damaged())?) * 1000;
        let relay_len = take(1)?[0] as usize;
        let relay = String::from_utf8(take(relay_len)?.to_vec()).map_err(|_| damaged())?;
        let secret = bytes[at..].to_vec();
        if (!sealed && secret.len() != 32) || (sealed && secret.len() < 16 + 24 + 32 + 16) {
            return Err(damaged());
        }
        Ok(Self { user, device, relay: (!relay.is_empty()).then_some(relay), invite_id, expires, secret, sealed })
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Check an invite link and turn it into a join to redeem with the owner.
/// `own_user` is whoever is joining, so an invite to your own workspace is caught.
pub fn read_invite(token: &str, passphrase: Option<&str>, own_user: &str) -> Result<PendingJoin, String> {
    let link = Link::decode(token)?;
    if link.expires < now() {
        return Err("That invite has expired. Ask for a new one.".into());
    }
    if link.user == own_user {
        return Err("That's an invite to your own workspace.".into());
    }
    let secret = link.secret(passphrase)?;
    if secret.len() != 32 {
        return Err("That invite link is damaged.".into());
    }
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&hex::decode(&link.user).ok().and_then(|b| b.try_into().ok()).ok_or("That invite link is damaged.")?)
        .map_err(|_| "That invite link is damaged.".to_string())?;
    Ok(PendingJoin {
        workspace: String::new(),
        invite_id: link.invite_id.clone(),
        secret_hash: hash_secret(&secret),
        secret: hex::encode(secret.as_slice()),
        workspace_name: String::new(),
        // Just the user key until the owner answers with their identity.
        owner: IdentityState::new(&vk),
        via: Some(Via { device: link.device.clone(), relay: link.relay.clone() }),
        expires: link.expires,
        added: now(),
        last_attempt: None,
        last_error: None,
        status: JoinStatus::Trying,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_round_trip_and_stay_short() {
        let user = hex::encode([1u8; 32]);
        let device = hex::encode([2u8; 32]);
        let secret = [7u8; 32];
        let plain = Link::new(&user, &device, Some("https://relay.example/"), "0011223344556677", 1_800_000_000_000, &secret).encode().unwrap();
        assert!(plain.len() < 200, "{}", plain.len());
        let back = Link::decode(&plain).unwrap();
        assert_eq!((back.user.as_str(), back.device.as_str(), back.relay.as_deref(), back.invite_id.as_str(), back.expires), (user.as_str(), device.as_str(), Some("https://relay.example/"), "0011223344556677", 1_800_000_000_000));
        assert_eq!(back.secret(None).unwrap().as_slice(), &secret);

        let sealed = Link::sealed(&user, &device, None, "0011223344556677", 1_800_000_000_000, &secret, "ABCD-EFGH").unwrap().encode().unwrap();
        assert!(sealed.len() < 260, "{}", sealed.len());
        let back = Link::decode(&sealed).unwrap();
        assert!(back.needs_passphrase());
        assert!(back.secret(None).is_err());
        assert!(back.secret(Some("wrong")).is_err());
        assert_eq!(back.secret(Some("abcd-efgh")).unwrap().as_slice(), &secret);

        assert!(Link::decode("notes-share-1.abc").unwrap_err().contains("older version"));
        assert!(Link::decode("idear-share-2.abc").is_err());
    }
}
