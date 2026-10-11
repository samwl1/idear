//! Automerge document storage. One file per doc: `docs/<id>.am`.
//!
//! The frontend owns editing (editor bindings live there). It sends change
//! bytes here; this side applies them, persists, and reads fields back out for
//! the index. Rust is authoritative for what is stored and logged.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use automerge::{Automerge, Change, ObjId, ObjType, ReadDoc, Value, ROOT};

use crate::error::{CoreError, Result};

pub struct DocStore {
    dir: PathBuf,
    cache: HashMap<String, Automerge>,
}

impl DocStore {
    pub fn open(dir: &Path) -> Result<Self> {
        fs::create_dir_all(dir)?;
        Ok(Self { dir: dir.to_path_buf(), cache: HashMap::new() })
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        // Ids come from the frontend; never let one escape the docs directory.
        let valid = !id.is_empty()
            && id.len() <= 64
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid {
            return Err(CoreError::Invalid(format!("doc id {id:?}")));
        }
        Ok(self.dir.join(format!("{id}.am")))
    }

    pub fn exists(&self, id: &str) -> Result<bool> {
        Ok(self.path(id)?.exists())
    }

    /// Store a brand-new doc from its full saved bytes.
    pub fn create(&mut self, id: &str, bytes: &[u8]) -> Result<&Automerge> {
        let path = self.path(id)?;
        if path.exists() {
            return Err(CoreError::Invalid(format!("doc {id} already exists")));
        }
        let doc = Automerge::load(bytes)?;
        write_atomic(&path, &doc.save())?;
        self.cache.insert(id.to_string(), doc);
        Ok(&self.cache[id])
    }

    pub fn get(&mut self, id: &str) -> Result<&Automerge> {
        if !self.cache.contains_key(id) {
            let path = self.path(id)?;
            let bytes = fs::read(&path).map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => CoreError::NotFound(format!("doc {id}")),
                _ => e.into(),
            })?;
            self.cache.insert(id.to_string(), Automerge::load(&bytes)?);
        }
        Ok(&self.cache[id])
    }

    pub fn save_bytes(&mut self, id: &str) -> Result<Vec<u8>> {
        Ok(self.get(id)?.save())
    }

    /// Apply one change and persist. Returns the change hash.
    pub fn apply_change(&mut self, id: &str, change_bytes: Vec<u8>) -> Result<String> {
        let change = Change::from_bytes(change_bytes)
            .map_err(|e| CoreError::Invalid(format!("change bytes: {e}")))?;
        let hash = change.hash();
        self.get(id)?;
        let path = self.path(id)?;
        let doc = self.cache.get_mut(id).expect("loaded above");
        doc.apply_changes([change])?;
        if doc.get_change_by_hash(&hash).is_none() {
            // Automerge queues changes whose dependencies are missing. For a
            // local write that means the frontend and store have diverged.
            self.cache.remove(id);
            return Err(CoreError::Invalid(format!(
                "change {hash} depends on history this store doesn't have"
            )));
        }
        write_atomic(&path, &doc.save())?;
        Ok(hash.to_string())
    }
}

impl DocStore {
    /// The loaded doc, if it exists on disk.
    pub fn peek(&mut self, id: &str) -> Result<Option<&Automerge>> {
        if !self.exists(id)? {
            return Ok(None);
        }
        Ok(Some(self.get(id)?))
    }

    /// Add changes this store doesn't have yet. `accept` sees each one; if it
    /// refuses any, nothing is added. Creates the doc if it doesn't exist.
    /// Returns how many changes were added, or the refused hashes.
    pub fn import_changes(
        &mut self,
        id: &str,
        added: Vec<Change>,
        accept: impl Fn(&Change) -> bool,
    ) -> Result<(usize, Vec<String>)> {
        let mut doc = match self.peek(id)? {
            Some(d) => d.clone(),
            None => Automerge::new(),
        };
        // Keep the accepted changes whose history is here or also accepted;
        // a refused change takes anything built on it down with it.
        let mut kept_hashes = std::collections::HashSet::new();
        let mut kept = Vec::new();
        let mut refused = Vec::new();
        let mut pending: Vec<Change> = added;
        loop {
            let before = kept.len();
            let mut rest = Vec::new();
            for c in pending {
                let deps_ok = c.deps().iter().all(|d| kept_hashes.contains(d) || doc.get_change_by_hash(d).is_some());
                if !accept(&c) {
                    refused.push(c.hash().to_string());
                } else if deps_ok {
                    kept_hashes.insert(c.hash());
                    kept.push(c);
                } else {
                    rest.push(c);
                }
            }
            pending = rest;
            if pending.is_empty() || kept.len() == before {
                break;
            }
        }
        // Whatever's left depends on a refused or missing change.
        refused.extend(pending.iter().map(|c| c.hash().to_string()));
        if kept.is_empty() {
            return Ok((0, refused));
        }
        let hashes: Vec<_> = kept.iter().map(|c| c.hash()).collect();
        let path = self.path(id)?;
        doc.apply_changes(kept)?;
        if hashes.iter().any(|h| doc.get_change_by_hash(h).is_none()) {
            return Err(CoreError::Invalid(format!("doc {id}: some changes arrived without their history")));
        }
        write_atomic(&path, &doc.save())?;
        let count = hashes.len();
        self.cache.insert(id.to_string(), doc);
        Ok((count, refused))
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("am.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

// ---- Field extraction -------------------------------------------------------

/// Read a string whether it was written as collaborative text or a scalar.
pub fn get_string(doc: &Automerge, obj: &ObjId, key: &str) -> Result<Option<String>> {
    Ok(match doc.get(obj, key)? {
        Some((Value::Object(ObjType::Text), id)) => Some(doc.text(&id)?),
        Some((Value::Scalar(s), _)) => s.as_str().map(str::to_string),
        _ => None,
    })
}

pub fn get_string_list(doc: &Automerge, obj: &ObjId, key: &str) -> Result<Vec<String>> {
    let Some((Value::Object(ObjType::List), list)) = doc.get(obj, key)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for i in 0..doc.length(&list) {
        match doc.get(&list, i)? {
            Some((Value::Object(ObjType::Text), id)) => out.push(doc.text(&id)?),
            Some((Value::Scalar(s), _)) => {
                if let Some(s) = s.as_str() {
                    out.push(s.to_string())
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

pub fn get_i64(doc: &Automerge, obj: &ObjId, key: &str) -> Result<Option<i64>> {
    Ok(match doc.get(obj, key)? {
        Some((Value::Scalar(s), _)) => match s.as_ref() {
            automerge::ScalarValue::Int(n) => Some(*n),
            automerge::ScalarValue::Uint(n) => Some(*n as i64),
            automerge::ScalarValue::F64(n) => Some(*n as i64),
            automerge::ScalarValue::Timestamp(n) => Some(*n),
            _ => None,
        },
        _ => None,
    })
}

pub fn get_bool(doc: &Automerge, obj: &ObjId, key: &str) -> Result<Option<bool>> {
    Ok(match doc.get(obj, key)? {
        Some((Value::Scalar(s), _)) => match s.as_ref() {
            automerge::ScalarValue::Boolean(b) => Some(*b),
            _ => None,
        },
        _ => None,
    })
}

/// The maps inside a list, in order (e.g. a tracker's columns).
pub fn get_map_list(doc: &Automerge, obj: &ObjId, key: &str) -> Result<Vec<ObjId>> {
    let Some((Value::Object(ObjType::List), list)) = doc.get(obj, key)? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for i in 0..doc.length(&list) {
        if let Some((Value::Object(ObjType::Map), id)) = doc.get(&list, i)? {
            out.push(id);
        }
    }
    Ok(out)
}

pub fn get_map(doc: &Automerge, obj: &ObjId, key: &str) -> Result<Option<ObjId>> {
    Ok(match doc.get(obj, key)? {
        Some((Value::Object(ObjType::Map), id)) => Some(id),
        _ => None,
    })
}

pub fn root() -> ObjId {
    ROOT
}
