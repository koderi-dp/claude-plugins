//! Stdin filter mode: `cmd 2>&1 | output-trim`.

use crate::engine::{self, LogTarget};
use crate::normalize::normalize;
use crate::rules::{self, Outcome};
use std::io::{self, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;

/// Input limit; anything beyond is drained and discarded.
pub const INPUT_LIMIT: u64 = 64 << 20;

/// Reads up to `INPUT_LIMIT` bytes. Returns the bytes and whether more remained.
/// The remainder is drained so the producer never blocks on a full pipe.
fn read_limited(input: &mut dyn Read) -> (Vec<u8>, bool) {
    let mut buf = Vec::new();
    let _ = input.take(INPUT_LIMIT).read_to_end(&mut buf);
    let truncated = if buf.len() as u64 >= INPUT_LIMIT {
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
    let (bytes, truncated) = read_limited(input);
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        let lines = normalize(&bytes);
        let rule = rules::by_content(&lines);
        engine::apply(&lines, rule, LogTarget::SaveIn(store_dir), truncated)
    }));
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
