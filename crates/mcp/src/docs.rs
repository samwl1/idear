//! Reading and writing the app's Automerge docs from Rust, in exactly the
//! shapes the app's frontend writes them: every string is collaborative text
//! (that's what the frontend's Automerge writes), numbers are integers, and
//! sort keys come from the same fractional-index scheme.

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ObjId, ObjType, ReadDoc, ScalarValue, Value, ROOT};
use notes_core::docs::{get_bool, get_i64, get_map, get_map_list, get_string, get_string_list};

pub type Res<T> = Result<T, String>;

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- writing --------------------------------------------------------------------------

pub fn put_text(doc: &mut AutoCommit, obj: &ObjId, key: &str, value: &str) -> Res<()> {
    let t = doc.put_object(obj, key, ObjType::Text).map_err(err)?;
    doc.splice_text(&t, 0, 0, value).map_err(err)?;
    Ok(())
}

/// Change a text field in place (a minimal edit, so it merges with concurrent edits).
pub fn set_text(doc: &mut AutoCommit, obj: &ObjId, key: &str, value: &str) -> Res<()> {
    match doc.get(obj, key).map_err(err)? {
        Some((Value::Object(ObjType::Text), id)) => doc.update_text(&id, value).map_err(err),
        _ => put_text(doc, obj, key, value),
    }
}

/// Add text at the end of a text field.
pub fn append_text(doc: &mut AutoCommit, obj: &ObjId, key: &str, value: &str) -> Res<()> {
    match doc.get(obj, key).map_err(err)? {
        Some((Value::Object(ObjType::Text), id)) => {
            let len = doc.length(&id);
            doc.splice_text(&id, len, 0, value).map_err(err)
        }
        _ => put_text(doc, obj, key, value),
    }
}

pub fn put_text_list(doc: &mut AutoCommit, obj: &ObjId, key: &str, values: &[String]) -> Res<()> {
    let list = doc.put_object(obj, key, ObjType::List).map_err(err)?;
    for (i, v) in values.iter().enumerate() {
        let t = doc.insert_object(&list, i, ObjType::Text).map_err(err)?;
        doc.splice_text(&t, 0, 0, v).map_err(err)?;
    }
    Ok(())
}

/// The bytes of the change just made, for `Workspace::apply_change`. Edits
/// must form one change: don't read through `document()` between writes, since
/// that commits midway.
pub fn last_change(doc: &mut AutoCommit) -> Res<Vec<u8>> {
    doc.commit();
    doc.get_last_local_change()
        .map(|c| c.raw_bytes().to_vec())
        .ok_or_else(|| "nothing changed".to_string())
}

/// A new note doc, as the app creates one.
pub fn new_note(title: &str, body: &str) -> Res<Vec<u8>> {
    let mut doc = AutoCommit::new();
    put_text(&mut doc, &ROOT, "title", title)?;
    doc.put_object(&ROOT, "tags", ObjType::List).map_err(err)?;
    put_text(&mut doc, &ROOT, "body", body)?;
    put_text(&mut doc, &ROOT, "summary", "")?;
    doc.put_object(&ROOT, "links", ObjType::List).map_err(err)?;
    Ok(doc.save())
}

/// Add a node to the manifest's tree, after its last sibling. Returns the change.
pub fn add_tree_node(manifest: &[u8], id: &str, kind: &str, parent: Option<&str>) -> Res<Vec<u8>> {
    let mut doc = AutoCommit::load(manifest).map_err(err)?;
    let nodes = match get_map(doc.document(), &ROOT, "nodes").map_err(err)? {
        Some(n) => n,
        None => doc.put_object(&ROOT, "nodes", ObjType::Map).map_err(err)?,
    };
    let mut last: Option<String> = None;
    for key in doc.keys(&nodes).collect::<Vec<_>>() {
        let Some(node) = get_map(doc.document(), &nodes, &key).map_err(err)? else { continue };
        let p = get_string(doc.document(), &node, "parent").map_err(err)?;
        if p.as_deref() == parent {
            if let Some(o) = get_string(doc.document(), &node, "order").map_err(err)? {
                if last.as_ref().is_none_or(|l| o > *l) {
                    last = Some(o);
                }
            }
        }
    }
    let node = doc.put_object(&nodes, id, ObjType::Map).map_err(err)?;
    put_text(&mut doc, &node, "kind", kind)?;
    match parent {
        Some(p) => put_text(&mut doc, &node, "parent", p)?,
        None => doc.put(&node, "parent", ScalarValue::Null).map_err(err)?,
    }
    put_text(&mut doc, &node, "order", &key_after(last.as_deref()))?;
    last_change(&mut doc)
}

// ---- fractional indexing ------------------------------------------------------------------

// A port of the `fractional-indexing` package the frontend uses, for keys
// after an existing one (base 62, integer part plus optional fraction).
const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn digit(c: u8) -> usize {
    DIGITS.iter().position(|d| *d == c).unwrap_or(0)
}

fn integer_len(head: u8) -> Option<usize> {
    match head {
        b'a'..=b'z' => Some((head - b'a') as usize + 2),
        b'A'..=b'Z' => Some((b'Z' - head) as usize + 2),
        _ => None,
    }
}

fn increment_integer(x: &[u8]) -> Option<Vec<u8>> {
    let head = x[0];
    let mut digs = x[1..].to_vec();
    let mut carry = true;
    for i in (0..digs.len()).rev() {
        if !carry {
            break;
        }
        let d = digit(digs[i]) + 1;
        if d == DIGITS.len() {
            digs[i] = DIGITS[0];
        } else {
            digs[i] = DIGITS[d];
            carry = false;
        }
    }
    let mut out;
    if carry {
        if head == b'Z' {
            return Some(vec![b'a', DIGITS[0]]);
        }
        if head == b'z' {
            return None;
        }
        let h = head + 1;
        if h > b'a' {
            digs.push(DIGITS[0]);
        } else {
            digs.pop();
        }
        out = vec![h];
    } else {
        out = vec![head];
    }
    out.extend(digs);
    Some(out)
}

/// `midpoint(a, null)`: a fraction after `a`.
fn midpoint_after(a: &[u8]) -> Vec<u8> {
    let da = if a.is_empty() { 0 } else { digit(a[0]) };
    if DIGITS.len() - da > 1 {
        vec![DIGITS[((da + DIGITS.len()) as f64 * 0.5).round() as usize]]
    } else {
        let mut v = vec![DIGITS[da]];
        v.extend(midpoint_after(&a[1..]));
        v
    }
}

/// `generateKeyBetween(a, null)`: a sort key after `a` (or the first key).
pub fn key_after(a: Option<&str>) -> String {
    let Some(a) = a.filter(|a| !a.is_empty()) else { return "a0".into() };
    let bytes = a.as_bytes();
    let Some(len) = integer_len(bytes[0]).filter(|l| *l <= bytes.len()) else {
        return format!("{a}V"); // not a key this scheme made; still sorts after it
    };
    let (int, frac) = bytes.split_at(len);
    let out = match increment_integer(int) {
        Some(next) => next,
        None => [int, &midpoint_after(frac)].concat(),
    };
    String::from_utf8(out).unwrap_or_else(|_| format!("{a}V"))
}

// ---- reading --------------------------------------------------------------------------

pub struct Column {
    pub id: String,
    pub name: String,
    pub done: bool,
    pub order: String,
}

pub struct Task {
    pub id: String,
    pub prefix: Option<String>,
    pub number: i64,
    pub title: String,
    pub description: String,
    pub column: String,
    pub order: String,
    pub assignee: String,
    pub priority: String,
    pub due: String,
    pub phase: String,
    pub parent: String,
    pub tags: Vec<String>,
}

pub struct Tracker {
    pub title: String,
    pub prefix: Option<String>,
    pub columns: Vec<Column>,
    pub phases: Vec<(String, String, String)>,
    pub tasks: Vec<Task>,
}

impl Tracker {
    pub fn read(doc: &automerge::Automerge) -> Res<Self> {
        let s = |obj: &ObjId, k: &str| get_string(doc, obj, k).map_err(err).map(Option::unwrap_or_default);
        let mut columns = Vec::new();
        for c in get_map_list(doc, &ROOT, "columns").map_err(err)? {
            columns.push(Column {
                id: s(&c, "id")?,
                name: s(&c, "name")?,
                done: get_bool(doc, &c, "done").map_err(err)?.unwrap_or(false),
                order: s(&c, "order")?,
            });
        }
        columns.sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
        // Older docs without a done flag treat the last column as done.
        if columns.len() > 1 && !columns.iter().any(|c| c.done) {
            if let Some(last) = columns.last_mut() {
                last.done = true;
            }
        }
        let mut phases = Vec::new();
        if let Some(p) = get_map(doc, &ROOT, "phases").map_err(err)? {
            for id in doc.keys(&p).collect::<Vec<_>>() {
                if let Some(ph) = get_map(doc, &p, &id).map_err(err)? {
                    phases.push((id.clone(), s(&ph, "name")?, s(&ph, "order")?));
                }
            }
        }
        phases.sort_by(|a, b| a.2.cmp(&b.2));
        let mut tasks = Vec::new();
        if let Some(t) = get_map(doc, &ROOT, "tasks").map_err(err)? {
            for id in doc.keys(&t).collect::<Vec<_>>() {
                let Some(task) = get_map(doc, &t, &id).map_err(err)? else { continue };
                tasks.push(Task {
                    prefix: get_string(doc, &task, "prefix").map_err(err)?.filter(|p| !p.is_empty()),
                    number: get_i64(doc, &task, "number").map_err(err)?.unwrap_or(0),
                    title: s(&task, "title")?,
                    description: s(&task, "description")?,
                    column: s(&task, "column")?,
                    order: s(&task, "order")?,
                    assignee: s(&task, "assignee")?,
                    priority: s(&task, "priority")?,
                    due: s(&task, "due")?,
                    phase: s(&task, "phase")?,
                    parent: s(&task, "parent")?,
                    tags: get_string_list(doc, &task, "tags").map_err(err)?,
                    id,
                });
            }
        }
        Ok(Self {
            title: s(&ROOT, "title")?,
            prefix: get_string(doc, &ROOT, "prefix").map_err(err)?.filter(|p| !p.is_empty()),
            columns,
            phases,
            tasks,
        })
    }

    /// The project's own key prefix: set on the project, else made from its title.
    pub fn default_prefix(&self) -> String {
        self.prefix.clone().unwrap_or_else(|| default_prefix(&self.title))
    }

    pub fn prefix_of(&self, t: &Task) -> String {
        t.prefix.clone().unwrap_or_else(|| self.default_prefix())
    }

    pub fn key(&self, t: &Task) -> String {
        format!("{}-{}", self.prefix_of(t), t.number)
    }

    /// The column a task shows in: its own, or the first if that column is gone.
    pub fn column_of(&self, t: &Task) -> Option<&Column> {
        self.columns.iter().find(|c| c.id == t.column).or(self.columns.first())
    }

    /// A task by id or key (e.g. "LAU-3"), case-insensitively.
    pub fn find(&self, task: &str) -> Option<&Task> {
        let t = task.trim();
        self.tasks.iter().find(|x| x.id == t || self.key(x).eq_ignore_ascii_case(t))
    }

    pub fn find_column(&self, name: &str) -> Option<&Column> {
        let n = name.trim();
        self.columns.iter().find(|c| c.id == n || c.name.trim().eq_ignore_ascii_case(n))
    }

    pub fn last_order_in(&self, column: &str, except: Option<&str>) -> Option<String> {
        self.tasks
            .iter()
            .filter(|t| self.column_of(t).is_some_and(|c| c.id == column) && Some(t.id.as_str()) != except)
            .map(|t| t.order.clone())
            .max()
    }

    pub fn next_number(&self, prefix: &str) -> i64 {
        self.tasks.iter().filter(|t| self.prefix_of(t) == prefix).map(|t| t.number).max().unwrap_or(0) + 1
    }
}

/// Same rule as the app: initials of up to four words, or the first three
/// letters of a single word, or TASK.
pub fn default_prefix(title: &str) -> String {
    let lower = title.trim_start().to_lowercase();
    let rest = if lower.starts_with("untitled ") { &title.trim_start()[9..] } else { title };
    let words: Vec<String> = rest
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect();
    match words.len() {
        0 => "TASK".into(),
        1 => words[0].chars().take(3).collect::<String>().to_uppercase(),
        _ => words.iter().take(4).filter_map(|w| w.chars().next()).collect::<String>().to_uppercase(),
    }
}

pub const PRIORITIES: &[&str] = &["none", "low", "medium", "high", "urgent"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_match_the_frontend_library() {
        // Values from fractional-indexing's own test suite.
        assert_eq!(key_after(None), "a0");
        assert_eq!(key_after(Some("a0")), "a1");
        assert_eq!(key_after(Some("a1")), "a2");
        assert_eq!(key_after(Some("az")), "b00");
        assert_eq!(key_after(Some("Zz")), "a0");
        assert_eq!(key_after(Some("a0V")), "a1");
        assert_eq!(key_after(Some("b1z")), "b20");
        assert_eq!(key_after(Some("zzzzzzzzzzzzzzzzzzzzzzzzzzz")), "zzzzzzzzzzzzzzzzzzzzzzzzzzzV");
    }

    #[test]
    fn prefixes_match_the_app() {
        assert_eq!(default_prefix("Launch"), "LAU");
        assert_eq!(default_prefix("Untitled project"), "PRO");
        assert_eq!(default_prefix("Home lab rebuild"), "HLR");
        assert_eq!(default_prefix("123"), "TASK");
    }
}
