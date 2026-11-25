mod account;
mod claude;
mod commands;
mod share;
mod updates;

pub use notes_peer::sync;
use notes_peer::keychain;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

/// How long a closing window gets to save before it's closed anyway, so one
/// that has stopped responding can't keep the app from quitting.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(2);
/// The id of the Quit item that replaces macOS's own (see `app_menu`).
const QUIT_ID: &str = "quit";

/// Saves asked of the windows that haven't been answered yet. Text typed in
/// the last moment waits on a short pause before it's stored, so a window is
/// asked to store it now before it closes (see `flush_then`).
#[derive(Default)]
struct Flushes {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<String>>>,
    /// Set once the windows have saved for a quit, so the exit that follows goes through.
    quitting: AtomicBool,
}

#[derive(Clone, serde::Serialize)]
struct FlushRequest {
    id: u64,
    /// The one window asked, or none for all of them.
    window: Option<String>,
}

/// A window saying it has stored everything it was asked to.
#[tauri::command]
fn flush_done(window: tauri::Window, flushes: tauri::State<'_, Flushes>, id: u64) {
    if let Some(tx) = flushes.waiting.lock().unwrap().get(&id) {
        let _ = tx.send(window.label().to_string());
    }
}

/// Waits until every window in `left` has answered on `rx`, or `timeout` has passed.
fn wait_for_windows(rx: &mpsc::Receiver<String>, mut left: HashSet<String>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !left.is_empty() {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(label) => {
                left.remove(&label);
            }
            Err(_) => return false,
        }
    }
    true
}

/// Asks one window (or, with `None`, all of them) to save what it has
/// pending, then runs `then`: when they've all answered, or after
/// `FLUSH_TIMEOUT` if one doesn't. Returns at once; the wait is off the main
/// thread, which the windows need in order to answer.
fn flush_then(app: &tauri::AppHandle, only: Option<String>, then: impl FnOnce() + Send + 'static) {
    let asked: HashSet<String> = match &only {
        Some(label) => HashSet::from([label.clone()]),
        None => app.webview_windows().into_keys().collect(),
    };
    let flushes = app.state::<Flushes>();
    let id = flushes.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    flushes.waiting.lock().unwrap().insert(id, tx);
    let _ = app.emit("flush-request", FlushRequest { id, window: only });
    let app = app.clone();
    std::thread::spawn(move || {
        wait_for_windows(&rx, asked, FLUSH_TIMEOUT);
        app.state::<Flushes>().waiting.lock().unwrap().remove(&id);
        then();
    });
}

/// The default menu, with macOS's Quit item swapped for one of ours. The
/// built-in item terminates the process on the spot, with no event the app
/// could save on; ours asks the app to exit, which saves first (see `run`).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    // The first submenu is the app's own, and Quit is its last item.
    if let Some(MenuItemKind::Submenu(own)) = menu.items()?.into_iter().next() {
        let items = own.items()?;
        if let Some(MenuItemKind::Predefined(_)) = items.last() {
            own.remove_at(items.len() - 1)?;
            let quit = MenuItem::with_id(app, QUIT_ID, format!("Quit {}", app.package_info().name), true, Some("CmdOrCtrl+Q"))?;
            own.append(&quit)?;
        }
    }
    Ok(menu)
}

pub fn run() {
    // Carry over data from the app's earlier names. This has to happen
    // before the webview starts, since it creates the new folder.
    if let Some(base) = dirs::data_dir() {
        for (old, new) in [
            ("dev.sam.scramble", "dev.sam.idear"),
            ("dev.sam.notes", "dev.sam.idear"),
            // Claude's data too, so Settings → Claude knows it before it next runs.
            ("dev.sam.scramble-claude", "dev.sam.idear-claude"),
            ("dev.sam.notes-claude", "dev.sam.idear-claude"),
        ] {
            if let Err(e) = notes_peer::migrate_dir(&base.join(old), &base.join(new)) {
                eprintln!("Couldn't move data from {old}: {e}");
            }
        }
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
        // Opens links from notes in the system browser instead of inside the app.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Flushes::default())
        .on_menu_event(|app, event| {
            if event.id() == QUIT_ID {
                app.exit(0);
            }
        })
        // A window closing (Cmd+W, the close button): let it save what was
        // typed in the last moment, then close it.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let closing = window.clone();
                flush_then(window.app_handle(), Some(window.label().to_string()), move || {
                    let _ = closing.destroy();
                });
            }
        })
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            let root = data.join("workspaces");
            notes_peer::create_private_dir(&data)?;
            let key = keychain::APP.load_or_create(keychain::DEVICE_KEY)?;
            let account = match account::Account::open(
                data.join("identity.json"),
                &key,
                keychain::APP,
                &keychain::default_device_name(),
            ) {
                Ok(a) => Arc::new(Mutex::new(a)),
                Err(e) => {
                    // Say why before quitting: a silent exit, or worse a silent
                    // fresh identity, would be far harder to recover from.
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    app.dialog()
                        .message(&e)
                        .title("idear can't open your account")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    return Err(e.into());
                }
            };
            let open = Arc::new(Mutex::new(HashMap::new()));
            let ctx = sync::SyncCtx {
                root: root.clone(),
                device: key.clone(),
                account: account.clone(),
                open: open.clone(),
                joins: Arc::new(sync::Joins::load(data.join("joins.json"))),
                approvals: Arc::new(sync::Approvals::load(data.join("approvals.json"))),
            };
            let handle = app.handle().clone();
            let on_applied: sync::OnApplied = Arc::new(move |applied| {
                let _ = handle.emit("sync-applied", applied);
            });
            ctx.purge_old_trash();
            let service = sync::SyncService::new(ctx, data.join("sync.json"), on_applied);
            let starter = service.clone();
            tauri::async_runtime::spawn(async move { starter.start().await });
            app.manage(commands::AppState { root, key, account, open, sync: service });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            flush_done,
            commands::device_id,
            commands::set_spell_check,
            commands::print_window,
            account::account_info,
            account::set_user_name,
            account::rename_device,
            account::create_link_code,
            account::preview_join,
            account::join_with_code,
            account::revoke_device,
            updates::export_update,
            updates::import_update,
            updates::inspect_update,
            commands::sync_status,
            commands::sync_now,
            commands::set_sync_settings,
            commands::list_workspaces,
            commands::create_workspace,
            commands::delete_workspace,
            commands::restore_workspace,
            commands::purge_workspace,
            commands::list_trash,
            commands::load_doc,
            commands::create_doc,
            commands::apply_change,
            commands::get_tree,
            commands::run_view,
            commands::notes_hub,
            commands::links_of,
            commands::list_events,
            commands::verify_log,
            commands::check_workspace,
            commands::repair_index,
            commands::git_info,
            commands::path_exists,
            commands::git_branches,
            share::share_info,
            share::create_invite,
            share::cancel_invite,
            share::set_member_role,
            share::join_shared,
            share::inspect_invite,
            share::list_approvals,
            share::decide_join,
            share::list_joins,
            share::cancel_join,
            share::share_contacts,
            claude::claude_status,
            claude::claude_set_access,
            claude::claude_connect_desktop,
        ])
        .build(tauri::generate_context!())
        .expect("error while running the app")
        .run(|app, event| {
            // The app was asked to quit with windows still open: let them
            // save first, then exit for real. With no windows left there's
            // nothing to wait for; each saved as it closed.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code == Some(tauri::RESTART_EXIT_CODE) || app.webview_windows().is_empty() {
                    return;
                }
                if app.state::<Flushes>().quitting.swap(true, Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                let handle = app.clone();
                flush_then(app, None, move || handle.exit(code.unwrap_or(0)));
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_every_window_asked() {
        let (tx, rx) = mpsc::channel();
        let asked = HashSet::from(["main".to_string(), "pop-1".to_string()]);
        tx.send("main".to_string()).unwrap();
        // An answer from a window that wasn't asked doesn't count.
        tx.send("pop-2".to_string()).unwrap();
        tx.send("pop-1".to_string()).unwrap();
        assert!(wait_for_windows(&rx, asked, Duration::from_secs(5)));
    }

    #[test]
    fn gives_up_on_a_window_that_never_answers() {
        let (tx, rx) = mpsc::channel();
        let asked = HashSet::from(["main".to_string(), "pop-1".to_string()]);
        tx.send("main".to_string()).unwrap();
        let started = Instant::now();
        assert!(!wait_for_windows(&rx, asked, Duration::from_millis(50)));
        assert!(started.elapsed() < Duration::from_secs(2));
        // Nothing asked: nothing to wait for.
        assert!(wait_for_windows(&rx, HashSet::new(), Duration::from_millis(50)));
    }
}
