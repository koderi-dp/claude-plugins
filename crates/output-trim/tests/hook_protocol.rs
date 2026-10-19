//! Protocol tests that run the built binary.

mod filter {
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    struct Run {
        code: i32,
        stdout: String,
    }

    fn run_with(args: &[&str], input: &[u8]) -> Run {
        let mut child = Command::new(env!("CARGO_BIN_EXE_output-trim"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn output-trim");
        let mut stdin = child.stdin.take().unwrap();
        let data = input.to_vec();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
        let out = child.wait_with_output().expect("wait");
        writer.join().unwrap();
        Run {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8(out.stdout).expect("utf-8 stdout"),
        }
    }

    fn fixture(rule: &str, case: &str) -> Vec<u8> {
        let path: PathBuf = [
            env!("CARGO_MANIFEST_DIR"),
            "tests",
            "fixtures",
            rule,
            &format!("{case}.txt"),
        ]
        .iter()
        .collect();
        std::fs::read(path).expect("fixture")
    }

    #[test]
    fn filter_dotnet_fail_exit_1() {
        // The captured failure is under the pass-through threshold on its own,
        // so prefix it with restore noise to exercise the trimming path.
        let mut input = Vec::new();
        for i in 0..40 {
            input.extend_from_slice(
                format!("  Restored C:\\src\\Fx\\Pkg{i}\\Pkg{i}.csproj (in {i} ms).\n").as_bytes(),
            );
        }
        input.extend(fixture("dotnet", "test_fail"));
        let r = run_with(&[], &input);
        assert_eq!(r.code, 1, "{}", r.stdout);
        assert!(
            r.stdout.starts_with("[output-trim] dotnet test: FAILED"),
            "{}",
            r.stdout
        );
        let last = r.stdout.lines().last().unwrap();
        assert!(last.contains("full: "), "{}", r.stdout);
        let path = last.rsplit("full: ").next().unwrap();
        assert!(PathBuf::from(path).exists(), "{path}");
    }

    #[test]
    fn filter_cargo_pass_exit_0() {
        let r = run_with(&[], &fixture("cargo", "test_pass"));
        assert_eq!(r.code, 0, "{}", r.stdout);
        assert!(
            r.stdout.starts_with("[output-trim] cargo test: PASSED"),
            "{}",
            r.stdout
        );
    }

    #[test]
    fn filter_empty() {
        let r = run_with(&[], b"");
        assert_eq!(r.code, 0);
        assert_eq!(r.stdout, "");
    }

    #[test]
    fn filter_small_passthrough() {
        let r = run_with(&[], b"hello\n");
        assert_eq!(r.code, 0);
        assert_eq!(r.stdout, "hello\n");
    }

    #[test]
    fn filter_ignores_args() {
        let r = run_with(&["--whatever"], b"hello\n");
        assert_eq!(r.code, 0);
        assert_eq!(r.stdout, "hello\n");
    }
}
