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

# Tests against a running Everything instance
test-live:
    cargo test -p everything-find --test live -- --ignored

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
