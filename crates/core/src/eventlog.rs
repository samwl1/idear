//! Append-only, signed event log.
//!
//! Every write in the app produces one event. Events form one hash chain per
//! device (concurrent writers can't share a single linear chain). Each event is
//! hashed over its canonical fields and signed with the device's Ed25519 key.

use std::collections::BTreeMap;
use std::path::Path;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::now_ms;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub device: String,
    pub seq: u64,
    pub prev: Option<String>,
    pub ts: i64,
    pub action: String,
    pub target: String,
    /// JSON payload, stored and hashed as the exact string.
    pub data: String,
    pub hash: String,
    pub sig: String,
}

/// The fields covered by the hash. Field order here is the canonical order.
#[derive(Serialize)]
struct Canonical<'a> {
    device: &'a str,
    seq: u64,
    prev: Option<&'a str>,
    ts: i64,
    action: &'a str,
    target: &'a str,
    data: &'a str,
}

fn canonical_hash(
    device: &str,
    seq: u64,
    prev: Option<&str>,
    ts: i64,
    action: &str,
    target: &str,
    data: &str,
) -> Result<[u8; 32]> {
    let c = Canonical { device, seq, prev, ts, action, target, data };
    let bytes = serde_json::to_vec(&c)?;
    Ok(Sha256::digest(&bytes).into())
}

#[derive(Debug, Default)]
pub struct ImportedEvents {
    pub added: usize,
    pub rejected: usize,
    /// Devices whose events were refused because they aren't (or are no longer) yours.
    pub untrusted: std::collections::BTreeSet<String>,
    pub problems: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Attested {
    pub hashes: std::collections::HashSet<String>,
    pub workspace_created: bool,
    /// The creation event listed no heads: a workspace from before creation
    /// events vouched for the first layout change.
    pub legacy_create: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub ok: bool,
    pub events: usize,
    pub devices: usize,
    pub problems: Vec<String>,
}

pub struct EventLog {
    conn: Connection,
}

impl EventLog {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS events (
                 device TEXT NOT NULL,
                 seq    INTEGER NOT NULL,
                 prev   TEXT,
                 ts     INTEGER NOT NULL,
                 action TEXT NOT NULL,
                 target TEXT NOT NULL,
                 data   TEXT NOT NULL,
                 hash   TEXT NOT NULL UNIQUE,
                 sig    TEXT NOT NULL,
                 PRIMARY KEY (device, seq)
             );
             CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
             CREATE INDEX IF NOT EXISTS events_target ON events(target);
             -- Append-only: refuse updates and deletes at the database level.
             CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
                 BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;
             CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
                 BEGIN SELECT RAISE(ABORT, 'event log is append-only'); END;",
        )?;
        Ok(Self { conn })
    }

    pub fn append(
        &mut self,
        key: &SigningKey,
        action: &str,
        target: &str,
        data: &serde_json::Value,
    ) -> Result<Event> {
        let device = hex::encode(key.verifying_key().to_bytes());
        let data = serde_json::to_string(data)?;
        let tx = self.conn.transaction()?;

        let last: Option<(u64, String)> = tx
            .query_row(
                "SELECT seq, hash FROM events WHERE device = ?1 ORDER BY seq DESC LIMIT 1",
                params![device],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (seq, prev) = match last {
            Some((s, h)) => (s + 1, Some(h)),
            None => (1, None),
        };
        let ts = now_ms();

        let digest = canonical_hash(&device, seq, prev.as_deref(), ts, action, target, &data)?;
        let sig = key.sign(&digest);
        let event = Event {
            device,
            seq,
            prev,
            ts,
            action: action.to_string(),
            target: target.to_string(),
            data,
            hash: hex::encode(digest),
            sig: hex::encode(sig.to_bytes()),
        };

        tx.execute(
            "INSERT INTO events (device, seq, prev, ts, action, target, data, hash, sig)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event.device, event.seq, event.prev, event.ts, event.action,
                event.target, event.data, event.hash, event.sig
            ],
        )?;
        tx.commit()?;
        Ok(event)
    }

    /// Latest sequence number per device.
    pub fn max_seqs(&self) -> Result<std::collections::BTreeMap<String, u64>> {
        let mut stmt = self.conn.prepare("SELECT device, MAX(seq) FROM events GROUP BY device")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Every event, oldest first per device. Used for export.
    pub fn all(&self) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT device, seq, prev, ts, action, target, data, hash, sig
             FROM events ORDER BY device, seq",
        )?;
        let rows = stmt.query_map([], row_to_event)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Take in events from another copy of this workspace's log. Each event
    /// must hash and verify, come from a device `trusted` accepts, and extend
    /// that device's chain exactly. Duplicates are skipped; anything else is
    /// refused and reported.
    pub fn import(&mut self, incoming: &[Event], trusted: impl Fn(&str, i64, &str) -> bool) -> Result<ImportedEvents> {
        let mut report = ImportedEvents::default();
        let mut sorted: Vec<&Event> = incoming.iter().collect();
        sorted.sort_by(|a, b| (a.device.as_str(), a.seq).cmp(&(b.device.as_str(), b.seq)));
        let tx = self.conn.transaction()?;
        for e in sorted {
            let short = &e.device[..e.device.len().min(8)];
            let existing: Option<String> = tx
                .query_row(
                    "SELECT hash FROM events WHERE device = ?1 AND seq = ?2",
                    params![e.device, e.seq],
                    |r| r.get(0),
                )
                .optional()?;
            match existing {
                Some(h) if h == e.hash => continue,
                Some(_) => {
                    report.rejected += 1;
                    report.problems.push(format!(
                        "device {short} has two different event #{}s; kept the one already here",
                        e.seq
                    ));
                    continue;
                }
                None => {}
            }
            if !trusted(&e.device, e.ts, &e.action) {
                report.rejected += 1;
                report.untrusted.insert(e.device.clone());
                continue;
            }
            let digest = canonical_hash(&e.device, e.seq, e.prev.as_deref(), e.ts, &e.action, &e.target, &e.data)?;
            let sig_ok = decode_key(&e.device)
                .and_then(|vk| decode_sig(&e.sig).map(|s| vk.verify(&digest, &s).is_ok()))
                .unwrap_or(false);
            if hex::encode(digest) != e.hash || !sig_ok {
                report.rejected += 1;
                report.problems.push(format!("device {short} event #{} failed its signature check", e.seq));
                continue;
            }
            let expected_prev: Option<String> = if e.seq == 1 {
                None
            } else {
                tx.query_row(
                    "SELECT hash FROM events WHERE device = ?1 AND seq = ?2",
                    params![e.device, e.seq - 1],
                    |r| r.get(0),
                )
                .optional()?
            };
            if e.seq > 1 && expected_prev.is_none() {
                report.rejected += 1;
                report.problems.push(format!("device {short} event #{} arrived without the ones before it", e.seq));
                continue;
            }
            if e.prev != expected_prev {
                report.rejected += 1;
                report.problems.push(format!("device {short} event #{} doesn't follow its history", e.seq));
                continue;
            }
            tx.execute(
                "INSERT INTO events (device, seq, prev, ts, action, target, data, hash, sig)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![e.device, e.seq, e.prev, e.ts, e.action, e.target, e.data, e.hash, e.sig],
            )?;
            report.added += 1;
        }
        tx.commit()?;
        Ok(report)
    }

    /// Automerge change hashes vouched for by signed events from trusted
    /// devices, plus whether a trusted device signed the workspace's creation.
    pub fn attested(&self, trusted: impl Fn(&str, i64, &str) -> bool) -> Result<Attested> {
        let mut out = Attested::default();
        for e in self.all()? {
            if !trusted(&e.device, e.ts, &e.action) {
                continue;
            }
            let Ok(data) = serde_json::from_str::<serde_json::Value>(&e.data) else { continue };
            if let Some(h) = data.get("change").and_then(|v| v.as_str()) {
                out.hashes.insert(h.to_string());
            }
            if let Some(hs) = data.get("heads").and_then(|v| v.as_array()) {
                out.hashes.extend(hs.iter().filter_map(|v| v.as_str()).map(str::to_string));
            }
            if e.action == "workspace.create" {
                out.workspace_created = true;
                if data.get("heads").and_then(|v| v.as_array()).is_none_or(|h| h.is_empty()) {
                    out.legacy_create = true;
                }
            }
        }
        Ok(out)
    }

    /// Newest first.
    pub fn list(&self, limit: u32, offset: u32) -> Result<Vec<Event>> {
        let mut stmt = self.conn.prepare(
            "SELECT device, seq, prev, ts, action, target, data, hash, sig
             FROM events ORDER BY ts DESC, device, seq DESC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![limit, offset], row_to_event)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Recompute every hash, check every signature, and check that each
    /// device's chain is contiguous and correctly linked.
    pub fn verify(&self) -> Result<VerifyReport> {
        let mut stmt = self.conn.prepare(
            "SELECT device, seq, prev, ts, action, target, data, hash, sig
             FROM events ORDER BY device, seq",
        )?;
        let events: Vec<Event> = stmt
            .query_map([], row_to_event)?
            .collect::<std::result::Result<_, _>>()?;

        let mut by_device: BTreeMap<&str, Vec<&Event>> = BTreeMap::new();
        for e in &events {
            by_device.entry(e.device.as_str()).or_default().push(e);
        }

        let mut problems = Vec::new();
        for (device, chain) in &by_device {
            let short = &device[..device.len().min(12)];
            let vk = match decode_key(device) {
                Ok(k) => k,
                Err(_) => {
                    problems.push(format!("device {short}: invalid public key"));
                    continue;
                }
            };
            let mut expected_prev: Option<&str> = None;
            for (i, e) in chain.iter().enumerate() {
                let want_seq = i as u64 + 1;
                if e.seq != want_seq {
                    problems.push(format!("device {short}: expected seq {want_seq}, found {}", e.seq));
                }
                if e.prev.as_deref() != expected_prev {
                    problems.push(format!("device {short} seq {}: broken link to previous event", e.seq));
                }
                let digest = canonical_hash(
                    &e.device, e.seq, e.prev.as_deref(), e.ts, &e.action, &e.target, &e.data,
                )?;
                if hex::encode(digest) != e.hash {
                    problems.push(format!("device {short} seq {}: hash mismatch (event altered)", e.seq));
                }
                match decode_sig(&e.sig) {
                    Ok(sig) if vk.verify(&digest, &sig).is_ok() => {}
                    _ => problems.push(format!("device {short} seq {}: bad signature", e.seq)),
                }
                expected_prev = Some(e.hash.as_str());
            }
        }

        Ok(VerifyReport {
            ok: problems.is_empty(),
            events: events.len(),
            devices: by_device.len(),
            problems,
        })
    }
}

fn row_to_event(r: &rusqlite::Row) -> rusqlite::Result<Event> {
    Ok(Event {
        device: r.get(0)?,
        seq: r.get(1)?,
        prev: r.get(2)?,
        ts: r.get(3)?,
        action: r.get(4)?,
        target: r.get(5)?,
        data: r.get(6)?,
        hash: r.get(7)?,
        sig: r.get(8)?,
    })
}

fn decode_key(hex_str: &str) -> Result<VerifyingKey> {
    let bytes: [u8; 32] = hex::decode(hex_str)
        .map_err(|e| CoreError::Invalid(e.to_string()))?
        .try_into()
        .map_err(|_| CoreError::Invalid("key length".into()))?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| CoreError::Invalid(e.to_string()))
}

fn decode_sig(hex_str: &str) -> Result<Signature> {
    let bytes: [u8; 64] = hex::decode(hex_str)
        .map_err(|e| CoreError::Invalid(e.to_string()))?
        .try_into()
        .map_err(|_| CoreError::Invalid("signature length".into()))?;
    Ok(Signature::from_bytes(&bytes))
}
