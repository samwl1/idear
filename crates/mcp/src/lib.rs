//! Claude's own peer for idear, served over MCP. The app runs this as
//! `idear mcp`; the standalone `idear-mcp` binary is the same thing.
//!
//! Claude gets its own identity, separate from yours. You invite it to the
//! workspaces it should see, as a viewer or an editor, like any person; it
//! keeps its own copy and syncs with your devices over the same encrypted
//! connections. Its changes are signed by its own device and show up as
//! "Claude" in each workspace's activity log, and removing it on the Sharing
//! page cuts it off.
//!
//! ```text
//! idear mcp                   serve MCP over stdio (what Claude runs)
//! idear mcp join <link>       redeem an invite link from another person's app
//! idear mcp status            identity, workspaces, roles, sync
//! idear mcp relay <url|default|off>
//! idear mcp name <name>       the name people see (default "Claude")
//! ```

mod docs;
pub mod peer;
mod rpc;
mod tools;

use std::time::{Duration, Instant};

use notes_core::identity::NameRecord;
use notes_core::members::Role;
use notes_core::Workspace;
use notes_peer::invite::read_invite;
use notes_peer::sync::{Settings, DEFAULT_RELAY};

use crate::docs::{err, Res};
use crate::peer::{data_dir, Peer};

const USAGE: &str = "\
idear mcp: Claude's peer for idear

Usage:
  idear mcp                     Serve MCP over stdio. This is what Claude runs.
  idear mcp join <invite link>  Join a workspace someone invited Claude to.
  idear mcp status              Show Claude's identity, workspaces, and sync.
  idear mcp relay <url>         Use your own relay (or \"default\", \"local\", or \"off\").
  idear mcp name <name>         The name people see for Claude.

Workspaces on this computer are easier: give Claude access in the app, under
Settings, Claude. Data lives in IDEAR_CLAUDE_DIR if set, else your user data
folder (dev.sam.idear-claude). Keys live in the system keychain.";

/// Run a command line (the arguments after `mcp`). Returns the exit code.
pub fn cli(args: Vec<String>) -> i32 {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("idear mcp: {e}");
            return 1;
        }
    };
    rt.block_on(run(args))
}

async fn run(args: Vec<String>) -> i32 {
    let result = match args.first().map(String::as_str) {
        None | Some("serve") => serve().await,
        Some("join") => match args.get(1) {
            Some(link) => join(link).await,
            None => Err("Paste the invite link after `join`.".into()),
        },
        Some("status") => status().await,
        Some("relay") => match args.get(1) {
            Some(r) => relay(r).await,
            None => Err("Give a relay URL, \"default\", or \"off\".".into()),
        },
        Some("name") if args.len() > 1 => name(&args[1..].join(" ")),
        Some("help" | "-h" | "--help") => {
            println!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(format!("Unknown command \"{other}\".\n\n{USAGE}")),
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("idear mcp: {e}");
            1
        }
    }
}

async fn serve() -> Res<()> {
    let peer = Peer::open(&data_dir())?;
    peer.take_inbox();
    peer.service.start().await;
    // Workspaces you give Claude in the app arrive as invites in its inbox.
    let inbox = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
            if peer.take_inbox() > 0 {
                peer.service.kick();
            }
        }
    };
    tokio::select! {
        r = rpc::serve(&peer) => r,
        _ = inbox => Ok(()),
    }
}

fn joined(peer: &Peer, workspace: &str) -> Option<Role> {
    let own = peer.own().ok()?;
    let ws = Workspace::open(&peer.ctx.root, workspace).ok()?;
    ws.members().and_then(|m| m.role(&own.user)).filter(|r| r.has_access())
}

async fn join(link: &str) -> Res<()> {
    let peer = Peer::open(&data_dir())?;
    let own = peer.own()?;
    let pending = read_invite(link, &own.user)?;
    let (ws, name) = (pending.invite.workspace.clone(), pending.workspace_name.clone());
    if joined(&peer, &ws).is_some() {
        println!("Claude is already in \"{name}\".");
        return Ok(());
    }
    let owner = pending.owner.display_name();
    peer.service.joins().add(pending);
    peer.service.start().await;
    println!("Joining \"{name}\" from {}. Their app needs to be open…", if owner.is_empty() { "the owner" } else { &owner });
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(120) {
        let _ = tokio::time::timeout(Duration::from_secs(30), peer.service.sync_all()).await;
        if let Some(role) = joined(&peer, &ws) {
            let what = if role == Role::Editor { "an editor" } else { "a viewer" };
            println!("Joined \"{name}\". Claude is {what}.");
            return Ok(());
        }
        if let Some(e) = peer.service.joins().list().iter().find(|j| j.invite.workspace == ws).and_then(|j| j.last_error.clone()) {
            // A refusal from the owner (used, expired, cancelled) won't change by retrying.
            if !e.contains("reachable") && !e.contains("timed out") && !e.contains("Waiting") {
                peer.service.joins().remove(&ws);
                return Err(e);
            }
            eprintln!("  {e}, retrying…");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    Err("Couldn't reach the owner's device in two minutes. The invite is saved: Claude keeps trying whenever it runs."
        .into())
}

async fn status() -> Res<()> {
    let peer = Peer::open(&data_dir())?;
    let own = peer.own()?;
    println!("Name:      {}", own.display_name());
    println!("Identity:  {}", own.user);
    println!("Device ID: {}  (add this to your relay's allowlist if it has one)", peer.device_id());
    println!("Data:      {}", data_dir().display());
    let settings = Settings::load(&data_dir().join("sync.json"));
    println!(
        "Sync:      {}",
        if !settings.enabled { "off".to_string() } else if settings.relay.is_empty() { "local network only".into() } else { format!("relay {}", settings.relay) }
    );
    let all = peer.workspaces()?;
    println!("\nWorkspaces:");
    if all.is_empty() {
        println!("  none yet. Invite Claude from a workspace's Sharing page, then run `idear mcp join <link>`.");
    }
    for (_, name, role, owner) in all {
        println!("  {name}: {} (owner {})", role.as_str(), if owner.is_empty() { "unknown" } else { &owner });
    }
    for j in peer.service.joins().list() {
        println!("  {}: waiting to join ({})", j.workspace_name, j.last_error.unwrap_or_else(|| "not tried yet".into()));
    }
    Ok(())
}

async fn relay(value: &str) -> Res<()> {
    let peer = Peer::open(&data_dir())?;
    let mut s = Settings::load(&data_dir().join("sync.json"));
    match value {
        "off" => s.enabled = false,
        "default" => {
            s.enabled = true;
            s.relay = DEFAULT_RELAY.into();
        }
        "local" => {
            s.enabled = true;
            s.relay.clear();
        }
        url => {
            s.enabled = true;
            s.relay = url.into();
        }
    }
    peer.service.update_settings(s).await?;
    println!("Saved.");
    Ok(())
}

fn name(name: &str) -> Res<()> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err("Names need 1 to 80 characters.".into());
    }
    let peer = Peer::open(&data_dir())?;
    let mut a = peer.ctx.account.lock().map_err(|_| "account lock poisoned")?;
    a.state.name = Some(NameRecord::issue(&a.user, name).map_err(err)?);
    a.save()?;
    println!("People will see Claude as \"{name}\" after the next sync.");
    Ok(())
}
