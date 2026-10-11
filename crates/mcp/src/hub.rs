//! One Claude, many connections.
//!
//! Claude Desktop starts `idear mcp` once for chat and again for Cowork and
//! Code sessions, and other clients add more. Only one copy may hold Claude's
//! data folder (two signing as the same device would fork its history), so the
//! copy that gets the lock, the **hub**, also listens on a Unix socket in that
//! folder, and every other copy relays its stdin/stdout through the socket.
//! Each relayed connection is a full MCP session of its own; the hub serves
//! them all from one peer and stays up until the last one closes, so chat
//! closing its connection doesn't cut Cowork off (and vice versa).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Notify;

use crate::docs::{err, Res};
use crate::peer::Peer;
use crate::rpc;

/// How long a relaying copy waits for the hub to start listening. Both are
/// started at the same moment, so the hub may still be loading its keys.
const CONNECT_FOR: Duration = Duration::from_secs(15);

fn socket_path(dir: &Path) -> PathBuf {
    dir.join("mcp.sock")
}

/// The hub's listener. Dropping it removes the socket file.
pub struct Hub {
    listener: UnixListener,
    path: PathBuf,
    active: Arc<AtomicUsize>,
    changed: Arc<Notify>,
}

impl Hub {
    /// Start listening. Call only while holding the data folder's lock: a
    /// leftover socket file from a copy that was killed is replaced.
    pub fn bind(dir: &Path) -> Res<Self> {
        let path = socket_path(dir);
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).map_err(|e| format!("couldn't listen on {}: {e}", path.display()))?;
        Ok(Self { listener, path, active: Arc::new(AtomicUsize::new(0)), changed: Arc::new(Notify::new()) })
    }

    /// Accept relayed connections forever, each served on its own task. Only
    /// returns if accepting keeps failing.
    pub async fn run(&self, peer: Arc<Peer>) -> Res<()> {
        let mut failures = 0;
        loop {
            let stream = match self.listener.accept().await {
                Ok((s, _)) => s,
                Err(e) if failures < 20 => {
                    failures += 1;
                    eprintln!("idear mcp: couldn't accept a relayed connection: {e}");
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                Err(e) => return Err(format!("couldn't accept relayed connections: {e}")),
            };
            failures = 0;
            let (peer, active, changed) = (peer.clone(), self.active.clone(), self.changed.clone());
            active.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let (reader, writer) = stream.into_split();
                if let Err(e) = rpc::serve_io(&peer, reader, writer).await {
                    eprintln!("idear mcp: a relayed session ended: {e}");
                }
                active.fetch_sub(1, Ordering::SeqCst);
                changed.notify_waiters();
            });
        }
    }

    /// Wait until no relayed session is open.
    pub async fn drained(&self) {
        loop {
            let waiting = self.changed.notified();
            if self.active.load(Ordering::SeqCst) == 0 {
                return;
            }
            waiting.await;
        }
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Relay this process's stdin/stdout through the hub's socket until either
/// side closes. Run this when another copy holds the data folder.
pub async fn through(dir: &Path) -> Res<()> {
    let path = socket_path(dir);
    let started = Instant::now();
    let stream = loop {
        match UnixStream::connect(&path).await {
            Ok(s) => break s,
            Err(_) if started.elapsed() < CONNECT_FOR => tokio::time::sleep(Duration::from_millis(200)).await,
            Err(e) => {
                return Err(format!(
                    "Another copy of Claude's idear connection holds {} but isn't accepting connections ({e}). \
                     It may be an older version; quit it (or Claude Desktop) and try again.",
                    dir.display()
                ))
            }
        }
    };
    let (mut from_hub, mut to_hub) = stream.into_split();
    let (mut stdin, mut stdout) = (tokio::io::stdin(), tokio::io::stdout());
    let up = async {
        tokio::io::copy(&mut stdin, &mut to_hub).await.map_err(err)?;
        to_hub.shutdown().await.map_err(err)
    };
    let down = async { tokio::io::copy(&mut from_hub, &mut stdout).await.map_err(err).map(|_| ()) };
    tokio::select! {
        r = up => r,
        r = down => r,
    }
}
