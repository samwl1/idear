//! Who can do what in a workspace.
//!
//! Every workspace has one **owner**: the user who created it. Only the owner
//! (any of their devices, since they share the user key) can add people,
//! change roles, and create invites. Each change is a record signed by the
//! owner, so any member can check it without trusting whoever relayed it.
//!
//! Roles:
//! - **editor**: can change anything in the workspace.
//! - **viewer**: receives everything, changes nothing.
//! - **removed**: no longer synced with. Edits they made while they were an
//!   editor stay valid; anything they sign after removal is refused.
//!
//! Records accumulate (never edited in place), so a member's role at any point
//! in time can be worked out, and copies held by different members merge by
//! taking the union.
//!
//! Membership lives in `members.json` beside the workspace's docs, outside the
//! Automerge data: in a CRDT anyone can change anything, so authority can't
//! live there.

use std::collections::BTreeMap;
use std::path::Path;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::identity::{key_id, IdentityState};
use crate::now_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Editor,
    Viewer,
    Removed,
}

impl Role {
    pub fn can_edit(self) -> bool {
        matches!(self, Role::Owner | Role::Editor)
    }

    /// Still part of the workspace: syncs and receives changes.
    pub fn has_access(self) -> bool {
        !matches!(self, Role::Removed)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Editor => "editor",
            Role::Viewer => "viewer",
            Role::Removed => "removed",
        }
    }
}

fn owner_key(owner: &str) -> Option<VerifyingKey> {
    let bytes: [u8; 32] = hex::decode(owner).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

fn signed_bytes(domain: &str, fields: &impl Serialize) -> Result<Vec<u8>> {
    let mut out = format!("notes-app/{domain}/v1\0").into_bytes();
    out.extend(serde_json::to_vec(fields)?);
    Ok(out)
}

fn sign(key: &SigningKey, domain: &str, fields: &impl Serialize) -> Result<String> {
    Ok(hex::encode(key.sign(&signed_bytes(domain, fields)?).to_bytes()))
}

fn verify(owner: &str, domain: &str, fields: &impl Serialize, sig: &str) -> bool {
    let Some(vk) = owner_key(owner) else { return false };
    let Ok(bytes) = hex::decode(sig) else { return false };
    let Ok(arr) = <[u8; 64]>::try_from(bytes.as_slice()) else { return false };
    let Ok(msg) = signed_bytes(domain, fields) else { return false };
    vk.verify(&msg, &Signature::from_bytes(&arr)).is_ok()
}

// ---- records --------------------------------------------------------------------

/// A role given to a user, signed by the workspace owner.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRecord {
    pub workspace: String,
    pub user: String,
    pub role: Role,
    /// Their name when the record was made. Display only.
    pub name: String,
    /// The invite they joined with, if any.
    pub invite: Option<String>,
    pub issued: i64,
    pub sig: String,
}

#[derive(Serialize)]
struct MemberFields<'a> {
    workspace: &'a str,
    user: &'a str,
    role: Role,
    name: &'a str,
    invite: Option<&'a str>,
    issued: i64,
}

impl MemberRecord {
    fn fields(&self) -> MemberFields<'_> {
        MemberFields {
            workspace: &self.workspace,
            user: &self.user,
            role: self.role,
            name: &self.name,
            invite: self.invite.as_deref(),
            issued: self.issued,
        }
    }

    pub fn is_valid(&self, workspace: &str, owner: &str) -> bool {
        self.workspace == workspace
            && self.user != owner
            && self.role != Role::Owner
            && verify(owner, "member", &self.fields(), &self.sig)
    }
}

/// A single-use invitation. The secret itself is never stored, only its hash,
/// so seeing this record doesn't let anyone use the invite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteRecord {
    pub workspace: String,
    pub id: String,
    pub role: Role,
    pub secret_hash: String,
    /// Who it's for, as the owner described it. Display only.
    pub label: String,
    pub expires: i64,
    pub issued: i64,
    pub cancelled: bool,
    pub sig: String,
}

#[derive(Serialize)]
struct InviteFields<'a> {
    workspace: &'a str,
    id: &'a str,
    role: Role,
    secret_hash: &'a str,
    label: &'a str,
    expires: i64,
    issued: i64,
    cancelled: bool,
}

impl InviteRecord {
    fn fields(&self) -> InviteFields<'_> {
        InviteFields {
            workspace: &self.workspace,
            id: &self.id,
            role: self.role,
            secret_hash: &self.secret_hash,
            label: &self.label,
            expires: self.expires,
            issued: self.issued,
            cancelled: self.cancelled,
        }
    }

    pub fn is_valid(&self, workspace: &str, owner: &str) -> bool {
        self.workspace == workspace
            && matches!(self.role, Role::Editor | Role::Viewer)
            && verify(owner, "invite", &self.fields(), &self.sig)
    }
}

/// Actions only the workspace's owner may take, however they arrive: renaming
/// the workspace. Editors can change everything inside it, not what it's called.
pub fn owner_only(action: &str) -> bool {
    action == "workspace.rename"
}

pub fn hash_secret(secret: &[u8]) -> String {
    hex::encode(Sha256::digest(secret))
}

// ---- membership -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Members {
    pub workspace: String,
    pub owner: String,
    #[serde(default)]
    pub records: Vec<MemberRecord>,
    #[serde(default)]
    pub invites: BTreeMap<String, InviteRecord>,
    /// Public identity records (devices, names, addresses) of the owner and
    /// members, so their devices' changes can be checked and their devices found.
    #[serde(default)]
    pub identities: BTreeMap<String, IdentityState>,
}

/// One person with access, for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    pub user: String,
    pub name: String,
    pub role: Role,
    pub since: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    pub id: String,
    pub role: Role,
    pub label: String,
    pub expires: i64,
    pub issued: i64,
    /// "open", "used", "expired", or "cancelled".
    pub status: &'static str,
    pub used_by: Option<String>,
}

impl Members {
    /// A workspace with no one but its owner.
    pub fn new(workspace: &str, owner: &IdentityState) -> Self {
        let mut identities = BTreeMap::new();
        identities.insert(owner.user.clone(), owner.clone().validated());
        Self {
            workspace: workspace.to_string(),
            owner: owner.user.clone(),
            records: Vec::new(),
            invites: BTreeMap::new(),
            identities,
        }
    }

    pub fn load(path: &Path) -> Result<Option<Self>> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice::<Self>(&bytes)?.validated())),
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

    /// Keep only records signed by the owner and identities that check out.
    pub fn validated(mut self) -> Self {
        let (ws, owner) = (self.workspace.clone(), self.owner.clone());
        self.records.retain(|r| r.is_valid(&ws, &owner));
        self.invites.retain(|id, i| &i.id == id && i.is_valid(&ws, &owner));
        self.identities = std::mem::take(&mut self.identities)
            .into_iter()
            .filter(|(u, s)| &s.user == u)
            .map(|(u, s)| (u, s.validated()))
            .collect();
        self.sort();
        self
    }

    fn sort(&mut self) {
        self.records.sort_by(|a, b| (a.issued, &a.sig).cmp(&(b.issued, &b.sig)));
        self.records.dedup_by(|a, b| a.sig == b.sig);
    }

    /// Fold in another copy of the same workspace's membership. Returns
    /// whether anything changed. A copy that names a different owner is refused.
    pub fn merge(&mut self, other: &Members) -> Result<bool> {
        if other.workspace != self.workspace || other.owner != self.owner {
            return Err(CoreError::Invalid(format!(
                "membership for workspace {} names a different owner",
                &self.workspace
            )));
        }
        let before = self.clone();
        let (ws, owner) = (self.workspace.clone(), self.owner.clone());
        for r in &other.records {
            if r.is_valid(&ws, &owner) && !self.records.iter().any(|x| x.sig == r.sig) {
                self.records.push(r.clone());
            }
        }
        for (id, i) in &other.invites {
            if &i.id == id
                && i.is_valid(&ws, &owner)
                && self.invites.get(id).is_none_or(|cur| (i.issued, i.cancelled) > (cur.issued, cur.cancelled))
            {
                self.invites.insert(id.clone(), i.clone());
            }
        }
        for (user, ids) in &other.identities {
            if &ids.user != user {
                continue;
            }
            match self.identities.get_mut(user) {
                Some(cur) => {
                    cur.merge(ids);
                }
                None => {
                    self.identities.insert(user.clone(), ids.clone().validated());
                }
            }
        }
        self.sort();
        Ok(*self != before)
    }

    /// Fold in a user's latest public identity (e.g. your own, with a newly
    /// linked device). Only users who are part of the workspace are kept.
    pub fn learn_identity(&mut self, ids: &IdentityState) -> bool {
        if self.role(&ids.user).is_none() {
            return false;
        }
        match self.identities.get_mut(&ids.user) {
            Some(cur) => cur.merge(ids),
            None => {
                self.identities.insert(ids.user.clone(), ids.clone().validated());
                true
            }
        }
    }

    pub fn is_shared(&self) -> bool {
        !self.records.is_empty()
    }

    fn history<'a>(&'a self, user: &'a str) -> impl Iterator<Item = &'a MemberRecord> + 'a {
        self.records.iter().filter(move |r| r.user == user)
    }

    /// A user's current role, or None if they were never part of it.
    pub fn role(&self, user: &str) -> Option<Role> {
        if user == self.owner {
            return Some(Role::Owner);
        }
        self.history(user).last().map(|r| r.role)
    }

    /// Whether a change a user signed at `ts` counts: the owner always,
    /// otherwise only while they were an editor. Only the end of an editor
    /// period is enforced: before joining they had no copy to change.
    pub fn could_edit_at(&self, user: &str, ts: i64) -> bool {
        if user == self.owner {
            return true;
        }
        let hist: Vec<&MemberRecord> = self.history(user).collect();
        hist.iter().enumerate().any(|(i, r)| {
            r.role == Role::Editor && hist.get(i + 1).is_none_or(|next| ts < next.issued)
        })
    }

    /// The user whose identity certifies `device`, preferring `own` for your own devices.
    pub fn device_user<'a>(&'a self, device: &str, own: &'a IdentityState) -> Option<&'a IdentityState> {
        if own.certs.contains_key(device) {
            return Some(own);
        }
        self.identities.values().find(|ids| ids.certs.contains_key(device))
    }

    /// Whether an event signed by `device` at `ts` counts in this workspace.
    /// `action` is the event's action: a few are the owner's alone.
    pub fn trusts_event(&self, device: &str, ts: i64, action: &str, own: &IdentityState) -> bool {
        match self.device_user(device, own) {
            Some(ids) => {
                ids.trusted_at(device, ts)
                    && self.could_edit_at(&ids.user, ts)
                    && (!owner_only(action) || ids.user == self.owner)
            }
            None => false,
        }
    }

    /// Whether a device may sync this workspace right now: it belongs to
    /// someone with access, and hasn't been removed from their identity.
    pub fn device_has_access(&self, device: &str, own: &IdentityState) -> bool {
        match self.device_user(device, own) {
            Some(ids) => ids.is_trusted(device) && self.role(&ids.user).is_some_and(Role::has_access),
            None => false,
        }
    }

    /// Users with access, owner first.
    pub fn people(&self) -> Vec<MemberView> {
        let name = |u: &str, fallback: &str| {
            self.identities
                .get(u)
                .map(|i| i.display_name())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| fallback.to_string())
        };
        let mut out = vec![MemberView {
            user: self.owner.clone(),
            name: name(&self.owner, ""),
            role: Role::Owner,
            since: 0,
        }];
        let mut users: Vec<&str> = self.records.iter().map(|r| r.user.as_str()).collect();
        users.dedup();
        users.sort();
        users.dedup();
        for u in users {
            let hist: Vec<&MemberRecord> = self.history(u).collect();
            let last = hist[hist.len() - 1];
            out.push(MemberView {
                user: u.to_string(),
                name: name(u, &last.name),
                role: last.role,
                since: hist[0].issued,
            });
        }
        out
    }

    /// Everyone's devices except `own_user`'s that may sync right now.
    pub fn peer_devices(&self, own_user: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (user, ids) in &self.identities {
            if user == own_user || !self.role(user).is_some_and(Role::has_access) {
                continue;
            }
            for device in ids.certs.keys().filter(|d| ids.is_trusted(d)) {
                out.push((user.clone(), device.clone()));
            }
        }
        out
    }

    // ---- invites ----------------------------------------------------------------

    pub fn invite_used_by(&self, id: &str) -> Option<&MemberRecord> {
        self.records.iter().find(|r| r.invite.as_deref() == Some(id))
    }

    pub fn invites_view(&self, now: i64) -> Vec<InviteView> {
        let mut out: Vec<InviteView> = self
            .invites
            .values()
            .map(|i| {
                let used = self.invite_used_by(&i.id);
                let status = if used.is_some() {
                    "used"
                } else if i.cancelled {
                    "cancelled"
                } else if i.expires < now {
                    "expired"
                } else {
                    "open"
                };
                InviteView {
                    id: i.id.clone(),
                    role: i.role,
                    label: i.label.clone(),
                    expires: i.expires,
                    issued: i.issued,
                    status,
                    used_by: used.map(|r| r.user.clone()),
                }
            })
            .collect();
        out.sort_by_key(|i| std::cmp::Reverse(i.issued));
        out
    }

    /// Check an invite presented by someone who wants to join.
    pub fn check_invite(&self, id: &str, secret: &[u8], now: i64) -> Result<&InviteRecord> {
        let invite = self.invites.get(id).ok_or_else(|| CoreError::Invalid("That invite doesn't exist.".into()))?;
        if invite.secret_hash != hash_secret(secret) {
            return Err(CoreError::Invalid("That invite's secret doesn't match.".into()));
        }
        if invite.cancelled {
            return Err(CoreError::Invalid("That invite was cancelled.".into()));
        }
        if self.invite_used_by(id).is_some() {
            return Err(CoreError::Invalid("That invite has already been used.".into()));
        }
        if invite.expires < now {
            return Err(CoreError::Invalid("That invite has expired.".into()));
        }
        Ok(invite)
    }

    // ---- owner actions ------------------------------------------------------------

    fn require_owner(&self, key: &SigningKey) -> Result<()> {
        if key_id(&key.verifying_key()) != self.owner {
            return Err(CoreError::Invalid("Only the workspace's owner can change who has access.".into()));
        }
        Ok(())
    }

    /// Give a user a role (or remove them). Returns the new record.
    pub fn set_role(
        &mut self,
        owner: &SigningKey,
        user: &IdentityState,
        role: Role,
        invite: Option<&str>,
    ) -> Result<MemberRecord> {
        self.require_owner(owner)?;
        if user.user == self.owner {
            return Err(CoreError::Invalid("The owner's role can't change.".into()));
        }
        if role == Role::Owner {
            return Err(CoreError::Invalid("A workspace has exactly one owner.".into()));
        }
        // Strictly after the previous record, so the order of changes is unambiguous.
        let last = self.history(&user.user).last().map(|r| r.issued).unwrap_or(0);
        let mut record = MemberRecord {
            workspace: self.workspace.clone(),
            user: user.user.clone(),
            role,
            name: user.display_name(),
            invite: invite.map(str::to_string),
            issued: now_ms().max(last + 1),
            sig: String::new(),
        };
        record.sig = sign(owner, "member", &record.fields())?;
        self.records.push(record.clone());
        if role.has_access() {
            self.learn_identity(user);
        }
        self.sort();
        Ok(record)
    }

    /// Create an invite. Returns the record and the secret to hand out.
    pub fn create_invite(
        &mut self,
        owner: &SigningKey,
        id: &str,
        role: Role,
        label: &str,
        valid_for_ms: i64,
    ) -> Result<(InviteRecord, [u8; 32])> {
        self.require_owner(owner)?;
        if !matches!(role, Role::Editor | Role::Viewer) {
            return Err(CoreError::Invalid("Invites are for editors or viewers.".into()));
        }
        let mut secret = [0u8; 32];
        getrandom::getrandom(&mut secret).map_err(|e| CoreError::Invalid(e.to_string()))?;
        let issued = now_ms();
        let mut invite = InviteRecord {
            workspace: self.workspace.clone(),
            id: id.to_string(),
            role,
            secret_hash: hash_secret(&secret),
            label: label.to_string(),
            expires: issued + valid_for_ms,
            issued,
            cancelled: false,
            sig: String::new(),
        };
        invite.sig = sign(owner, "invite", &invite.fields())?;
        self.invites.insert(id.to_string(), invite.clone());
        Ok((invite, secret))
    }

    pub fn cancel_invite(&mut self, owner: &SigningKey, id: &str) -> Result<InviteRecord> {
        self.require_owner(owner)?;
        let cur = self.invites.get(id).ok_or_else(|| CoreError::Invalid("That invite doesn't exist.".into()))?;
        let mut next = cur.clone();
        next.cancelled = true;
        next.issued = now_ms().max(cur.issued + 1);
        next.sig = sign(owner, "invite", &next.fields())?;
        self.invites.insert(id.to_string(), next.clone());
        Ok(next)
    }

    /// The copy to send to another user: invites only go to the owner's own devices.
    pub fn for_user(&self, user: &str) -> Members {
        let mut out = self.clone();
        if user != self.owner {
            out.invites.clear();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::DeviceCert;

    fn key(n: u8) -> SigningKey {
        SigningKey::from_bytes(&[n; 32])
    }

    /// A user with one device.
    fn person(user: u8, device: u8, name: &str) -> (SigningKey, SigningKey, IdentityState) {
        let (u, d) = (key(user), key(device));
        let mut s = IdentityState::new(&u.verifying_key());
        s.name = Some(crate::identity::NameRecord::issue(&u, name).unwrap());
        s.certs.insert(key_id(&d.verifying_key()), DeviceCert::issue(&u, &d.verifying_key(), "laptop").unwrap());
        (u, d, s)
    }

    #[test]
    fn roles_over_time() {
        let (owner, od, oid) = person(1, 11, "Sam");
        let (_, xd, xid) = person(2, 12, "Alex");
        let mut m = Members::new("w", &oid);
        let x_dev = key_id(&xd.verifying_key());

        assert_eq!(m.role(&oid.user), Some(Role::Owner));
        assert!(m.trusts_event(&key_id(&od.verifying_key()), 0, "note.edit", &oid));
        assert!(!m.trusts_event(&x_dev, 0, "note.edit", &oid), "strangers can't edit");

        let added = m.set_role(&owner, &xid, Role::Viewer, None).unwrap();
        assert_eq!(m.role(&xid.user), Some(Role::Viewer));
        assert!(m.device_has_access(&x_dev, &oid));
        assert!(!m.trusts_event(&x_dev, added.issued + 10, "note.edit", &oid), "viewers can't edit");

        let promoted = m.set_role(&owner, &xid, Role::Editor, None).unwrap();
        assert!(m.trusts_event(&x_dev, promoted.issued + 10, "note.edit", &oid));
        assert!(!m.trusts_event(&x_dev, promoted.issued + 10, "workspace.rename", &oid), "editors can't rename");
        assert!(m.trusts_event(&key_id(&od.verifying_key()), promoted.issued + 10, "workspace.rename", &oid));

        let removed = m.set_role(&owner, &xid, Role::Removed, None).unwrap();
        assert!(!m.device_has_access(&x_dev, &oid));
        assert!(m.trusts_event(&x_dev, removed.issued - 1, "note.edit", &oid), "edits from before removal stand");
        assert!(!m.trusts_event(&x_dev, removed.issued + 1, "note.edit", &oid), "edits after removal don't");

        let people = m.people();
        assert_eq!(people.len(), 2);
        assert_eq!((people[1].name.as_str(), people[1].role), ("Alex", Role::Removed));
    }

    #[test]
    fn only_the_owner_signs_and_copies_merge() {
        let (owner, _, oid) = person(1, 11, "Sam");
        let (xu, _, xid) = person(2, 12, "Alex");
        let (_, _, yid) = person(3, 13, "Yan");
        let mut m = Members::new("w", &oid);
        m.set_role(&owner, &xid, Role::Editor, None).unwrap();

        // A member can't sign records, even for themselves.
        let mut copy = m.clone();
        assert!(copy.set_role(&xu, &yid, Role::Editor, None).is_err());

        // A forged record (signed by a member, labelled as the owner's) is dropped on merge.
        let mut forged = m.clone();
        let mut r = forged.records[0].clone();
        r.user = yid.user.clone();
        r.sig = sign(&xu, "member", &r.fields()).unwrap();
        forged.records.push(r);
        let mut theirs = m.clone();
        assert!(!theirs.merge(&forged).unwrap());
        assert_eq!(theirs.role(&yid.user), None);

        // Two owner devices adding different people: both survive the merge.
        let mut a = m.clone();
        let mut b = m.clone();
        a.set_role(&owner, &yid, Role::Viewer, None).unwrap();
        let (_, _, zid) = person(4, 14, "Zoe");
        b.set_role(&owner, &zid, Role::Editor, None).unwrap();
        assert!(a.merge(&b).unwrap());
        assert_eq!(a.role(&yid.user), Some(Role::Viewer));
        assert_eq!(a.role(&zid.user), Some(Role::Editor));

        // A copy claiming another owner is refused outright.
        let other = Members::new("w", &xid);
        assert!(a.merge(&other).is_err());
    }

    #[test]
    fn invites_are_single_use_and_expire() {
        let (owner, _, oid) = person(1, 11, "Sam");
        let (_, _, xid) = person(2, 12, "Alex");
        let mut m = Members::new("w", &oid);
        let now = now_ms();
        let (inv, secret) = m.create_invite(&owner, "i1", Role::Editor, "Alex", 60_000).unwrap();
        assert!(m.check_invite("i1", b"wrong", now).is_err());
        assert_eq!(m.check_invite("i1", &secret, now).unwrap().role, Role::Editor);

        m.set_role(&owner, &xid, inv.role, Some("i1")).unwrap();
        assert!(m.check_invite("i1", &secret, now).is_err(), "used once");
        assert_eq!(m.invites_view(now)[0].status, "used");

        let (_, s2) = m.create_invite(&owner, "i2", Role::Viewer, "", 60_000).unwrap();
        m.cancel_invite(&owner, "i2").unwrap();
        assert!(m.check_invite("i2", &s2, now).is_err());

        let (_, s3) = m.create_invite(&owner, "i3", Role::Viewer, "", 1_000).unwrap();
        assert!(m.check_invite("i3", &s3, now + 5_000).is_err(), "expired");

        // Members other than the owner never receive invites.
        assert!(m.for_user(&xid.user).invites.is_empty());
        assert_eq!(m.for_user(&oid.user).invites.len(), 3);
    }
}
