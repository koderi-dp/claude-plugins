use std::fmt;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

const MAX_BYTES: usize = 4096;

/// A password read from a file. Never printed; zeroized on drop. Remembers the file it came from,
/// so error messages can name it.
pub struct Secret {
    text: Zeroizing<String>,
    source: PathBuf,
}

impl Secret {
    pub fn from_file(path: &Path) -> Result<Secret, String> {
        let shown = path.display();
        let bytes = Zeroizing::new(std::fs::read(path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("{shown}: not found"),
            _ => format!("{shown}: cannot read ({})", e.kind()),
        })?);
        if bytes.len() > MAX_BYTES {
            return Err(format!(
                "{shown}: file is larger than 4 KB, expected a file holding only the password"
            ));
        }
        let mut text =
            decode(&bytes).ok_or_else(|| format!("{shown}: is not UTF-8 or UTF-16 text"))?;
        if text.ends_with("\r\n") {
            let n = text.len() - 2;
            text.truncate(n);
        } else if text.ends_with('\n') {
            let n = text.len() - 1;
            text.truncate(n);
        }
        if text.is_empty() {
            return Err(format!("{shown}: is empty"));
        }
        Ok(Secret {
            text,
            source: path.to_path_buf(),
        })
    }

    /// Returns the secret text. Used only by the SSH auth code.
    pub fn expose(&self) -> &str {
        &self.text
    }

    /// The file the secret was read from.
    pub fn source(&self) -> &Path {
        &self.source
    }

    /// Replaces every occurrence of the secret in `text` with `***`.
    pub fn mask(&self, text: &str) -> String {
        text.replace(self.expose(), "***")
    }
}

fn decode(bytes: &[u8]) -> Option<Zeroizing<String>> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(rest)
            .ok()
            .map(|s| Zeroizing::new(s.to_owned()));
    }
    let utf16 = |rest: &[u8], f: fn([u8; 2]) -> u16| -> Option<Zeroizing<String>> {
        if rest.len() % 2 != 0 {
            return None;
        }
        let units: Zeroizing<Vec<u16>> =
            Zeroizing::new(rest.chunks_exact(2).map(|c| f([c[0], c[1]])).collect());
        // A UTF-16 unit encodes to at most 3 UTF-8 bytes, so this never reallocates.
        let mut out = Zeroizing::new(String::with_capacity(units.len() * 3));
        for c in char::decode_utf16(units.iter().copied()) {
            out.push(c.ok()?);
        }
        Some(out)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, u16::from_be_bytes);
    }
    std::str::from_utf8(bytes)
        .ok()
        .map(|s| Zeroizing::new(s.to_owned()))
}

/// Masks several secrets, longest first so a secret containing another is hidden whole.
pub fn mask_all(secrets: &[&Secret], text: &str) -> String {
    let mut sorted: Vec<&Secret> = secrets.to_vec();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.expose().len()));
    sorted.iter().fold(text.to_owned(), |acc, s| s.mask(&acc))
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("pw.txt");
        std::fs::write(&p, bytes).unwrap();
        (d, p)
    }

    #[test]
    fn trims_one_trailing_newline() {
        let (_d, p) = write(b"pw\r\n");
        assert_eq!(Secret::from_file(&p).unwrap().expose(), "pw");
        let (_d, p) = write(b"pw\n\n");
        assert_eq!(Secret::from_file(&p).unwrap().expose(), "pw\n");
    }

    #[test]
    fn remembers_source_path() {
        let (_d, p) = write(b"pw");
        assert_eq!(Secret::from_file(&p).unwrap().source(), p.as_path());
    }

    #[test]
    fn strips_utf8_bom() {
        let (_d, p) = write(b"\xEF\xBB\xBFpw");
        assert_eq!(Secret::from_file(&p).unwrap().expose(), "pw");
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        let mut b = vec![0xFF, 0xFE];
        for u in "pw\r\n".encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        let (_d, p) = write(&b);
        assert_eq!(Secret::from_file(&p).unwrap().expose(), "pw");
    }

    #[test]
    fn utf16le_non_ascii_round_trips() {
        let pw = "p\u{e4}ssw\u{f6}rd\u{20ac}";
        let mut b = vec![0xFF, 0xFE];
        for u in format!("{pw}\r\n").encode_utf16() {
            b.extend_from_slice(&u.to_le_bytes());
        }
        let (_d, p) = write(&b);
        assert_eq!(Secret::from_file(&p).unwrap().expose(), pw);
    }

    #[test]
    fn refuses_empty() {
        let (_d, p) = write(b"");
        let e = Secret::from_file(&p).unwrap_err();
        assert!(
            e.contains(&p.display().to_string()) && e.contains("is empty"),
            "{e}"
        );
    }

    #[test]
    fn refuses_over_4kb() {
        let (_d, p) = write(&vec![b'a'; 5000]);
        let e = Secret::from_file(&p).unwrap_err();
        assert!(
            e.contains("expected a file holding only the password"),
            "{e}"
        );
    }

    #[test]
    fn missing_file() {
        let d = tempfile::tempdir().unwrap();
        let e = Secret::from_file(&d.path().join("nope")).unwrap_err();
        assert!(e.contains("not found"), "{e}");
    }

    #[test]
    fn debug_hides() {
        let (_d, p) = write(b"pw");
        let s = Secret::from_file(&p).unwrap();
        assert_eq!(format!("{:?}", s), "***");
        assert_eq!(format!("{}", s), "***");
    }

    #[test]
    fn masks_every_copy() {
        let (_d, p) = write(b"pw");
        let s = Secret::from_file(&p).unwrap();
        assert_eq!(s.mask("a pw b pwpw"), "a *** b ******");
    }

    #[test]
    fn mask_all_longest_first() {
        let (_d, p1) = write(b"pw");
        let a = Secret::from_file(&p1).unwrap();
        let (_d2, p2) = write(b"pw123");
        let b = Secret::from_file(&p2).unwrap();
        assert_eq!(mask_all(&[&a, &b], "pw123 pw"), "*** ***");
    }
}
