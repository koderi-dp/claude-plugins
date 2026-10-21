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

# Tests against the ssh-remote test server (just ssh-test-server), then a running Everything instance
test-live: test-live-ssh
    cargo test -p everything-find --test live -- --ignored

# ssh-remote's live tests alone, against the test server (just ssh-test-server)
test-live-ssh:
    cargo test -p ssh-remote --test live -- --ignored --test-threads=1

# Start the OpenSSH test containers for ssh-remote's live tests: tester on 2222, other on 2223 (secrets in target/ssh-test)
[script('pwsh', '-NoLogo', '-NoProfile')]
ssh-test-server:
    $ErrorActionPreference = 'Stop'
    $dir = Join-Path '{{justfile_directory()}}' 'target\ssh-test'
    $pub = Join-Path $dir 'pub'
    New-Item -ItemType Directory -Force $pub | Out-Null
    $pw = Join-Path $dir 'pw.txt'
    $pass = Join-Path $dir 'id_enc.pass'
    # Test-only secrets, generated once so reruns keep working with existing files. When any
    # is (re)generated, an existing container holds stale credentials and is recreated below.
    $generated = $false
    if (-not (Test-Path $pw)) { Set-Content $pw ([guid]::NewGuid().ToString('N')) -NoNewline; $generated = $true }
    $plain = Join-Path $dir 'id_ed25519'
    $enc = Join-Path $dir 'id_enc'
    if (-not (Test-Path $pass)) {
        Set-Content $pass ([guid]::NewGuid().ToString('N')) -NoNewline
        # A new passphrase needs a new encrypted key.
        Remove-Item $enc, "$enc.pub" -ErrorAction SilentlyContinue
        $generated = $true
    }
    if (-not (Test-Path $plain)) {
        Remove-Item "$plain.pub" -ErrorAction SilentlyContinue
        ssh-keygen -q -t ed25519 -N '' -C ssh-remote-test -f $plain
        if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed for id_ed25519' }
        $generated = $true
    }
    if (-not (Test-Path $enc)) {
        Remove-Item "$enc.pub" -ErrorAction SilentlyContinue
        ssh-keygen -q -t ed25519 -N (Get-Content $pass -Raw) -C ssh-remote-test-enc -f $enc
        if ($LASTEXITCODE -ne 0) { throw 'ssh-keygen failed for id_enc' }
        $generated = $true
    }
    Copy-Item "$plain.pub", "$enc.pub" $pub -Force
    # Creates (or recreates when $regen) and starts one container, then waits for its banner.
    function Start-TestServer($name, $port, $user, $pwFile, $regen) {
        $state = docker container inspect -f '{{{{.State.Running}}' $name 2>$null
        $exists = $LASTEXITCODE -eq 0
        if ($exists -and $regen) {
            Write-Host "test credentials were regenerated; recreating $name"
            docker rm -f -v $name | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "docker rm $name failed" }
            $exists = $false
        }
        if (-not $exists) {
            docker run -d --name $name -p "${port}:2222" `
                -e USER_NAME=$user -e PASSWORD_ACCESS=true `
                -e USER_PASSWORD_FILE=/pw -v "${pwFile}:/pw:ro" `
                -e PUBLIC_KEY_DIR=/keys -v "${pub}:/keys:ro" `
                lscr.io/linuxserver/openssh-server:latest | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "docker run $name failed" }
        } elseif ($state -ne 'true') {
            docker start $name | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "docker start $name failed" }
        }
        # Docker's port proxy accepts TCP before sshd is up, so wait for the SSH banner.
        $deadline = (Get-Date).AddSeconds(60)
        while ($true) {
            try {
                $tcp = [System.Net.Sockets.TcpClient]::new()
                $tcp.Connect('127.0.0.1', $port)
                $tcp.ReceiveTimeout = 2000
                $line = [System.IO.StreamReader]::new($tcp.GetStream()).ReadLine()
                $tcp.Dispose()
                if ($line -like 'SSH-2.0-*') { break }
            } catch { }
            if ((Get-Date) -gt $deadline) { throw "ssh test server did not answer on 127.0.0.1:$port within 60 s" }
            Start-Sleep -Milliseconds 500
        }
        Write-Host "ssh test server ready on 127.0.0.1:$port (user $user)"
    }
    Start-TestServer 'ssh-remote-test' 2222 'tester' $pw $generated
    # A second user with its own password, for the pool's separate-entries test.
    $pwOther = Join-Path $dir 'pw-other.txt'
    $otherGenerated = $generated
    if (-not (Test-Path $pwOther)) { Set-Content $pwOther ([guid]::NewGuid().ToString('N')) -NoNewline; $otherGenerated = $true }
    Start-TestServer 'ssh-remote-test-other' 2223 'other' $pwOther $otherGenerated

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
