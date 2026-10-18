//! This device's view of who you are: the user key, the identity state, and
//! the commands that change them.

use ed25519_dalek::SigningKey;
use notes_core::identity::{
    create_invite, key_id, new_passphrase, open_invite, DeviceCert, NameRecord, Revocation,
};
use serde::Serialize;
use tauri::State;

use crate::commands::AppState;
use notes_peer::keychain;

/// How long a link code works by default, and the most it can be asked to.
const INVITE_DEFAULT_MINUTES: i64 = 15;
const INVITE_MAX_MINUTES: i64 = 7 * 24 * 60;

pub use notes_peer::account::Account;
use notes_peer::account::ensure_box_key;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    id: String,
    name: String,
    linked: i64,
    revoked: Option<i64>,
    this_device: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    user_id: String,
    name: String,
    this_device: String,
    devices: Vec<DeviceView>,
}

fn view(account: &Account, device: &SigningKey) -> AccountView {
    let me = key_id(&device.verifying_key());
    let mut devices: Vec<DeviceView> = account
        .state
        .certs
        .values()
        .map(|c| DeviceView {
            id: c.device.clone(),
            name: c.name.clone(),
            linked: c.issued,
            revoked: account.state.revocations.get(&c.device).map(|r| r.revoked),
            this_device: c.device == me,
        })
        .collect();
    devices.sort_by_key(|d| (!d.this_device, d.revoked.is_some(), d.linked));
    AccountView { user_id: account.state.user.clone(), name: account.state.display_name(), this_device: me, devices }
}

type CmdResult<T> = Result<T, String>;

fn with_account<T>(
    state: &AppState,
    f: impl FnOnce(&mut Account, &SigningKey) -> CmdResult<T>,
) -> CmdResult<T> {
    let mut account = state.account.lock().map_err(|_| "account lock poisoned".to_string())?;
    f(&mut account, &state.key)
}

#[tauri::command]
pub async fn account_info(state: State<'_, AppState>) -> CmdResult<AccountView> {
    with_account(&state, |a, d| Ok(view(a, d)))
}

#[tauri::command]
pub async fn set_user_name(state: State<'_, AppState>, name: String) -> CmdResult<AccountView> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 80 {
        return Err("Names need 1 to 80 characters.".into());
    }
    with_account(&state, |a, d| {
        a.state.name = Some(NameRecord::issue(&a.user, &name).map_err(|e| e.to_string())?);
        a.save()?;
        Ok(view(a, d))
    })
}

#[tauri::command]
pub async fn rename_device(state: State<'_, AppState>, device: String, name: String) -> CmdResult<AccountView> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 80 {
        return Err("Device names need 1 to 80 characters.".into());
    }
    with_account(&state, |a, d| {
        let cert = a.state.certs.get(&device).ok_or("That device isn't linked.")?;
        let vk = ed25519_dalek::VerifyingKey::from_bytes(
            &hex::decode(&cert.device).ok().and_then(|b| b.try_into().ok()).ok_or("Bad device id.")?,
        )
        .map_err(|e| e.to_string())?;
        let renewed = DeviceCert::issue(&a.user, &vk, &name).map_err(|e| e.to_string())?;
        a.state.certs.insert(device, renewed);
        a.save()?;
        Ok(view(a, d))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteView {
    code: String,
    passphrase: String,
    expires: i64,
}

/// `minutes`: how long the code should work, up to a week. The window only
/// limits how long a captured code and passphrase stay useful; the passphrase
/// is what protects the code.
#[tauri::command]
pub async fn create_link_code(state: State<'_, AppState>, minutes: Option<i64>) -> CmdResult<InviteView> {
    let minutes = minutes.unwrap_or(INVITE_DEFAULT_MINUTES);
    if !(1..=INVITE_MAX_MINUTES).contains(&minutes) {
        return Err("A link code can last from a minute to a week.".into());
    }
    let ttl = minutes * 60 * 1000;
    with_account(&state, |a, d| {
        let passphrase = new_passphrase().map_err(|e| e.to_string())?;
        let code = create_invite(&a.user, &a.state, &key_id(&d.verifying_key()), &passphrase, ttl)
            .map_err(|e| e.to_string())?;
        Ok(InviteView { code, passphrase, expires: notes_core_now() + ttl })
    })
}

/// Join another device's identity. This device's own certificate is issued
/// with the received user key; the other devices learn about it on next sync.
#[tauri::command]
pub async fn join_with_code(state: State<'_, AppState>, code: String, passphrase: String) -> CmdResult<AccountView> {
    // Argon2 takes a moment; keep it off the account lock.
    let payload = tauri::async_runtime::spawn_blocking(move || open_invite(&code, &passphrase))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let user = payload.user_key().map_err(|e| e.to_string())?;
    let reset = owned_workspaces(&state)?;
    let joined = with_account(&state, |a, d| {
        let device_id = key_id(&d.verifying_key());
        if payload.state.user == a.state.user {
            return Err("This device is already linked to that identity.".into());
        }
        if payload.state.revocations.contains_key(&device_id) {
            return Err("This device was removed from that identity and can't rejoin it.".into());
        }
        let name = a.state.certs.get(&device_id).map(|c| c.name.clone()).unwrap_or_else(keychain::default_device_name);
        let mut next = payload.state.clone();
        next.certs.insert(
            device_id,
            DeviceCert::issue(&user, &d.verifying_key(), &name).map_err(|e| e.to_string())?,
        );
        ensure_box_key(&user, &mut next)?;
        // Records first, then the key: if the save fails the keychain still
        // matches the records on disk, and the join can simply be retried. A
        // failure between the two leaves records for the new account with the
        // old key, which open() refuses loudly rather than resetting.
        let previous = std::mem::replace(&mut a.state, next);
        if let Err(e) = a.save() {
            a.state = previous;
            return Err(e);
        }
        if let Err(e) = keychain::APP.store(keychain::USER_KEY, &user) {
            a.state = previous;
            let _ = a.save();
            return Err(e);
        }
        a.user = user;
        Ok(view(a, d))
    })?;
    // Workspaces this device made under its old identity become the new identity's.
    if let Ok(mut open) = state.open.lock() {
        for id in reset {
            open.remove(&id);
            let _ = std::fs::remove_file(state.root.join(&id).join("members.json"));
        }
    }
    Ok(joined)
}

/// Unshared workspaces owned by this device's current identity. Refuses if
/// it's in any shared workspace: switching identities would orphan the ones it
/// owns and lose its place in the rest.
fn owned_workspaces(state: &AppState) -> CmdResult<Vec<String>> {
    let me = state.account.lock().map_err(|_| "account lock poisoned".to_string())?.state.user.clone();
    let mut owned = Vec::new();
    let mut shared = Vec::new();
    for w in notes_core::list_workspaces(&state.root).map_err(|e| e.to_string())? {
        let path = state.root.join(&w.id).join("members.json");
        match notes_core::members::Members::load(&path).map_err(|e| e.to_string())? {
            Some(m) if m.is_shared() && m.role(&me).is_some_and(|r| r.has_access()) => shared.push(w.name),
            Some(m) if m.owner == me => owned.push(w.id),
            _ => {}
        }
    }
    if !shared.is_empty() {
        return Err(format!(
            "This device's identity shares workspaces with other people ({}). Joining another identity would \
             lose its place in them. Link the other device to this one instead.",
            shared.join(", ")
        ));
    }
    Ok(owned)
}

#[tauri::command]
pub async fn revoke_device(state: State<'_, AppState>, device: String) -> CmdResult<AccountView> {
    with_account(&state, |a, d| {
        if device == key_id(&d.verifying_key()) {
            return Err("You can't remove the device you're using.".into());
        }
        if !a.state.certs.contains_key(&device) {
            return Err("That device isn't linked.".into());
        }
        if a.state.revocations.contains_key(&device) {
            // Already removed; a second record with a later time would make
            // devices disagree about which of its changes still count.
            return Ok(view(a, d));
        }
        let r = Revocation::issue(&a.user, &device).map_err(|e| e.to_string())?;
        a.state.revocations.insert(device, r);
        a.save()?;
        Ok(view(a, d))
    })
}

fn notes_core_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

