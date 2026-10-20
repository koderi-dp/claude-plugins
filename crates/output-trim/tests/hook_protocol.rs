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

mod hook {
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn run(args: &[&str], input: &[u8]) -> (i32, String) {
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
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8(out.stdout).expect("utf-8 stdout"),
        )
    }

    fn post_input(cmd: &str, stdout: &str) -> String {
        serde_json::json!({
            "session_id": "s-1", "hook_event_name": "PostToolUse", "tool_name": "Bash",
            "tool_input": {"command": cmd, "description": "d"},
            "tool_response": {"stdout": stdout, "stderr": "", "interrupted": false,
                "isImage": false, "noOutputExpected": false},
            "tool_use_id": "toolu_x", "duration_ms": 5
        })
        .to_string()
    }

    mod post {
        use super::*;

        #[test]
        fn trims_docker_logs() {
            let path = [
                env!("CARGO_MANIFEST_DIR"),
                "tests",
                "fixtures",
                "docker",
                "logs_repetitive.txt",
            ]
            .iter()
            .collect::<std::path::PathBuf>();
            let full = std::fs::read_to_string(path).unwrap();
            let (code, out) = run(
                &["hook", "post"],
                post_input("docker logs api", &full).as_bytes(),
            );
            assert_eq!(code, 0);
            let v: serde_json::Value = serde_json::from_str(&out).expect(&out);
            assert!(
                v["hookSpecificOutput"]["updatedToolOutput"]["stdout"]
                    .as_str()
                    .unwrap()
                    .starts_with("[output-trim] docker logs")
            );
        }

        #[test]
        fn bad_json_is_silent() {
            let (code, out) = run(&["hook", "post"], b"{not json");
            assert_eq!(code, 0);
            assert_eq!(out, "");
        }

        #[test]
        #[cfg_attr(debug_assertions, ignore)]
        fn noop_hook_is_fast() {
            let input = post_input("git status", "On branch main\n");
            let start = std::time::Instant::now();
            for _ in 0..20 {
                let (code, out) = run(&["hook", "post"], input.as_bytes());
                assert_eq!((code, out.as_str()), (0, ""));
            }
            let avg = start.elapsed() / 20;
            assert!(avg.as_millis() < 20, "average {avg:?}");
        }
    }

    mod session_start {
        use super::*;

        #[test]
        fn prints_note() {
            let (code, out) = run(&["hook", "session-start"], b"{}");
            assert_eq!(code, 0);
            let v: serde_json::Value = serde_json::from_str(&out).expect(&out);
            let ctx = v["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap();
            assert!(ctx.contains("| output-trim"), "{ctx}");
        }
    }
}
