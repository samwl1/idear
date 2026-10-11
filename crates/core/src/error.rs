use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("automerge: {0}")]
    Automerge(#[from] automerge::AutomergeError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
