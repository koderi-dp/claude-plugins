# Builds everything-find in release mode and copies the exe into the plugin folder.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

cargo build --release -p everything-find --manifest-path (Join-Path $repo 'Cargo.toml')
if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }

$bin = Join-Path $repo 'plugins\everything-find\bin'
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item (Join-Path $repo 'target\release\everything-find.exe') $bin -Force
Write-Host "Copied everything-find.exe to $bin"
