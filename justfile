# Build, test and publish the plugins in this marketplace.
# Recipes take the plugin name; a plugin's crate in crates/ has the same name.

set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

marketplace := "code101-plugins"

# List recipes
default:
    @just --list

# Debug-build the whole workspace
build:
    cargo build --workspace

# Unit and protocol tests for the whole workspace
test:
    cargo test --workspace

# Tests against a running Everything instance and the ssh-remote test server (just ssh-test-server)
test-live:
    cargo test -p everything-find --test live -- --ignored
    cargo test -p ssh-remote --test live -- --ignored --test-threads=1

# Start the OpenSSH test container for ssh-remote's live tests (keys and password in target/ssh-test)
[script('pwsh', '-NoLogo', '-NoProfile')]
ssh-test-server:
    $ErrorActionPreference = 'Stop'
    $dir = Join-Path '{{justfile_directory()}}' 'target\ssh-test'
    $pub = Join-Path $dir 'pub'
    New-Item -ItemType Directory -Force $pub | Out-Null
    $pw = Join-Path $dir 'pw.txt'
    $pass = Join-Path $dir 'id_enc.pass'
    # Test-only secrets, generated once so reruns keep working with existing files.
    if (-not (Test-Path $pw)) { Set-Content $pw ([guid]::NewGuid().ToString('N')) -NoNewline }
    if (-not (Test-Path $pass)) { Set-Content $pass ([guid]::NewGuid().ToString('N')) -NoNewline }
    $plain = Join-Path $dir 'id_ed25519'
    $enc = Join-Path $dir 'id_enc'
    if (-not (Test-Path $plain)) {
        ssh-keygen -q -t ed25519 -N '' -C ssh-remote-test -f $plain
        if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed for id_ed25519' }
    }
    if (-not (Test-Path $enc)) {
        ssh-keygen -q -t ed25519 -N (Get-Content $pass -Raw) -C ssh-remote-test-enc -f $enc
        if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed for id_enc' }
    }
    Copy-Item "$plain.pub", "$enc.pub" $pub -Force
    $state = docker container inspect -f '{{{{.State.Running}}' ssh-remote-test 2>$null
    if ($LASTEXITCODE -ne 0) {
        docker run -d --name ssh-remote-test -p 2222:2222 `
            -e USER_NAME=tester -e PASSWORD_ACCESS=true `
            -e USER_PASSWORD_FILE=/pw -v "${pw}:/pw:ro" `
            -e PUBLIC_KEY_DIR=/keys -v "${pub}:/keys:ro" `
            lscr.io/linuxserver/openssh-server:latest | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
    } elseif ($state -ne 'true') {
        docker start ssh-remote-test | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'docker start failed' }
    }
    # Docker's port proxy accepts TCP before sshd is up, so wait for the SSH banner.
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
        try {
            $tcp = [System.Net.Sockets.TcpClient]::new()
            $tcp.Connect('127.0.0.1', 2222)
            $tcp.ReceiveTimeout = 2000
            $line = [System.IO.StreamReader]::new($tcp.GetStream()).ReadLine()
            $tcp.Dispose()
            if ($line -like 'SSH-2.0-*') { break }
        } catch { }
        if ((Get-Date) -gt $deadline) { throw 'ssh test server did not answer on 127.0.0.1:2222 within 60 s' }
        Start-Sleep -Milliseconds 500
    }
    Write-Host 'ssh test server ready on 127.0.0.1:2222 (user tester)'

# Remove and recreate the ssh-remote test container; it gets new host keys
[script('pwsh', '-NoLogo', '-NoProfile')]
ssh-test-server-reset:
    $ErrorActionPreference = 'Stop'
    docker rm -f -v ssh-remote-test 2>$null | Out-Null
    just --justfile (Join-Path '{{justfile_directory()}}' 'justfile') ssh-test-server
    if ($LASTEXITCODE -ne 0) { throw 'ssh-test-server failed' }

# Benchmark everything-find against Glob (one paid headless Claude session per repo). Repos default to this one.
bench *repos:
    cargo build --release -p everything-find
    python -I bench/everything-find/bench.py {{repos}}

# Benchmark everything-find only: fast, no Claude session
bench-find *repos:
    cargo build --release -p everything-find
    python -I bench/everything-find/bench.py --no-glob {{repos}}

# Release-build one plugin and copy its exe into plugins/<plugin>/bin
[script('pwsh', '-NoLogo', '-NoProfile')]
release plugin:
    $ErrorActionPreference = 'Stop'
    cargo build --release -p {{plugin}}
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
    $bin = Join-Path '{{justfile_directory()}}' 'plugins\{{plugin}}\bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    $exe = Join-Path $bin '{{plugin}}.exe'
    # Open Claude Code sessions may run this exe and lock it; Windows allows
    # renaming a running exe, so move it aside. Stale .old copies go next time.
    Get-ChildItem $bin -Filter '*.old' | Remove-Item -ErrorAction SilentlyContinue
    if (Test-Path $exe) { Move-Item $exe "$exe.$(Get-Date -Format 'yyyyMMddHHmmss').old" }
    Copy-Item (Join-Path '{{justfile_directory()}}' 'target\release\{{plugin}}.exe') $bin
    Write-Host "Released {{plugin}}.exe to $bin"

# Release every plugin that has a matching crate
[script('pwsh', '-NoLogo', '-NoProfile')]
release-all:
    $ErrorActionPreference = 'Stop'
    $root = '{{justfile_directory()}}'
    Get-ChildItem (Join-Path $root 'plugins') -Directory |
        Where-Object { Test-Path (Join-Path $root "crates\$($_.Name)\Cargo.toml") } |
        ForEach-Object {
            just --justfile (Join-Path $root 'justfile') release $_.Name
            if ($LASTEXITCODE -ne 0) { throw "release of $($_.Name) failed" }
        }

# Set a plugin's version in its Cargo.toml and plugin.json
[script('pwsh', '-NoLogo', '-NoProfile')]
bump plugin version:
    $ErrorActionPreference = 'Stop'
    if ('{{version}}' -notmatch '^\d+\.\d+\.\d+$') { throw "version must look like 1.2.3, got '{{version}}'" }
    $root = '{{justfile_directory()}}'
    $cargo = Join-Path $root 'crates\{{plugin}}\Cargo.toml'
    $manifest = Join-Path $root 'plugins\{{plugin}}\.claude-plugin\plugin.json'
    $text = Get-Content $cargo -Raw
    # Only the first `version = ` line: the [package] version, not a dependency's.
    $re = [regex]'(?m)^version = "[^"]*"'
    Set-Content $cargo ($re.Replace($text, 'version = "{{version}}"', 1)) -NoNewline
    $json = Get-Content $manifest -Raw
    Set-Content $manifest ($json -replace '"version":\s*"[^"]*"', '"version": "{{version}}"') -NoNewline
    Write-Host "{{plugin}} is now {{version}}"

# Bump, test, release, commit, tag and push one plugin, then update the local install
[script('pwsh', '-NoLogo', '-NoProfile')]
publish plugin version:
    $ErrorActionPreference = 'Stop'
    $j = Join-Path '{{justfile_directory()}}' 'justfile'
    if (git status --porcelain) { throw 'working tree is not clean; commit or stash first' }
    just --justfile $j bump {{plugin}} {{version}}
    if ($LASTEXITCODE -ne 0) { throw 'bump failed' }
    just --justfile $j test
    if ($LASTEXITCODE -ne 0) { throw 'tests failed; version bump left uncommitted' }
    just --justfile $j release {{plugin}}
    if ($LASTEXITCODE -ne 0) { throw 'release build failed' }
    git add -A
    git commit -m "release: {{plugin}} v{{version}}"
    # Annotated, so `git push --follow-tags` sends it.
    git tag -a "{{plugin}}-v{{version}}" -m "{{plugin}} v{{version}}"
    git push --follow-tags
    if ($LASTEXITCODE -ne 0) { throw 'push failed' }
    just --justfile $j update {{plugin}}

# Pull the latest marketplace from GitHub and update the installed plugin
update plugin:
    claude plugin marketplace update {{marketplace}}
    claude plugin update {{plugin}}@{{marketplace}}
