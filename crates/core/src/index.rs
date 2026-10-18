//! SQLite index. Derived from the Automerge docs and safe to delete and rebuild.
//! Powers the sidebar tree now, and Views and search later.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use rusqlite::types::ToSql;
use sha2::Digest;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// Entity types that live in the workspace tree (as opposed to tasks).
pub const TREE_TYPES: &[&str] = &["folder", "note", "whiteboard", "tracker"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub kind: String,
    pub parent: Option<String>,
    pub sort_key: String,
    pub title: String,
    /// The page is in the layout but its content hasn't arrived (or was
    /// refused) on this device. Folders have no content and are never missing.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

/// Item types a view can return. Folders only when asked for explicitly.
const QUERYABLE: &[&str] = &["note", "whiteboard", "tracker", "folder", "task", "phase"];
const DEFAULT_QUERY_TYPES: &[&str] = &["note", "whiteboard", "tracker"];

/// A saved view's filter. Every field is optional; empty means "don't filter".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ViewQuery {
    pub types: Vec<String>,
    /// Matches items that have any of these tags.
    pub tags: Vec<String>,
    /// Full-text search over titles and bodies.
    pub text: String,
    pub updated_within_days: Option<u32>,
    /// "updated" (default), "created", or "title".
    pub sort: String,
    pub limit: Option<u32>,
    /// Task status categories to include: "todo", "doing", "done". Empty means any.
    pub statuses: Vec<String>,
    /// Case-insensitive match on a task's assignee; `*` globs like tags.
    pub assignee: String,
    /// Task key prefixes to include, e.g. "BUG" or "SYNC*"; `*` globs like tags. Empty means any.
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub parent_title: Option<String>,
    pub tags: Vec<String>,
    pub updated_at: i64,
    /// Tasks only: the project they belong to, their key, and status.
    pub tracker: Option<String>,
    pub tracker_title: Option<String>,
    pub key: Option<String>,
    pub status: Option<String>,
}

/// One task as the tracker doc describes it.
pub struct TaskRecord {
    pub id: String,
    pub parent: Option<String>,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub links: Vec<String>,
    pub created: i64,
    /// status, category, assignee, priority, due, phase, key
    pub props: Vec<(&'static str, String)>,
}

/// Turn free text into a safe FTS5 query: every word becomes a quoted prefix
/// term, so user input can never be parsed as FTS syntax.
fn fts_query(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split_whitespace()
        .map(|w| format!("\"{}\"*", w.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

fn delete_entity(tx: &rusqlite::Transaction, id: &str) -> Result<()> {
    for sql in [
        "DELETE FROM entities WHERE id = ?1",
        "DELETE FROM tags WHERE entity_id = ?1",
        "DELETE FROM props WHERE entity_id = ?1",
        "DELETE FROM links WHERE source = ?1",
        "DELETE FROM fts WHERE entity_id = ?1",
    ] {
        tx.execute(sql, params![id])?;
    }
    Ok(())
}

/// Turn a tag filter into a SQLite GLOB pattern. `*` matches any run of
/// characters (`sec*` matches `security`, `secrets`); every other character is
/// literal, so `?` and `[` from the user can't act as GLOB syntax.
fn tag_glob(tag: &str) -> Option<String> {
    let tag = tag.trim().to_lowercase();
    if tag.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(tag.len());
    for c in tag.chars() {
        match c {
            '?' => out.push_str("[?]"),
            '[' => out.push_str("[[]"),
            ']' => out.push_str("[]]"),
            c => out.push(c),
        }
    }
    Some(out)
}

/// What the manifest says about one tree node.
pub struct NodeRecord {
    pub id: String,
    pub kind: String,
    pub parent: Option<String>,
    pub sort_key: String,
    /// Folders carry their title in the manifest; items carry it in their own doc.
    pub title: Option<String>,
}

/// What an item doc says about itself.
pub struct ItemRecord<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub tags: &'a [String],
    /// Other entities this item points at (e.g. link cards on a whiteboard).
    pub links: &'a [String],
    /// Notes only: the short summary written in the Notes Hub.
    pub summary: &'a str,
}

/// One end of a link, resolved for display. `kind` is None when the item is gone.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRef {
    pub id: String,
    pub kind: Option<String>,
    pub title: String,
    pub tracker: Option<String>,
    pub tracker_title: Option<String>,
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Links {
    /// What this item points at.
    pub outgoing: Vec<LinkRef>,
    /// What points at this item.
    pub incoming: Vec<LinkRef>,
}

/// One row of the Notes Hub.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubRow {
    pub id: String,
    pub title: String,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub summary: String,
    pub words: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub links: Links,
}

/// Resolves the far end of a link: `{end}` is `l.target` or `l.source`.
const LINK_SELECT: &str = "SELECT l.source, l.target, e.type, e.title, e.tracker, tr.title,
        (SELECT value FROM props WHERE entity_id = e.id AND key = 'key')
     FROM links l
     LEFT JOIN entities e ON e.id = {end}
     LEFT JOIN entities tr ON tr.id = e.tracker";

fn link_row(r: &rusqlite::Row, far: usize) -> rusqlite::Result<(String, String, LinkRef)> {
    let source: String = r.get(0)?;
    let target: String = r.get(1)?;
    let id = if far == 0 { source.clone() } else { target.clone() };
    Ok((
        source,
        target,
        LinkRef {
            id,
            kind: r.get(2)?,
            title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            tracker: r.get(4)?,
            tracker_title: r.get(5)?,
            key: r.get(6)?,
        },
    ))
}

pub struct Index {
    conn: Connection,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS entities (
                 id         TEXT PRIMARY KEY,
                 type       TEXT NOT NULL,
                 parent     TEXT,
                 tracker    TEXT,
                 sort_key   TEXT NOT NULL DEFAULT '',
                 title      TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 created_by TEXT NOT NULL,
                 updated_by TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS entities_parent ON entities(parent);
             CREATE TABLE IF NOT EXISTS tags (
                 entity_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (entity_id, tag));
             CREATE TABLE IF NOT EXISTS props (
                 entity_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
                 PRIMARY KEY (entity_id, key));
             CREATE TABLE IF NOT EXISTS links (
                 source TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY (source, target));
             CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(entity_id UNINDEXED, title, body);",
        )?;
        Ok(Self { conn })
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()?)
    }

    pub fn register_doc(&self, id: &str, kind: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO docs (id, kind) VALUES (?1, ?2)",
            params![id, kind],
        )?;
        Ok(())
    }

    /// Every stored doc and its kind.
    pub fn docs(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT id, kind FROM docs ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn doc_kind(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT kind FROM docs WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?)
    }

    /// Replace the tree structure with what the manifest currently says.
    pub fn sync_tree(&mut self, nodes: &[NodeRecord], device: &str, ts: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS live (id TEXT PRIMARY KEY); DELETE FROM live;")?;
        for n in nodes {
            tx.execute("INSERT OR IGNORE INTO live (id) VALUES (?1)", params![n.id])?;
            tx.execute(
                "INSERT INTO entities
                     (id, type, parent, sort_key, title, created_at, updated_at, created_by, updated_by)
                 VALUES (?1, ?2, ?3, ?4, COALESCE(?5, ''), ?6, ?6, ?7, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     type = excluded.type,
                     parent = excluded.parent,
                     sort_key = excluded.sort_key,
                     title = COALESCE(?5, entities.title)",
                params![n.id, n.kind, n.parent, n.sort_key, n.title, ts, device],
            )?;
        }
        // Anything in the tree that the manifest no longer lists was deleted.
        let placeholders = TREE_TYPES.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let stale_sql = format!(
            "SELECT id FROM entities WHERE type IN ({placeholders}) AND id NOT IN (SELECT id FROM live)"
        );
        let stale: Vec<String> = {
            let mut stmt = tx.prepare(&stale_sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(TREE_TYPES.iter()), |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for id in stale {
            // A deleted project takes its tasks out of the index with it.
            let tasks: Vec<String> = {
                let mut stmt = tx.prepare("SELECT id FROM entities WHERE tracker = ?1")?;
                let rows = stmt.query_map(params![id], |r| r.get(0))?;
                rows.collect::<std::result::Result<_, _>>()?
            };
            for task in tasks {
                delete_entity(&tx, &task)?;
            }
            delete_entity(&tx, &id)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Replace one tracker's tasks with what its doc currently says. Tasks whose
    /// fields haven't changed keep their updated time.
    pub fn sync_tasks(&mut self, tracker: &str, tasks: &[TaskRecord], device: &str, ts: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        let existing: std::collections::HashMap<String, Option<String>> = {
            let mut stmt = tx.prepare(
                "SELECT e.id, (SELECT value FROM props WHERE entity_id = e.id AND key = '_sig')
                 FROM entities e WHERE e.tracker = ?1 AND e.type = 'task'",
            )?;
            let rows = stmt.query_map(params![tracker], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for t in tasks {
            let sig = format!(
                "{:?}|{:?}|{}|{}|{:?}|{:?}|{:?}",
                t.parent, t.title, t.description.len(), t.description, t.tags, t.links, t.props
            );
            let sig = hex::encode(sha2::Sha256::digest(sig.as_bytes()));
            if existing.get(&t.id).map(|s| s.as_deref() == Some(sig.as_str())).unwrap_or(false) {
                continue;
            }
            let created = if t.created > 0 { t.created } else { ts };
            tx.execute(
                "INSERT INTO entities
                     (id, type, parent, tracker, title, created_at, updated_at, created_by, updated_by)
                 VALUES (?1, 'task', ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     parent = excluded.parent, tracker = excluded.tracker, title = excluded.title,
                     updated_at = excluded.updated_at, updated_by = excluded.updated_by",
                params![t.id, t.parent, tracker, t.title, created, ts, device],
            )?;
            tx.execute("DELETE FROM props WHERE entity_id = ?1", params![t.id])?;
            for (k, v) in t.props.iter().chain(std::iter::once(&("_sig", sig.clone()))) {
                tx.execute(
                    "INSERT INTO props (entity_id, key, value) VALUES (?1, ?2, ?3)",
                    params![t.id, k, v],
                )?;
            }
            tx.execute("DELETE FROM tags WHERE entity_id = ?1", params![t.id])?;
            for tag in &t.tags {
                tx.execute("INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?1, ?2)", params![t.id, tag])?;
            }
            tx.execute("DELETE FROM links WHERE source = ?1", params![t.id])?;
            for target in &t.links {
                tx.execute("INSERT OR IGNORE INTO links (source, target) VALUES (?1, ?2)", params![t.id, target])?;
            }
            tx.execute("DELETE FROM fts WHERE entity_id = ?1", params![t.id])?;
            tx.execute(
                "INSERT INTO fts (entity_id, title, body) VALUES (?1, ?2, ?3)",
                params![t.id, t.title, t.description],
            )?;
        }
        let live: std::collections::HashSet<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
        for id in existing.keys().filter(|id| !live.contains(id.as_str())) {
            delete_entity(&tx, id)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Views live in the manifest; index their names so the activity log can show them.
    pub fn sync_views(&mut self, views: &[(String, String)], device: &str, ts: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS live_views (id TEXT PRIMARY KEY); DELETE FROM live_views;")?;
        for (id, name) in views {
            tx.execute("INSERT OR IGNORE INTO live_views (id) VALUES (?1)", params![id])?;
            tx.execute(
                "INSERT INTO entities (id, type, title, created_at, updated_at, created_by, updated_by)
                 VALUES (?1, 'view', ?2, ?3, ?3, ?4, ?4)
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title",
                params![id, name, ts, device],
            )?;
        }
        tx.execute(
            "DELETE FROM entities WHERE type = 'view' AND id NOT IN (SELECT id FROM live_views)",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn query(&self, q: &ViewQuery, now: i64) -> Result<Vec<ViewRow>> {
        let mut sql = String::from(
            "SELECT e.id, e.type, e.title, p.title, e.updated_at,
                    (SELECT group_concat(tag, char(31)) FROM tags t WHERE t.entity_id = e.id),
                    e.tracker, tr.title,
                    (SELECT value FROM props WHERE entity_id = e.id AND key = 'key'),
                    (SELECT value FROM props WHERE entity_id = e.id AND key = 'status')
             FROM entities e
             LEFT JOIN entities p ON p.id = e.parent
             LEFT JOIN entities tr ON tr.id = e.tracker
             WHERE 1 = 1",
        );
        let mut args: Vec<Box<dyn ToSql>> = Vec::new();
        let marks = |n: usize| vec!["?"; n].join(",");

        let types: Vec<String> = if q.types.is_empty() {
            DEFAULT_QUERY_TYPES.iter().map(|s| s.to_string()).collect()
        } else {
            q.types.iter().filter(|t| QUERYABLE.contains(&t.as_str())).cloned().collect()
        };
        if types.is_empty() {
            return Ok(Vec::new());
        }
        sql += &format!(" AND e.type IN ({})", marks(types.len()));
        args.extend(types.into_iter().map(|t| Box::new(t) as Box<dyn ToSql>));

        let patterns: Vec<String> = q.tags.iter().filter_map(|t| tag_glob(t)).collect();
        if !patterns.is_empty() {
            let any = vec!["t.tag GLOB ?"; patterns.len()].join(" OR ");
            sql += &format!(
                " AND EXISTS (SELECT 1 FROM tags t WHERE t.entity_id = e.id AND ({any}))"
            );
            args.extend(patterns.into_iter().map(|p| Box::new(p) as Box<dyn ToSql>));
        }
        let statuses: Vec<&String> = q
            .statuses
            .iter()
            .filter(|s| matches!(s.as_str(), "todo" | "doing" | "done"))
            .collect();
        if !statuses.is_empty() {
            sql += &format!(
                " AND e.type = 'task' AND EXISTS (SELECT 1 FROM props WHERE entity_id = e.id
                   AND key = 'category' AND value IN ({}))",
                marks(statuses.len())
            );
            args.extend(statuses.into_iter().map(|s| Box::new(s.clone()) as Box<dyn ToSql>));
        }
        if let Some(pattern) = tag_glob(&q.assignee) {
            sql += " AND e.type = 'task' AND EXISTS (SELECT 1 FROM props WHERE entity_id = e.id
                     AND key = 'assignee' AND lower(value) GLOB ?)";
            args.push(Box::new(pattern));
        }
        // Keys are stored as "PREFIX-n"; a prefix pattern matches the part before the dash.
        let keys: Vec<String> = q.keys.iter().filter_map(|k| tag_glob(k)).collect();
        if !keys.is_empty() {
            let ors: Vec<&str> = keys.iter().map(|_| "lower(value) GLOB ?").collect();
            sql += &format!(
                " AND e.type = 'task' AND EXISTS (SELECT 1 FROM props WHERE entity_id = e.id
                     AND key = 'key' AND ({}))",
                ors.join(" OR ")
            );
            args.extend(keys.into_iter().map(|k| Box::new(format!("{k}-*")) as Box<dyn ToSql>));
        }
        if let Some(fts) = fts_query(&q.text) {
            sql += " AND e.id IN (SELECT entity_id FROM fts WHERE fts MATCH ?)";
            args.push(Box::new(fts));
        }
        if let Some(days) = q.updated_within_days.filter(|d| *d > 0) {
            sql += " AND e.updated_at >= ?";
            args.push(Box::new(now - i64::from(days) * 86_400_000));
        }
        sql += match q.sort.as_str() {
            "title" => " ORDER BY e.title COLLATE NOCASE, e.id",
            "created" => " ORDER BY e.created_at DESC, e.id",
            _ => " ORDER BY e.updated_at DESC, e.id",
        };
        sql += " LIMIT ?";
        args.push(Box::new(q.limit.unwrap_or(500).min(2000)));

        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
            let tags: Option<String> = r.get(5)?;
            Ok(ViewRow {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                parent_title: r.get(3)?,
                updated_at: r.get(4)?,
                tracker: r.get(6)?,
                tracker_title: r.get(7)?,
                key: r.get(8)?,
                status: r.get(9)?,
                tags: tags
                    .map(|t| t.split('\u{1f}').map(str::to_string).collect())
                    .unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn upsert_item(&mut self, item: &ItemRecord, device: &str, ts: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO entities (id, type, title, created_at, updated_at, created_by, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title, updated_at = excluded.updated_at,
                 updated_by = excluded.updated_by",
            params![item.id, item.kind, item.title, ts, device],
        )?;
        tx.execute("DELETE FROM tags WHERE entity_id = ?1", params![item.id])?;
        for tag in item.tags {
            tx.execute(
                "INSERT OR IGNORE INTO tags (entity_id, tag) VALUES (?1, ?2)",
                params![item.id, tag],
            )?;
        }
        tx.execute("DELETE FROM links WHERE source = ?1", params![item.id])?;
        for target in item.links {
            tx.execute(
                "INSERT OR IGNORE INTO links (source, target) VALUES (?1, ?2)",
                params![item.id, target],
            )?;
        }
        if item.kind == "note" {
            let words = item.body.split_whitespace().count() as i64;
            tx.execute("DELETE FROM props WHERE entity_id = ?1", params![item.id])?;
            tx.execute(
                "INSERT INTO props (entity_id, key, value) VALUES (?1, 'summary', ?2), (?1, 'words', ?3)",
                params![item.id, item.summary, words.to_string()],
            )?;
        }
        let searchable = if item.summary.is_empty() {
            item.body.to_string()
        } else {
            format!("{}\n{}", item.summary, item.body)
        };
        tx.execute("DELETE FROM fts WHERE entity_id = ?1", params![item.id])?;
        tx.execute(
            "INSERT INTO fts (entity_id, title, body) VALUES (?1, ?2, ?3)",
            params![item.id, item.title, searchable],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Replace one project's phases. Phases are entities so they can be linked to.
    pub fn sync_phases(&mut self, tracker: &str, phases: &[(String, String)], device: &str, ts: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        let existing: std::collections::HashMap<String, String> = {
            let mut stmt =
                tx.prepare("SELECT id, title FROM entities WHERE tracker = ?1 AND type = 'phase'")?;
            let rows = stmt.query_map(params![tracker], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for (id, name) in phases {
            if existing.get(id) == Some(name) {
                continue;
            }
            tx.execute(
                "INSERT INTO entities (id, type, tracker, title, created_at, updated_at, created_by, updated_by)
                 VALUES (?1, 'phase', ?2, ?3, ?4, ?4, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
                     updated_by = excluded.updated_by",
                params![id, tracker, name, ts, device],
            )?;
        }
        let live: std::collections::HashSet<&str> = phases.iter().map(|(id, _)| id.as_str()).collect();
        for id in existing.keys().filter(|id| !live.contains(id.as_str())) {
            delete_entity(&tx, id)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Everything an item links to and everything linking to it.
    pub fn links_of(&self, id: &str) -> Result<Links> {
        let collect = |end: &str, filter: &str, far: usize| -> Result<Vec<LinkRef>> {
            let sql = format!("{} WHERE {filter} = ?1 ORDER BY e.title COLLATE NOCASE", LINK_SELECT.replace("{end}", end));
            let mut stmt = self.conn.prepare(&sql)?;
            let rows = stmt.query_map(params![id], |r| link_row(r, far))?;
            Ok(rows.map(|r| r.map(|(_, _, l)| l)).collect::<std::result::Result<_, _>>()?)
        };
        Ok(Links {
            outgoing: collect("l.target", "l.source", 1)?,
            incoming: collect("l.source", "l.target", 0)?,
        })
    }

    /// Every note, with what the Notes Hub shows for it.
    pub fn notes_hub(&self) -> Result<Vec<HubRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT e.id, e.title, f.title, e.created_at, e.updated_at,
                    (SELECT value FROM props WHERE entity_id = e.id AND key = 'summary'),
                    (SELECT value FROM props WHERE entity_id = e.id AND key = 'words'),
                    (SELECT group_concat(tag, char(31)) FROM tags t WHERE t.entity_id = e.id)
             FROM entities e LEFT JOIN entities f ON f.id = e.parent
             WHERE e.type = 'note'
             ORDER BY e.updated_at DESC, e.id",
        )?;
        let mut rows: Vec<HubRow> = stmt
            .query_map([], |r| {
                let tags: Option<String> = r.get(7)?;
                let words: Option<String> = r.get(6)?;
                Ok(HubRow {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    folder: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                    summary: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    words: words.and_then(|w| w.parse().ok()).unwrap_or(0),
                    tags: tags.map(|t| t.split('\u{1f}').map(str::to_string).collect()).unwrap_or_default(),
                    links: Links { outgoing: Vec::new(), incoming: Vec::new() },
                })
            })?
            .collect::<std::result::Result<_, _>>()?;

        // Two bulk queries for every note's links, rather than two per note.
        let index: std::collections::HashMap<String, usize> =
            rows.iter().enumerate().map(|(i, r)| (r.id.clone(), i)).collect();
        for (end, near, far) in [("l.target", "l.source", 1usize), ("l.source", "l.target", 0usize)] {
            let sql = format!(
                "{} WHERE {near} IN (SELECT id FROM entities WHERE type = 'note') ORDER BY e.title COLLATE NOCASE",
                LINK_SELECT.replace("{end}", end)
            );
            let mut stmt = self.conn.prepare(&sql)?;
            let links = stmt.query_map([], |r| link_row(r, far))?;
            for link in links {
                let (source, target, l) = link?;
                let note = if far == 1 { source } else { target };
                if let Some(&i) = index.get(&note) {
                    if far == 1 {
                        rows[i].links.outgoing.push(l);
                    } else {
                        rows[i].links.incoming.push(l);
                    }
                }
            }
        }
        Ok(rows)
    }

    pub fn tree(&self) -> Result<Vec<TreeNode>> {
        let placeholders = TREE_TYPES.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT e.id, e.type, e.parent, e.sort_key, e.title,
                    (e.type != 'folder' AND d.id IS NULL) AS missing
             FROM entities e LEFT JOIN docs d ON d.id = e.id
             WHERE e.type IN ({placeholders}) ORDER BY e.sort_key, e.id"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(TREE_TYPES.iter()), |r| {
            Ok(TreeNode {
                id: r.get(0)?,
                kind: r.get(1)?,
                parent: r.get(2)?,
                sort_key: r.get(3)?,
                title: r.get(4)?,
                missing: r.get::<_, i64>(5)? != 0,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Display titles for event targets in the activity log.
    pub fn title_of(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT title FROM entities WHERE id = ?1", params![id], |r| r.get(0))
            .optional()?)
    }
}
