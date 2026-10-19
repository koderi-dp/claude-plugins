use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Name,
    Modified,
    Size,
}

#[derive(Debug, Clone)]
pub struct SearchOpts {
    pub sort: SortKey,
    pub offset: u32,
    pub max: u32,
    pub want_details: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub full_path: PathBuf,
    pub is_dir: bool,
    pub size: Option<u64>,
    /// Unix seconds.
    pub modified: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct SearchPage {
    pub entries: Vec<Entry>,
    pub total: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct Status {
    pub running: bool,
    pub db_loaded: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SdkError {
    NotRunning,
    Rejected(String),
}

pub trait Searcher: Send + Sync {
    fn search(&self, query: &str, opts: &SearchOpts) -> Result<SearchPage, SdkError>;
    fn status(&self) -> Status;
}
