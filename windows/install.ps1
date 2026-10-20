# sidehand installer for Windows. Runs install.mjs with the Node.js that ships with Codex's
# Computer Use runtime, so no separate Node install is needed. Pass --snapshot to re-freeze.
$ErrorActionPreference = 'Stop'

$runtimes = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
$node = Get-ChildItem $runtimes -Directory -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  ForEach-Object { Join-Path $_.FullName 'bin\node.exe' } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $node) {
  Write-Error "Codex's Computer Use runtime was not found. Install the Codex app, sign in and use Computer Use once (see README)."
  exit 1
}

& $node (Join-Path $PSScriptRoot 'install.mjs') @args
exit $LASTEXITCODE
