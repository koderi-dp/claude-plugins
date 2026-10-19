//! Stdin filter mode: `cmd 2>&1 | output-trim`.

use crate::engine::{self, LogTarget, Output};
use crate::normalize::normalize;
use crate::rules::{self, Outcome};
use std::io::{self, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::Mutex;

/// Input limit; anything beyond is drained and discarded.
pub const INPUT_LIMIT: u64 = 64 << 20;

/// Serialises swapping of the process-wide panic hook.
static HOOK_LOCK: Mutex<()> = Mutex::new(());

/// Reads up to `limit` bytes. Returns the bytes and whether more remained.
/// The remainder is drained so the producer never blocks on a full pipe.
fn read_limited(input: &mut dyn Read, limit: u64) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let _ = input.take(limit).read_to_end(&mut buf);
    let truncated = if buf.len() as u64 >= limit {
        io::copy(input, &mut io::sink())
            .map(|n| n > 0)
            .unwrap_or(false)
    } else {
        false
    };
    (buf, truncated)
}

/// Writes ignoring errors (a closed pipe must not fail the pipeline).
fn write_quiet(out: &mut dyn Write, bytes: &[u8]) {
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

/// Returns the process exit code: 1 when the trimmed output is a failure.
pub fn run(input: &mut dyn Read, out: &mut dyn Write, store_dir: &Path) -> i32 {
    run_with_limit(input, out, store_dir, INPUT_LIMIT)
}

/// Like `run` with an explicit input limit in bytes.
pub fn run_with_limit(
    input: &mut dyn Read,
    out: &mut dyn Write,
    store_dir: &Path,
    limit: u64,
) -> i32 {
    run_inner(input, out, limit, |lines, truncated| {
        let rule = rules::by_content(lines);
        engine::apply(lines, rule, LogTarget::SaveIn(store_dir), truncated)
    })
}

/// Reads, normalizes and hands the lines to `process`; a panic in it falls
/// back to the raw input. The default panic message is suppressed meanwhile.
fn run_inner(
    input: &mut dyn Read,
    out: &mut dyn Write,
    limit: u64,
    process: impl FnOnce(&[String], bool) -> Output,
) -> i32 {
    let (bytes, truncated) = read_limited(input, limit);
    let result = {
        let _guard = HOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = panic::take_hook();
        panic::set_hook(Box::new(|_| {}));
        let r = panic::catch_unwind(AssertUnwindSafe(|| process(&normalize(&bytes), truncated)));
        panic::set_hook(previous);
        r
    };
    match result {
        Ok(o) => {
            if !o.text.is_empty() {
                write_quiet(out, o.text.as_bytes());
                write_quiet(out, b"\n");
            }
            i32::from(o.outcome == Outcome::Fail)
        }
        Err(_) => {
            write_quiet(out, String::from_utf8_lossy(&bytes).as_bytes());
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn over_limit_is_truncated_and_drained() {
        let mut c = Cursor::new(vec![b'a'; 25]);
        let (buf, truncated) = read_limited(&mut c, 10);
        assert_eq!(buf.len(), 10);
        assert!(truncated);
        assert_eq!(c.position(), 25);
    }

    #[test]
    fn exactly_at_limit_is_not_truncated() {
        let (buf, truncated) = read_limited(&mut Cursor::new(vec![b'a'; 10]), 10);
        assert_eq!(buf.len(), 10);
        assert!(!truncated);
    }

    #[test]
    fn under_limit_is_not_truncated() {
        let (buf, truncated) = read_limited(&mut Cursor::new(vec![b'a'; 9]), 10);
        assert_eq!(buf.len(), 9);
        assert!(!truncated);
    }

    #[test]
    fn truncated_input_gets_footer_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let input: String = (0..300)
            .map(|i| format!("line number {i} of noise\n"))
            .collect();
        assert!(input.len() > 2_000);
        let mut out = Vec::new();
        let code = run_with_limit(
            &mut Cursor::new(input.into_bytes()),
            &mut out,
            dir.path(),
            2_500,
        );
        let text = String::from_utf8(out).unwrap();
        assert_eq!(code, 0);
        assert!(text.contains("input truncated at 64 MB"), "{text}");
    }

    #[test]
    fn panic_falls_back_to_raw_input() {
        let mut out = Vec::new();
        let input = b"raw \xff text\n".to_vec();
        let code = run_inner(&mut Cursor::new(input), &mut out, INPUT_LIMIT, |_, _| {
            panic!("boom")
        });
        assert_eq!(code, 0);
        assert_eq!(out, "raw \u{FFFD} text\n".as_bytes());
    }
}
