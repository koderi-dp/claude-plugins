//! FFI to the vendored Everything SDK (compiled in by build.rs). The only module
//! that touches `unsafe`.

use crate::pipeline::{Entry, SdkError, SearchOpts, SearchPage, Searcher, SortKey, Status};
use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::sync::Mutex;

/// Wide-char buffer for result paths; covers the Windows long-path maximum.
pub const PATH_BUF_WCHARS: usize = 32_768;

const SORT_NAME_ASCENDING: u32 = 1;
const SORT_SIZE_DESCENDING: u32 = 6;
const SORT_DATE_MODIFIED_DESCENDING: u32 = 14;

const REQUEST_FULL_PATH_AND_FILE_NAME: u32 = 0x0000_0004;
const REQUEST_SIZE: u32 = 0x0000_0010;
const REQUEST_DATE_MODIFIED: u32 = 0x0000_0040;

const ERROR_IPC: u32 = 2;

/// 100ns intervals between 1601-01-01 and 1970-01-01.
const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;

#[repr(C)]
#[derive(Default)]
struct FileTime {
    low: u32,
    high: u32,
}

unsafe extern "system" {
    fn Everything_SetSearchW(search: *const u16);
    fn Everything_SetRequestFlags(flags: u32);
    fn Everything_SetSort(sort: u32);
    fn Everything_SetOffset(offset: u32);
    fn Everything_SetMax(max: u32);
    fn Everything_QueryW(wait: i32) -> i32;
    fn Everything_GetLastError() -> u32;
    fn Everything_GetNumResults() -> u32;
    fn Everything_GetTotResults() -> u32;
    fn Everything_IsFolderResult(index: u32) -> i32;
    fn Everything_GetResultFullPathNameW(index: u32, buf: *mut u16, buf_len: u32) -> u32;
    fn Everything_GetResultSize(index: u32, size: *mut i64) -> i32;
    fn Everything_GetResultDateModified(index: u32, ft: *mut FileTime) -> i32;
    fn Everything_IsDBLoaded() -> i32;
    fn Everything_GetMajorVersion() -> u32;
}

/// The SDK keeps global state, so every call sequence is serialized.
static LOCK: Mutex<()> = Mutex::new(());

pub fn filetime_to_unix(ft: u64) -> Option<i64> {
    if ft == 0 || ft < FILETIME_UNIX_EPOCH {
        return None;
    }
    Some(((ft - FILETIME_UNIX_EPOCH) / 10_000_000) as i64)
}

fn sort_code(sort: SortKey) -> u32 {
    match sort {
        SortKey::Name => SORT_NAME_ASCENDING,
        SortKey::Modified => SORT_DATE_MODIFIED_DESCENDING,
        SortKey::Size => SORT_SIZE_DESCENDING,
    }
}

pub struct EverythingSdk;

impl Searcher for EverythingSdk {
    fn search(&self, query: &str, opts: &SearchOpts) -> Result<SearchPage, SdkError> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let wide: Vec<u16> = std::ffi::OsStr::new(query).encode_wide().chain([0]).collect();
        let mut flags = REQUEST_FULL_PATH_AND_FILE_NAME;
        if opts.want_details {
            flags |= REQUEST_SIZE | REQUEST_DATE_MODIFIED;
        }
        // SAFETY: plain C calls; `wide` is NUL-terminated and outlives the query.
        unsafe {
            Everything_SetSearchW(wide.as_ptr());
            Everything_SetRequestFlags(flags);
            Everything_SetSort(sort_code(opts.sort));
            Everything_SetOffset(opts.offset);
            Everything_SetMax(opts.max);
            if Everything_QueryW(1) == 0 {
                return Err(match Everything_GetLastError() {
                    ERROR_IPC => SdkError::NotRunning,
                    code => SdkError::Rejected(format!("Everything error code {code}")),
                });
            }
            let n = Everything_GetNumResults();
            let total = Everything_GetTotResults();
            let mut buf = vec![0u16; PATH_BUF_WCHARS];
            let mut entries = Vec::with_capacity(n as usize);
            for i in 0..n {
                let len = Everything_GetResultFullPathNameW(i, buf.as_mut_ptr(), buf.len() as u32);
                let full_path = PathBuf::from(OsString::from_wide(&buf[..len as usize]));
                let is_dir = Everything_IsFolderResult(i) != 0;
                let (mut size, mut modified) = (None, None);
                if opts.want_details {
                    let mut s: i64 = 0;
                    if !is_dir && Everything_GetResultSize(i, &mut s) != 0 && s >= 0 {
                        size = Some(s as u64);
                    }
                    let mut ft = FileTime::default();
                    if Everything_GetResultDateModified(i, &mut ft) != 0 {
                        modified = filetime_to_unix(((ft.high as u64) << 32) | ft.low as u64);
                    }
                }
                entries.push(Entry { full_path, is_dir, size, modified });
            }
            Ok(SearchPage { entries, total })
        }
    }

    fn status(&self) -> Status {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: argument-less C calls.
        unsafe {
            Status {
                running: Everything_GetMajorVersion() != 0,
                db_loaded: Everything_IsDBLoaded() != 0,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetime_epoch() {
        assert_eq!(filetime_to_unix(116_444_736_000_000_000), Some(0));
    }

    #[test]
    fn filetime_known() {
        assert_eq!(filetime_to_unix(133_000_000_000_000_000), Some(1_655_526_400));
    }

    #[test]
    fn filetime_zero_is_none() {
        assert_eq!(filetime_to_unix(0), None);
    }

    #[test]
    fn result_buffer_fits_long_paths() {
        assert_eq!(PATH_BUF_WCHARS, 32_768);
    }
}
