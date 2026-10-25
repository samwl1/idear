//! Append-only, signed event log.
//!
//! Every write in the app produces one event. Events form one hash chain per
//! device (concurrent writers can't share a single linear chain). Each event is
//! hashed over its canonical fields and signed with the device's Ed25519 key.
//!
//! Events name the workspace they were logged in, so one signed in a workspace
//! can't be replayed into another by someone who is a member of both. Events
//! from before that field existed carry none and verify as they always did.

use std::collections::BTreeMap;
use std::path::Path;

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::now_ms;

/// Whether a device may log an action at a time: `(device, ts, action, doc)`,
/// where `doc` is the doc the event is about (`""` for events about nothing
/// in particular, such as membership changes). Decided by the workspace's
/// membership; the log itself only checks signatures and chains.
pub type Trusted<'a> = dyn Fn(&str, i64, &str, &str) -> bool + 'a;

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
    /// The workspace this was logged in; covered by the hash when present.
    /// Absent only on events from before it was recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

impl Event {
    /// The doc this event is about: `data.doc`, or the manifest for the
    /// workspace's creation event. Empty for events about nothing in
    /// particular (membership, invites).
    pub fn doc(&self) -> String {
        if self.action == "workspace.create" {
            return crate::workspace::MANIFEST.to_string();
        }
        serde_json::from_str::<serde_json::Value>(&self.data)
            .ok()
            .and_then(|d| d.get("doc").and_then(|v| v.as_str()).map(str::to_string))
            .unwrap_or_default()
    }
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
    /// Left out entirely when absent, so older events hash as before.
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<&'a str>,
}

fn canonical_hash(e: &Event) -> Result<[u8; 32]> {
    let c = Canonical {
        device: &e.device,
        seq: e.seq,
        prev: e.prev.as_deref(),
        ts: e.ts,
        action: &e.action,
        target: &e.target,
        data: &e.data,
        workspace: e.workspace.as_deref(),
    };
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

/// Which Automerge changes signed events vouch for, per doc. A hash only
/// counts for the doc the event names: an event about one doc (a member's
/// private pins, say) can never let a change into another (the layout).
#[derive(Debug, Default)]
pub struct Attested {
    hashes: std::collections::HashMap<String, std::collections::HashSet<String>>,
    /// Layout changes vouched for by an event only the owner may log
    /// (`workspace.create`, `workspace.rename`): the ones allowed to set the
    /// workspace's name.
    renames: std::collections::HashSet<String>,
    pub workspace_created: bool,
    /// The creation event listed no heads: a workspace from before creation
    /// events vouched for the first layout change.
    pub legacy_create: bool,
}

impl Attested {
    /// Whether a trusted event about `doc` vouches for change `hash`.
    pub fn vouches(&self, doc: &str, hash: &str) -> bool {
        self.hashes.get(doc).is_some_and(|h| h.contains(hash))
    }

    /// Whether an owner-only event (creation or rename) vouches for layout change `hash`.
    pub fn allows_rename(&self, hash: &str) -> bool {
        self.renames.contains(hash)
    }

    fn add(&mut self, doc: &str, hash: &str) {
        self.hashes.entry(doc.to_string()).or_default().insert(hash.to_string());
    }
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
    workspace: String,
}

impl EventLog {
    pub fn open(path: &Path, workspace: &str) -> Result<Self> {
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
        // Logs from before events named their workspace: add the column, left
        // NULL for the events already there.
        let has_workspace = conn
            .prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'workspace'")?
            .exists([])?;
        if !has_workspace {
            conn.execute_batch("ALTER TABLE events ADD COLUMN workspace TEXT")?;
        }
        Ok(Self { conn, workspace: workspace.to_string() })
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

        let mut event = Event {
            device,
            seq,
            prev,
            ts,
            action: action.to_string(),
            target: target.to_string(),
            data,
            hash: String::new(),
            sig: String::new(),
            workspace: Some(self.workspace.clone()),
        };
        let digest = canonical_hash(&event)?;
        event.hash = hex::encode(digest);
        event.sig = hex::encode(key.sign(&digest).to_bytes());

        tx.execute(
            "INSERT INTO events (device, seq, prev, ts, action, target, data, hash, sig, workspace)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                event.device, event.seq, event.prev, event.ts, event.action,
                event.target, event.data, event.hash, event.sig, event.workspace
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
            "SELECT device, seq, prev, ts, action, target, data, hash, sig, workspace
             FROM events ORDER BY device, seq",
        )?;
        let rows = stmt.query_map([], row_to_event)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Take in events from another copy of this workspace's log. Each event
    /// must hash and verify, come from a device `trusted` accepts, and extend
    /// that device's chain exactly. Duplicates are skipped; anything else is
    /// refused and reported.
    pub fn import(&mut self, incoming: &[Event], trusted: &Trusted) -> Result<ImportedEvents> {
        let mut report = ImportedEvents::default();
        let mut sorted: Vec<&Event> = incoming.iter().collect();
        sorted.sort_by(|a, b| (a.device.as_str(), a.seq).cmp(&(b.device.as_str(), b.seq)));
        let tx = self.conn.transaction()?;
        for e in sorted {
            // Device ids are hex public keys; anything else is refused before
            // it's looked at further (and never sliced, which could panic).
            if decode_key(&e.device).is_err() {
                report.rejected += 1;
                report.problems.push("an event named a device that isn't a valid key".into());
                continue;
            }
            let short = short_id(&e.device);
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
            if e.workspace.as_deref().is_some_and(|w| w != self.workspace) {
                report.rejected += 1;
                report.problems.push(format!("device {short} event #{} belongs to another workspace", e.seq));
                continue;
            }
            if !trusted(&e.device, e.ts, &e.action, &e.doc()) {
                report.rejected += 1;
                report.untrusted.insert(e.device.clone());
                continue;
            }
            let digest = canonical_hash(e)?;
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
                "INSERT INTO events (device, seq, prev, ts, action, target, data, hash, sig, workspace)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![e.device, e.seq, e.prev, e.ts, e.action, e.target, e.data, e.hash, e.sig, e.workspace],
            )?;
            report.added += 1;
        }
        tx.commit()?;
        Ok(report)
    }

    /// Automerge change hashes vouched for by signed events from trusted
    /// devices, per doc, plus whether a trusted device signed the workspace's
    /// creation. An event only vouches for the doc it names, and a `private.*`
    /// event only for a private doc (and the other way round), so the looser
    /// rules for members' private docs never reach shared ones.
    pub fn attested(&self, trusted: &Trusted) -> Result<Attested> {
        let mut out = Attested::default();
        for e in self.all()? {
            let doc = e.doc();
            if doc.is_empty() || !trusted(&e.device, e.ts, &e.action, &doc) {
                continue;
            }
            if e.action.starts_with("private.") != crate::workspace::is_private_doc(&doc) {
                continue;
            }
            let Ok(data) = serde_json::from_str::<serde_json::Value>(&e.data) else { continue };
            let owner_only = e.action == "workspace.create" || crate::members::owner_only(&e.action);
            if let Some(h) = data.get("change").and_then(|v| v.as_str()) {
                out.add(&doc, h);
                if owner_only {
                    out.renames.insert(h.to_string());
                }
            }
            if let Some(hs) = data.get("heads").and_then(|v| v.as_array()) {
                for h in hs.iter().filter_map(|v| v.as_str()) {
                    out.add(&doc, h);
                    if owner_only {
                        out.renames.insert(h.to_string());
                    }
                }
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
            "SELECT device, seq, prev, ts, action, target, data, hash, sig, workspace
             FROM events ORDER BY ts DESC, device, seq DESC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![limit, offset], row_to_event)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Recompute every hash, check every signature, and check that each
    /// device's chain is contiguous and correctly linked.
    pub fn verify(&self) -> Result<VerifyReport> {
        let mut stmt = self.conn.prepare(
            "SELECT device, seq, prev, ts, action, target, data, hash, sig, workspace
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
            let short = short_id(device);
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
                if e.workspace.as_deref().is_some_and(|w| w != self.workspace) {
                    problems.push(format!("device {short} seq {}: logged in another workspace", e.seq));
                }
                let digest = canonical_hash(e)?;
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

/// The first characters of an id for messages; safe on any string.
fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
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
        workspace: r.get(9)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn open(dir: &Path, ws: &str) -> EventLog {
        EventLog::open(&dir.join(format!("{ws}.db")), ws).unwrap()
    }

    #[test]
    fn events_stay_in_the_workspace_they_were_logged_in() {
        let dir = tempfile::tempdir().unwrap();
        let k = key(7);
        let mut a = open(dir.path(), "w1");
        a.append(&k, "note.edit", "n", &serde_json::json!({ "doc": "n", "change": "abc" })).unwrap();
        let events = a.all().unwrap();
        assert_eq!(events[0].workspace.as_deref(), Some("w1"));
        assert!(a.verify().unwrap().ok);

        // The same signed event offered to another workspace is refused,
        // even though its signature is fine and the device would be trusted.
        let mut b = open(dir.path(), "w2");
        let r = b.import(&events, &|_, _, _, _| true).unwrap();
        assert_eq!((r.added, r.rejected), (0, 1), "{r:?}");
        assert!(r.problems[0].contains("another workspace"), "{r:?}");
        assert!(b.all().unwrap().is_empty());

        // And at home it imports as a duplicate without complaint.
        let r = a.import(&events, &|_, _, _, _| true).unwrap();
        assert_eq!((r.added, r.rejected), (0, 0));
    }

    #[test]
    fn events_from_before_the_workspace_field_still_verify() {
        let dir = tempfile::tempdir().unwrap();
        let k = key(9);
        let device = hex::encode(k.verifying_key().to_bytes());
        // Hand-build an event the way older versions did: no workspace field.
        let mut e = Event {
            device,
            seq: 1,
            prev: None,
            ts: 1,
            action: "note.edit".into(),
            target: "n".into(),
            data: "{}".into(),
            hash: String::new(),
            sig: String::new(),
            workspace: None,
        };
        let digest = canonical_hash(&e).unwrap();
        e.hash = hex::encode(digest);
        e.sig = hex::encode(k.sign(&digest).to_bytes());
        // Its hash is exactly the pre-workspace one: the field adds nothing when absent.
        #[derive(Serialize)]
        struct Old<'a> {
            device: &'a str,
            seq: u64,
            prev: Option<&'a str>,
            ts: i64,
            action: &'a str,
            target: &'a str,
            data: &'a str,
        }
        let old = Old { device: &e.device, seq: 1, prev: None, ts: 1, action: "note.edit", target: "n", data: "{}" };
        let legacy = Sha256::digest(serde_json::to_vec(&old).unwrap());
        assert_eq!(e.hash, hex::encode(legacy));

        let mut log = open(dir.path(), "w1");
        let r = log.import(&[e], &|_, _, _, _| true).unwrap();
        assert_eq!((r.added, r.rejected), (1, 0), "{r:?}");
        assert!(log.verify().unwrap().ok);
    }

    #[test]
    fn a_bad_device_id_is_refused_not_panicked_on() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = open(dir.path(), "w1");
        let e = Event {
            device: "ééééé".into(),
            seq: 1,
            prev: None,
            ts: 1,
            action: "note.edit".into(),
            target: "n".into(),
            data: "{}".into(),
            hash: "00".into(),
            sig: "00".into(),
            workspace: None,
        };
        let r = log.import(&[e], &|_, _, _, _| true).unwrap();
        assert_eq!((r.added, r.rejected), (0, 1));
    }
}
