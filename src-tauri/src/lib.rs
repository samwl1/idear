mod account;
mod claude;
mod commands;
mod share;
mod updates;

pub use notes_peer::sync;
use notes_peer::keychain;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::Manager;

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
    tauri::Builder::default()
        // Opens links from notes in the system browser instead of inside the app.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
                use tauri::Emitter;
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
        .run(tauri::generate_context!())
        .expect("error while running the app");
}
