# Builds everything-find in release mode and copies the exe into the plugin folder.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

cargo build --release -p everything-find --manifest-path (Join-Path $repo 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }

$bin = Join-Path $repo 'plugins\everything-find\bin'
New-Item -ItemType Directory -Force $bin | Out-Null
$exe = Join-Path $bin 'everything-find.exe'
# Open Claude Code sessions run this exe and lock it; Windows allows renaming a
# running exe, so move it aside. Stale .old copies go once their sessions end.
Get-ChildItem $bin -Filter '*.old' | Remove-Item -ErrorAction SilentlyContinue
if (Test-Path $exe) {
    Move-Item $exe "$exe.$(Get-Date -Format 'yyyyMMddHHmmss').old"
}
Copy-Item (Join-Path $repo 'target\release\everything-find.exe') $bin
Write-Host "Copied everything-find.exe to $bin"
