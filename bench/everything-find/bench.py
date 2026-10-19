"""Benchmark Claude Code's Glob tool against everything-find's `find`.

    python -I bench/everything-find/bench.py [--no-glob] [--exe PATH] [--runs N] [REPO ...]

Glob: one headless `claude -p` session per repo calls Glob for every pattern RUNS
times; timings are Glob's own reported `durationMs`. This costs a small model
session per repo, so `--no-glob` skips it.
find: driven directly over MCP stdio; wall-clock per call, median of RUNS.
Also prints a per-stage profile of `find` (filtering vs scoping vs raw IPC).
Results land in bench/everything-find/results/ (gitignored).
"""
import argparse, datetime, json, os, re, statistics, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_EXE = os.path.join(ROOT, "target", "release", "everything-find.exe")
NOISE = re.compile(r"[\\/](bin|obj|node_modules|\.git|target|worktrees)[\\/]", re.I)

# (label, Glob pattern, find query). Cases with no matches in a repo are dropped.
CASES = [
    ("all *.rs", "**/*.rs", "*.rs"),
    ("all *.cs", "**/*.cs", "*.cs"),
    ("all *.ts", "**/*.ts", "*.ts"),
    ("all *.json", "**/*.json", "*.json"),
    ("package.json", "**/package.json", "package.json"),
    ("Cargo.toml", "**/Cargo.toml", "Cargo.toml"),
    ("Dockerfile*", "**/Dockerfile*", "Dockerfile*"),
]


def tokens(chars):  # rough: ~4 characters per token for path lists
    return round(chars / 4)


class Mcp:
    def __init__(self, exe, cwd):
        self.p = subprocess.Popen([exe], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        self.n = 0
        self.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                 "clientInfo": {"name": "bench", "version": "0"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def call(self, method, params):
        self.n += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def find(self, args):
        t = time.perf_counter()
        r = self.call("tools/call", {"name": "find", "arguments": args})
        return (time.perf_counter() - t) * 1000, r["result"]["content"][0]["text"]

    def close(self):
        self.p.kill()


def parse_find(text):
    head = next((l for l in text.splitlines() if "match" in l), "")
    if head.startswith("0 matches") or not head:
        return 0, 0, 0
    total = int(re.search(r"(\d+) match", head).group(1))
    m = re.search(r"showing (\d+)", head)
    noise = sum(1 for l in text.splitlines() if NOISE.search("/" + l.strip()))
    return (int(m.group(1)) if m else 0), total, noise


def run_glob(repo, cases, runs):
    patterns = [g for _, g, _ in cases] * runs
    prompt = ("Call the Glob tool once for each of these patterns, in this exact order, one call per "
              "message, with no path argument and nothing else: " + ", ".join(f"'{p}'" for p in patterns)
              + ". Then reply 'done'.")
    p = subprocess.run(["claude", "-p", prompt, "--model", "haiku", "--output-format", "stream-json", "--verbose"],
                       cwd=repo, capture_output=True, text=True, encoding="utf-8", timeout=1800)
    calls = {}
    for line in p.stdout.splitlines():
        e = json.loads(line)
        if e.get("type") == "assistant":
            for c in e["message"]["content"]:
                if c.get("type") == "tool_use" and c["name"] == "Glob":
                    calls[c["id"]] = {"pattern": c["input"].get("pattern")}
        if e.get("type") == "user" and isinstance(e.get("tool_use_result"), dict):
            c = e["message"]["content"][0]
            if c.get("tool_use_id") in calls:
                r = e["tool_use_result"]
                text = c["content"] if isinstance(c["content"], str) else json.dumps(c["content"])
                calls[c["tool_use_id"]].update(
                    ms=r.get("durationMs"), shown=r.get("numFiles"), total=r.get("totalMatches"),
                    chars=len(text), noise=sum(1 for f in r.get("filenames", []) if NOISE.search(f)))
    out = {}
    for v in calls.values():
        if "ms" in v:
            out.setdefault(v["pattern"], []).append(v)
    return out


def profile(mcp, runs):
    variants = [
        ("repo scope + .gitignore filter", {"query": "*.json", "limit": 100}),
        ("repo scope, include_ignored", {"query": "*.json", "limit": 100, "include_ignored": True}),
        ("all drives, count_only (raw IPC)", {"query": "*.json", "scope": "all", "count_only": True}),
    ]
    rows = []
    for name, args in variants:
        times = [mcp.find(args)[0] for _ in range(max(runs, 5))]
        rows.append((name, round(statistics.median(times), 1), round(min(times), 1)))
    return rows


def bench_repo(repo, exe, runs, with_glob):
    mcp = Mcp(exe, repo)
    mcp.find({"query": "zz-warmup-nothing"})
    cases = []
    for label, gpat, fq in CASES:
        f_runs = [mcp.find({"query": fq, "limit": 100}) for _ in range(runs)]
        shown, total, noise = parse_find(f_runs[0][1])
        cases.append({"case": label, "glob_pattern": gpat, "find_query": fq,
                      "find_ms": round(statistics.median(x[0] for x in f_runs), 1), "find_shown": shown,
                      "find_total": total, "find_chars": len(f_runs[0][1]), "find_noise": noise})
    prof = profile(mcp, runs)
    mcp.close()
    if with_glob:
        glob = run_glob(repo, cases, runs)
        for c in cases:
            g = glob.get(c["glob_pattern"], [])
            if g:
                c.update(glob_ms=statistics.median(x["ms"] for x in g), glob_shown=g[0]["shown"],
                         glob_total=g[0]["total"], glob_chars=g[0]["chars"], glob_noise=g[0]["noise"])
    # Drop cases with nothing to compare.
    cases = [c for c in cases if c["find_total"] or c.get("glob_total")]
    return {"cases": cases, "profile": prof}


def print_report(name, r, with_glob):
    print(f"\n### {name}")
    if with_glob:
        print("| search | Glob ms | find ms | Glob shown/total | find shown/total | Glob ~tok | find ~tok | Glob junk | find junk |")
        print("|---|---|---|---|---|---|---|---|---|")
        for c in r["cases"]:
            g = "glob_ms" in c
            glob_counts = f"{c['glob_shown']}/{c['glob_total']}" if g else "n/a"
            print(f"| {c['case']} | {c['glob_ms'] if g else 'n/a'} | {c['find_ms']} "
                  f"| {glob_counts} | {c['find_shown']}/{c['find_total']} | {tokens(c['glob_chars']) if g else 'n/a'} "
                  f"| {tokens(c['find_chars'])} | {c['glob_noise'] if g else 'n/a'} | {c['find_noise']} |")
    else:
        print("| search | find ms | find shown/total | find ~tok | find junk |")
        print("|---|---|---|---|---|")
        for c in r["cases"]:
            print(f"| {c['case']} | {c['find_ms']} | {c['find_shown']}/{c['find_total']} | {tokens(c['find_chars'])} | {c['find_noise']} |")
    print("\nfind stage profile (median / min ms):")
    for name_, med, mn in r["profile"]:
        print(f"- {name_}: {med} / {mn}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repos", nargs="*", default=[ROOT])
    ap.add_argument("--exe", default=DEFAULT_EXE)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--no-glob", action="store_true")
    a = ap.parse_args()
    a.exe = os.path.abspath(a.exe)  # the server starts in each repo, so a relative path would not resolve
    if not os.path.exists(a.exe):
        sys.exit(f"exe not found: {a.exe} (run `just release everything-find` or pass --exe)")
    report = {"exe": a.exe, "when": datetime.datetime.now().isoformat(timespec="seconds"), "repos": {}}
    for repo in a.repos:
        print(f"benchmarking {repo} ...", file=sys.stderr)
        report["repos"][repo] = bench_repo(os.path.abspath(repo), a.exe, a.runs, not a.no_glob)
    os.makedirs(os.path.join(HERE, "results"), exist_ok=True)
    out = os.path.join(HERE, "results", datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    for name, r in report["repos"].items():
        print_report(name, r, not a.no_glob)
    print(f"\nraw results: {out}")


if __name__ == "__main__":
    main()
