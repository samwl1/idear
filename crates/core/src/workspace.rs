//! A workspace on disk:
//!
//! ```text
//! <root>/<workspace-id>/
//!     docs/*.am      Automerge docs (source of truth for content)
//!     events.db      signed event log (source of truth for history/authority)
//!     index.sqlite   derived index (rebuildable)
//! ```
//!
//! Every write goes through here so it is always stored, indexed, and logged.

use std::fs;
use std::path::{Path, PathBuf};

use ed25519_dalek::SigningKey;
use serde_json::json;

use crate::docs::{get_bool, get_i64, get_map, get_map_list, get_string, get_string_list, root, DocStore};
use crate::error::{CoreError, Result};
use crate::bundle::{DocBundle, WorkspaceBundle};
use crate::eventlog::{Event, EventLog, VerifyReport};
use crate::identity::IdentityState;
use crate::members::Members;
use crate::index::{HubRow, Index, ItemRecord, Links, NodeRecord, TaskRecord, TreeNode, ViewQuery, ViewRow};
use crate::{now_ms, validate_id};

pub const MANIFEST: &str = "manifest";

/// What importing one workspace from an update file did.
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImport {
    pub id: String,
    pub name: String,
    pub created: bool,
    pub events_added: usize,
    pub events_rejected: usize,
    pub docs_updated: usize,
    pub changes_added: usize,
    pub changed_docs: Vec<String>,
    /// Membership (people, roles) changed.
    pub members_changed: bool,
    pub untrusted: std::collections::BTreeSet<String>,
    pub problems: Vec<String>,
}

/// What one device has of a workspace: each doc's heads and each device's
/// latest event. The other side answers with only what's missing.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub id: String,
    pub docs: std::collections::BTreeMap<String, Vec<String>>,
    pub seqs: std::collections::BTreeMap<String, u64>,
}
const ITEM_KINDS: &[&str] = &["note", "whiteboard", "tracker"];
/// A doc that belongs to one member and syncs only between their own
/// devices: pins today. Its id is `private-<their user key>`, so each
/// member has at most one per workspace. Never sent to other people.
pub const PRIVATE: &str = "private";

/// The id of `user`'s private doc in a workspace.
pub fn private_doc_id(user: &str) -> String {
    format!("{PRIVATE}-{}", &user[..user.len().min(48)])
}

/// Whether `id` is some member's private doc.
pub fn is_private_doc(id: &str) -> bool {
    id.starts_with("private-")
}

pub struct Workspace {
    pub id: String,
    dir: PathBuf,
    pub(crate) docs: DocStore,
    index: Index,
    log: EventLog,
    members: Option<Members>,
}

impl Workspace {
    pub fn create(root_dir: &Path, id: &str, manifest: &[u8], key: &SigningKey) -> Result<Self> {
        validate_id(id)?;
        let dir = root_dir.join(id);
        if dir.exists() {
            return Err(CoreError::Invalid(format!("workspace {id} already exists")));
        }
        fs::create_dir_all(&dir)?;
        let mut ws = Self::open_dir(id, dir)?;
        ws.docs.create(MANIFEST, manifest)?;
        ws.index.register_doc(MANIFEST, MANIFEST)?;
        let device = device_id(key);
        ws.reindex(MANIFEST, MANIFEST, &device, now_ms())?;
        let name = ws.name()?;
        let heads: Vec<String> = ws.docs.get(MANIFEST)?.get_heads().iter().map(|h| h.to_string()).collect();
        ws.log.append(key, "workspace.create", id, &json!({ "name": name, "heads": heads }))?;
        Ok(ws)
    }

    /// Everything in this workspace, for an update file. `private` includes
    /// members' private docs, which only your own devices should get.
    pub fn export(&mut self, private: bool) -> Result<WorkspaceBundle> {
        let mut docs = Vec::new();
        for (id, kind) in self.index.docs()? {
            if kind == PRIVATE && !private {
                continue;
            }
            if self.docs.exists(&id)? {
                docs.push(DocBundle::new(&id, &kind, &self.docs.save_bytes(&id)?));
            }
        }
        Ok(WorkspaceBundle { id: self.id.clone(), name: self.name()?, docs, events: self.log.all()? })
    }

    /// What this copy has, for a peer to compute a delta. `private`: whether
    /// the peer is one of your own devices and may know about private docs.
    pub fn summary(&mut self, private: bool) -> Result<WorkspaceSummary> {
        let mut docs = std::collections::BTreeMap::new();
        for (id, kind) in self.index.docs()? {
            if kind == PRIVATE && !private {
                continue;
            }
            if let Some(doc) = self.docs.peek(&id)? {
                docs.insert(id, doc.get_heads().iter().map(|h| h.to_string()).collect());
            }
        }
        Ok(WorkspaceSummary { id: self.id.clone(), docs, seqs: self.log.max_seqs()? })
    }

    /// Only what a peer with `theirs` is missing. Without a summary (they
    /// don't have this workspace), everything.
    pub fn delta_for(&mut self, theirs: Option<&WorkspaceSummary>, private: bool) -> Result<WorkspaceBundle> {
        use automerge::ReadDoc;
        let Some(theirs) = theirs else { return self.export(private) };
        let events = self
            .log
            .all()?
            .into_iter()
            .filter(|e| e.seq > theirs.seqs.get(&e.device).copied().unwrap_or(0))
            .collect();
        let mut docs = Vec::new();
        for (id, kind) in self.index.docs()? {
            if kind == PRIVATE && !private {
                continue;
            }
            let Some(doc) = self.docs.peek(&id)? else { continue };
            match theirs.docs.get(&id) {
                None => docs.push(DocBundle::new(&id, &kind, &doc.save())),
                Some(heads) => {
                    // Heads we don't know are changes they have and we don't; skip them.
                    let known: Vec<automerge::ChangeHash> = heads
                        .iter()
                        .filter_map(|h| h.parse().ok())
                        .filter(|h| doc.get_change_by_hash(h).is_some())
                        .collect();
                    let missing: Vec<automerge::Change> = doc
                        .get_changes(&known)
                        .into_iter()
                        .filter(|c| !heads.contains(&c.hash().to_string()))
                        .collect();
                    if !missing.is_empty() {
                        docs.push(DocBundle::from_changes(&id, &kind, &missing));
                    }
                }
            }
        }
        Ok(WorkspaceBundle { id: self.id.clone(), name: self.name()?, docs, events })
    }

    /// Merge a workspace from an update file, creating it here if it's new.
    /// Events are verified first; then each doc's new changes are accepted
    /// only if a signed event from a trusted device vouches for every one.
    ///
    /// `members` is the sender's membership for it, merged in first. It must
    /// name the same owner as any copy already here, or nothing is imported.
    pub fn import(
        root_dir: &Path,
        wb: &WorkspaceBundle,
        members: Option<&Members>,
        trusted: &dyn Fn(&str, i64, &str) -> bool,
        device: &str,
    ) -> Result<WorkspaceImport> {
        validate_id(&wb.id)?;
        let dir = root_dir.join(&wb.id);
        let created = !dir.join("events.db").exists();
        if let (false, Some(m)) = (created, members) {
            // Refuse before touching anything if the owners disagree.
            if let Some(local) = Members::load(&dir.join("members.json"))? {
                if local.owner != m.owner {
                    return Err(CoreError::Invalid(format!(
                        "refused workspace {}: it names a different owner than your copy",
                        wb.name
                    )));
                }
            }
        }
        if created {
            fs::create_dir_all(&dir)?;
        }
        let result = Self::import_into(&dir, wb, members, trusted, device, created);
        if created && result.is_err() {
            // Nothing usable was written: leave no folder that would make the
            // workspace list fail for everything.
            let _ = fs::remove_dir_all(&dir);
        }
        result
    }

    fn import_into(
        dir: &Path,
        wb: &WorkspaceBundle,
        members: Option<&Members>,
        trusted: &dyn Fn(&str, i64, &str) -> bool,
        device: &str,
        created: bool,
    ) -> Result<WorkspaceImport> {
        let mut ws = Self::open_dir(&wb.id, dir.to_path_buf())?;
        let mut report = WorkspaceImport { id: wb.id.clone(), created, ..Default::default() };
        if let Some(m) = members {
            report.members_changed = ws.merge_members(m)?;
        }

        let events = ws.log.import(&wb.events, trusted)?;
        report.events_added = events.added;
        report.events_rejected = events.rejected;
        report.untrusted = events.untrusted;
        report.problems = events.problems;

        let attested = ws.log.attested(trusted)?;
        let ts = now_ms();
        // The manifest first: indexing items relies on the tree being in place.
        let mut docs: Vec<&DocBundle> = wb.docs.iter().collect();
        docs.sort_by_key(|d| d.kind != MANIFEST);
        for d in docs {
            let kind_ok = d.kind == MANIFEST || d.kind == PRIVATE || ITEM_KINDS.contains(&d.kind.as_str());
            if validate_id(&d.id).is_err() || !kind_ok || (d.kind == MANIFEST) != (d.id == MANIFEST) || (d.kind == PRIVATE) != is_private_doc(&d.id) {
                report.problems.push(format!("skipped an unrecognized doc ({})", d.kind));
                continue;
            }
            if let Some(existing) = ws.index.doc_kind(&d.id)? {
                if existing != d.kind {
                    report.problems.push(format!("skipped doc {}: it's a {existing} here", d.id));
                    continue;
                }
            }
            let incoming = match d.changes_missing_from(ws.docs.peek(&d.id)?) {
                Ok(changes) => changes,
                Err(e) => {
                    report.problems.push(format!("couldn't read doc {}: {e}", d.id));
                    continue;
                }
            };
            let is_manifest = d.kind == MANIFEST;
            // Workspaces made before creation events listed their heads have
            // no vouched-for first layout change. Only while this copy has no
            // layout at all is a root change taken on the creation event's
            // word; once there is one, every change needs a signed event, or
            // any member could put a whole new tree at the root.
            let legacy_root = is_manifest && attested.legacy_create && ws.docs.peek(&d.id)?.is_none();
            let accept = |c: &automerge::Change| {
                attested.hashes.contains(&c.hash().to_string()) || (legacy_root && c.deps().is_empty())
            };
            let imported = match ws.docs.import_changes(&d.id, incoming, accept) {
                Ok(r) => r,
                Err(e) => {
                    report.problems.push(e.to_string());
                    continue;
                }
            };
            let (n, refused) = imported;
            if n > 0 {
                ws.index.register_doc(&d.id, &d.kind)?;
                ws.reindex(&d.id, &d.kind, device, ts)?;
                report.docs_updated += 1;
                report.changes_added += n;
                report.changed_docs.push(d.id.clone());
            }
            if !refused.is_empty() {
                report.problems.push(format!(
                    "skipped changes to {}: {} change{} not signed by anyone allowed to edit",
                    if is_manifest { "the workspace layout".to_string() } else { format!("a {}", d.kind) },
                    refused.len(),
                    if refused.len() == 1 { " was" } else { "s were" },
                ));
            }
        }

        // A new workspace whose layout couldn't be accepted isn't usable; don't leave it behind.
        if created && !ws.docs.exists(MANIFEST)? {
            drop(ws);
            fs::remove_dir_all(&dir)?;
            report.problems.push("the workspace itself couldn't be verified, so it wasn't added".into());
            report.created = false;
            return Ok(report);
        }
        report.name = ws.name()?;
        Ok(report)
    }

    pub fn open(root_dir: &Path, id: &str) -> Result<Self> {
        validate_id(id)?;
        let dir = root_dir.join(id);
        if !dir.join("events.db").exists() {
            return Err(CoreError::NotFound(format!("workspace {id}")));
        }
        Self::open_dir(id, dir)
    }

    fn open_dir(id: &str, dir: PathBuf) -> Result<Self> {
        let members = Members::load(&dir.join("members.json"))?.filter(|m| m.workspace == id);
        Ok(Self {
            id: id.to_string(),
            docs: DocStore::open(&dir.join("docs"))?,
            index: Index::open(&dir.join("index.sqlite"))?,
            log: EventLog::open(&dir.join("events.db"))?,
            members,
            dir,
        })
    }

    // ---- membership -----------------------------------------------------------------

    pub fn members(&self) -> Option<&Members> {
        self.members.as_ref()
    }

    /// Membership, creating it with `own` as owner for a workspace that has
    /// none yet (one created on this device or by your own devices before
    /// sharing existed). Keeps your own identity in it current.
    pub fn ensure_members(&mut self, own: &IdentityState) -> Result<&Members> {
        let changed = match &mut self.members {
            None => {
                self.members = Some(Members::new(&self.id, own));
                true
            }
            Some(m) => m.learn_identity(own),
        };
        if changed {
            self.save_members()?;
        }
        Ok(self.members.as_ref().expect("set above"))
    }

    /// Fold in membership from someone else. Without a local copy yet, theirs
    /// is taken as is; the caller decides whether to trust it.
    pub fn merge_members(&mut self, incoming: &Members) -> Result<bool> {
        if incoming.workspace != self.id {
            return Err(CoreError::Invalid("membership is for a different workspace".into()));
        }
        let changed = match &mut self.members {
            None => {
                self.members = Some(incoming.clone().validated());
                true
            }
            Some(m) => m.merge(incoming)?,
        };
        if changed {
            self.save_members()?;
        }
        Ok(changed)
    }

    /// Fold in a member's latest identity (new devices, addresses). Saves only if it changed.
    pub fn learn_identity(&mut self, ids: &IdentityState) -> Result<bool> {
        let changed = self.members.as_mut().is_some_and(|m| m.learn_identity(ids));
        if changed {
            self.save_members()?;
        }
        Ok(changed)
    }

    /// Change membership with the owner's key, then save.
    pub fn update_members<T>(&mut self, f: impl FnOnce(&mut Members) -> Result<T>) -> Result<T> {
        let m = self.members.as_mut().ok_or_else(|| CoreError::Invalid("workspace has no membership yet".into()))?;
        let out = f(m)?;
        self.save_members()?;
        Ok(out)
    }

    fn save_members(&self) -> Result<()> {
        match &self.members {
            Some(m) => m.save(&self.dir.join("members.json")),
            None => Ok(()),
        }
    }

    /// Record something in the activity log that isn't a doc change, like a
    /// membership change.
    pub fn log_event(&mut self, key: &SigningKey, action: &str, target: &str, data: serde_json::Value) -> Result<Event> {
        validate_action(action)?;
        self.log.append(key, action, target, &data)
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn name(&self) -> Result<String> {
        Ok(self.index.meta("name")?.unwrap_or_else(|| "Untitled workspace".into()))
    }

    pub fn load_doc(&mut self, doc_id: &str) -> Result<Vec<u8>> {
        self.docs.save_bytes(doc_id)
    }

    pub fn create_doc(
        &mut self,
        key: &SigningKey,
        doc_id: &str,
        kind: &str,
        bytes: &[u8],
        action: &str,
    ) -> Result<Event> {
        validate_id(doc_id)?;
        validate_action(action)?;
        if !ITEM_KINDS.contains(&kind) && !(kind == PRIVATE && is_private_doc(doc_id)) {
            return Err(CoreError::Invalid(format!("doc kind {kind:?}")));
        }
        let heads: Vec<String> = self
            .docs
            .create(doc_id, bytes)?
            .get_heads()
            .iter()
            .map(|h| h.to_string())
            .collect();
        self.index.register_doc(doc_id, kind)?;
        let device = device_id(key);
        self.reindex(doc_id, kind, &device, now_ms())?;
        let title = self.title_of(doc_id)?;
        self.log.append(
            key,
            action,
            doc_id,
            &json!({ "doc": doc_id, "kind": kind, "heads": heads, "title": title }),
        )
    }

    /// `subject` is the entity the change is about when it differs from the doc
    /// (e.g. the folder a manifest change renamed). It becomes the event target.
    pub fn apply_change(
        &mut self,
        key: &SigningKey,
        doc_id: &str,
        change: Vec<u8>,
        action: &str,
        subject: Option<&str>,
    ) -> Result<Event> {
        validate_action(action)?;
        if let Some(s) = subject {
            validate_id(s)?;
        }
        let kind = self
            .index
            .doc_kind(doc_id)?
            .ok_or_else(|| CoreError::NotFound(format!("doc {doc_id}")))?;
        let target = subject.unwrap_or(doc_id).to_string();
        let title_before = self.title_of(&target)?;
        let hash = self.docs.apply_change(doc_id, change)?;
        let device = device_id(key);
        self.reindex(doc_id, &kind, &device, now_ms())?;
        // Keep a title in the log so deleted items stay readable in history.
        let title = self.title_of(&target)?.or(title_before);
        self.log.append(
            key,
            action,
            &target,
            &json!({ "doc": doc_id, "kind": kind, "change": hash, "title": title }),
        )
    }

    pub fn tree(&self) -> Result<Vec<TreeNode>> {
        self.index.tree()
    }

    pub fn query(&self, q: &ViewQuery) -> Result<Vec<ViewRow>> {
        self.index.query(q, now_ms())
    }

    pub fn links_of(&self, id: &str) -> Result<Links> {
        self.index.links_of(id)
    }

    pub fn notes_hub(&self) -> Result<Vec<HubRow>> {
        self.index.notes_hub()
    }

    pub fn events(&self, limit: u32, offset: u32) -> Result<Vec<Event>> {
        self.log.list(limit, offset)
    }

    pub fn verify_log(&self) -> Result<VerifyReport> {
        self.log.verify()
    }

    pub fn title_of(&self, id: &str) -> Result<Option<String>> {
        if id == self.id {
            return Ok(Some(self.name()?));
        }
        self.index.title_of(id)
    }

    fn reindex(&mut self, doc_id: &str, kind: &str, device: &str, ts: i64) -> Result<()> {
        let doc = self.docs.get(doc_id)?;
        let r = root();
        match kind {
            MANIFEST => {
                let name = get_string(doc, &r, "name")?.unwrap_or_default();
                let mut nodes = Vec::new();
                if let Some(map) = get_map(doc, &r, "nodes")? {
                    for id in automerge::ReadDoc::keys(doc, &map) {
                        let Some(node) = get_map(doc, &map, &id)? else { continue };
                        let Some(kind) = get_string(doc, &node, "kind")? else { continue };
                        nodes.push(NodeRecord {
                            title: if kind == "folder" { get_string(doc, &node, "title")? } else { None },
                            parent: get_string(doc, &node, "parent")?,
                            sort_key: get_string(doc, &node, "order")?.unwrap_or_default(),
                            kind,
                            id,
                        });
                    }
                }
                let mut views = Vec::new();
                if let Some(map) = get_map(doc, &r, "views")? {
                    for id in automerge::ReadDoc::keys(doc, &map) {
                        let Some(view) = get_map(doc, &map, &id)? else { continue };
                        let name = get_string(doc, &view, "name")?.unwrap_or_default();
                        views.push((id, name));
                    }
                }
                self.index.set_meta("name", &name)?;
                self.index.sync_tree(&nodes, device, ts)?;
                self.index.sync_views(&views, device, ts)?;
            }
            "note" | "whiteboard" | "tracker" => {
                let title = get_string(doc, &r, "title")?.unwrap_or_default();
                let tags = get_string_list(doc, &r, "tags")?;
                let summary = if kind == "note" {
                    get_string(doc, &r, "summary")?.unwrap_or_default()
                } else {
                    String::new()
                };
                let (body, links) = match kind {
                    // Notes link to anything: other items, tasks, and phases.
                    "note" => (
                        plain_text(&get_string(doc, &r, "body")?.unwrap_or_default()),
                        get_string_list(doc, &r, "links")?,
                    ),
                    // Whiteboards index the text on their shapes, the items their cards link
                    // to, and what the whiteboard itself is attached to.
                    "whiteboard" => {
                        let mut texts = Vec::new();
                        let mut links = get_string_list(doc, &r, "links")?;
                        if let Some(els) = get_map(doc, &r, "elements")? {
                            for key in automerge::ReadDoc::keys(doc, &els) {
                                let Some(el) = get_map(doc, &els, &key)? else { continue };
                                if let Some(t) = get_string(doc, &el, "text")?.filter(|t| !t.is_empty()) {
                                    texts.push(t);
                                }
                                if let Some(r) = get_string(doc, &el, "ref")?.filter(|r| !r.is_empty()) {
                                    links.push(r);
                                }
                            }
                        }
                        (texts.join("\n"), links)
                    }
                    _ => (String::new(), Vec::new()),
                };
                self.index.upsert_item(
                    &ItemRecord {
                        id: doc_id,
                        kind,
                        title: &title,
                        body: &body,
                        tags: &tags,
                        links: &links,
                        summary: &summary,
                    },
                    device,
                    ts,
                )?;
                if kind == "tracker" {
                    let tasks = read_tasks(doc, &r)?;
                    let phases: Vec<(String, String)> = read_phases(doc, &r)?.into_iter().collect();
                    self.index.sync_tasks(doc_id, &tasks, device, ts)?;
                    self.index.sync_phases(doc_id, &phases, device, ts)?;
                }
            }
            // Nothing to index: private docs are read whole by their owner.
            PRIVATE => {}
            other => return Err(CoreError::Invalid(format!("doc kind {other:?}"))),
        }
        Ok(())
    }
}

/// Phase id to name.
fn read_phases(doc: &automerge::Automerge, r: &automerge::ObjId) -> Result<std::collections::HashMap<String, String>> {
    let mut phases = std::collections::HashMap::new();
    if let Some(map) = get_map(doc, r, "phases")? {
        for id in automerge::ReadDoc::keys(doc, &map) {
            if let Some(phase) = get_map(doc, &map, &id)? {
                phases.insert(id, get_string(doc, &phase, "name")?.unwrap_or_default());
            }
        }
    }
    Ok(phases)
}

/// Read every task in a tracker doc, resolving column and phase ids to names.
fn read_tasks(doc: &automerge::Automerge, r: &automerge::ObjId) -> Result<Vec<TaskRecord>> {
    use std::collections::HashMap;
    let prefix = get_string(doc, r, "prefix")?.filter(|p| !p.is_empty()).unwrap_or_else(|| "DEFAULT".into());

    // A column's mode is its `category` (todo, doing, done), set in its settings.
    // Docs from before that only have `done` (done columns are done, the first is
    // to do, the rest in progress), or nothing (the last column is done).
    let mut ordered: Vec<(String, String, String, Option<bool>, Option<String>)> = Vec::new();
    for col in get_map_list(doc, r, "columns")? {
        if let Some(id) = get_string(doc, &col, "id")? {
            ordered.push((
                get_string(doc, &col, "order")?.unwrap_or_default(),
                id,
                get_string(doc, &col, "name")?.unwrap_or_default(),
                get_bool(doc, &col, "done")?,
                get_string(doc, &col, "category")?,
            ));
        }
    }
    ordered.sort();
    let n = ordered.len();
    let mut columns: HashMap<String, (String, String)> = HashMap::new();
    let mut first_column = None;
    for (i, (_, id, name, done, mode)) in ordered.into_iter().enumerate() {
        let category = match (mode.as_deref(), done) {
            (Some(c @ ("todo" | "doing" | "done")), _) => c,
            (_, Some(true)) => "done",
            (_, Some(false)) => if i == 0 { "todo" } else { "doing" },
            (_, None) => if i == n - 1 && i > 0 { "done" } else if i == 0 { "todo" } else { "doing" },
        };
        if i == 0 {
            first_column = Some(id.clone());
        }
        columns.insert(id, (name, category.to_string()));
    }
    let phases = read_phases(doc, r)?;

    let mut out = Vec::new();
    let Some(tasks) = get_map(doc, r, "tasks")? else { return Ok(out) };
    for id in automerge::ReadDoc::keys(doc, &tasks) {
        let Some(t) = get_map(doc, &tasks, &id)? else { continue };
        // Tasks in a deleted column show in the first one.
        let column = get_string(doc, &t, "column")?
            .filter(|c| columns.contains_key(c))
            .or_else(|| first_column.clone())
            .unwrap_or_default();
        let (status, category) = columns
            .get(&column)
            .cloned()
            .unwrap_or_else(|| (if column == "backlog" { "Backlog".into() } else { "".into() }, "todo".into()));
        // An archived task is done wherever it was, and off the board.
        let archived = get_bool(doc, &t, "archived")?.unwrap_or(false);
        let (status, category) = if archived { ("Archived".to_string(), "done".to_string()) } else { (status, category) };
        let phase = get_string(doc, &t, "phase")?.and_then(|p| phases.get(&p).cloned()).unwrap_or_default();
        let number = get_i64(doc, &t, "number")?.unwrap_or(0);
        let task_prefix = get_string(doc, &t, "prefix")?.filter(|p| !p.is_empty()).unwrap_or_else(|| prefix.clone());
        let mut props = vec![
            ("key", format!("{task_prefix}-{number}")),
            ("status", status),
            ("category", category),
            ("phase", phase),
        ];
        for key in ["assignee", "priority", "due"] {
            if let Some(v) = get_string(doc, &t, key)?.filter(|v| !v.is_empty()) {
                props.push((key, v));
            }
        }
        out.push(TaskRecord {
            parent: get_string(doc, &t, "parent")?.filter(|p| !p.is_empty()),
            title: get_string(doc, &t, "title")?.unwrap_or_default(),
            description: plain_text(&get_string(doc, &t, "description")?.unwrap_or_default()),
            tags: get_string_list(doc, &t, "tags")?,
            links: get_string_list(doc, &t, "links")?,
            created: get_i64(doc, &t, "created")?.unwrap_or(0),
            props,
            id,
        });
    }
    Ok(out)
}

/// The words of a note body for search: without inline HTML, macro fences
/// (`:::panel {type="info"}`, `:::`), or image sources (an image keeps its alt text).
fn plain_text(markdown: &str) -> String {
    let lines: Vec<String> = markdown
        .lines()
        .filter(|l| !l.trim_start().starts_with(":::"))
        .map(drop_image_sources)
        .collect();
    strip_tags(&lines.join("\n"))
}

/// `![alt](src)` becomes `alt`.
fn drop_image_sources(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("![") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("](").and_then(|mid| after[mid..].find(')').map(|end| (mid, mid + end))) {
            Some((mid, end)) => {
                out.push_str(&after[..mid]);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("![");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Drop inline HTML tags (used for colored text) so search indexes only the words.
fn strip_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        // A tag starts with `<` followed by a letter or `/`; anything else is literal.
        if c == '<' && chars.peek().is_some_and(|n| n.is_ascii_alphabetic() || *n == '/') {
            for n in chars.by_ref() {
                if n == '>' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn device_id(key: &SigningKey) -> String {
    hex::encode(key.verifying_key().to_bytes())
}

fn validate_action(action: &str) -> Result<()> {
    let ok = action.len() <= 48
        && action.split_once('.').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && action.chars().all(|c| c.is_ascii_lowercase() || c == '.' || c == '_')
        });
    if ok {
        Ok(())
    } else {
        Err(CoreError::Invalid(format!("action {action:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::{plain_text, strip_tags};

    #[test]
    fn plain_text_drops_macros_and_image_sources() {
        let md = ":::panel {type=\"info\"}\nHeads up\n:::\n\n![Diagram](att:0193) and ![x\n:::children\n";
        assert_eq!(plain_text(md), "Heads up\n\nDiagram and ![x");
    }

    #[test]
    fn strips_inline_html_only() {
        assert_eq!(strip_tags(r#"a <span style="color: #e03131">red</span> word"#), "a red word");
        assert_eq!(strip_tags("if a < b then"), "if a < b then");
        assert_eq!(strip_tags("<mark data-color=\"#fff3bf\">hi</mark>"), "hi");
    }
}
