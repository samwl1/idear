//! Invite links: `notes-share-1.<base64url JSON>` holding the owner-signed
//! invite record, its one-time secret, the workspace name, and the owner's
//! public identity (so the joiner can find and check the owner's devices).

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use notes_core::identity::IdentityState;
use notes_core::members::{hash_secret, InviteRecord};
use serde::{Deserialize, Serialize};

use crate::sync::PendingJoin;

pub const TOKEN_PREFIX: &str = "notes-share-1.";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub invite: InviteRecord,
    /// Hex of the 32-byte secret.
    pub secret: String,
    pub workspace_name: String,
    pub owner: IdentityState,
}

impl Token {
    pub fn encode(&self) -> Result<String, String> {
        let json = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        Ok(format!("{TOKEN_PREFIX}{}", B64.encode(json)))
    }

    pub fn decode(token: &str) -> Result<Self, String> {
        let damaged = || "That doesn't look like a complete invite link.".to_string();
        let body = token.trim().strip_prefix(TOKEN_PREFIX).ok_or_else(damaged)?;
        let json = B64.decode(body.trim()).map_err(|_| damaged())?;
        serde_json::from_slice(&json).map_err(|_| damaged())
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
pub fn read_invite(token: &str, own_user: &str) -> Result<PendingJoin, String> {
    let t = Token::decode(token)?;
    let owner = t.owner.clone().validated();
    let invite = &t.invite;
    if !invite.is_valid(&invite.workspace, &owner.user) {
        return Err("That invite isn't signed by the person it claims to be from.".into());
    }
    let secret = hex::decode(&t.secret).map_err(|_| "That invite link is damaged.".to_string())?;
    if hash_secret(&secret) != invite.secret_hash {
        return Err("That invite link is damaged.".into());
    }
    if invite.expires < now() {
        return Err("That invite has expired. Ask for a new one.".into());
    }
    if owner.certs.keys().all(|d| !owner.is_trusted(d)) {
        return Err("That invite doesn't say how to reach its owner.".into());
    }
    if owner.user == own_user {
        return Err("That's an invite to your own workspace.".into());
    }
    Ok(PendingJoin {
        invite: t.invite,
        secret: t.secret,
        workspace_name: t.workspace_name,
        owner,
        added: now(),
        last_attempt: None,
        last_error: None,
    })
}
