$ErrorActionPreference = 'Stop'

$expectedCommit = 'f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8'
$expectedPluginTree = 'c79dd16babb26a39aca4a15156bc488bcfc69587'
$viewerSha256 = 'a8626ff3ad90041e807bfdb8994eefdd986e891593c4759d08222667e5405330'
$origin = 'https://github.com/Egonex-AI/Understand-Anything.git'
$checks = @{
  'understand-anything-plugin/package.json' = 'e06bc5863abcafdd9c4108e34cbbf5fd6448cedf'
  'understand-anything-plugin/pnpm-lock.yaml' = 'fd4cf7539627856d6b166c39dc1041165fa2ce87'
  'understand-anything-plugin/skills/understand/SKILL.md' = '99bede1a9a7e008e621011d6c984a6b97518946f'
  'LICENSE' = '5df102e8a2e29cdfb881ae7ec5040f2766564680'
}

$cacheRoot = Join-Path $env:USERPROFILE '.kneekura-code-lab\engine-cache\understand-anything-v2.9.0-f08763d11d0202a8a8f52b5dedda6d1b2e2ebac8'
$sourceRoot = Join-Path $cacheRoot 'source'
$viewerTgz = Join-Path $cacheRoot "understand-anything-viewer-$viewerSha256.tgz"
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

function Reset-SourceCache {
  if (Test-Path $sourceRoot) { Remove-Item -Recurse -Force $sourceRoot }
  New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
  git -C $sourceRoot init | Out-Null
  git -C $sourceRoot remote add origin $origin
}

$sourceHealthy = $false
if (Test-Path (Join-Path $sourceRoot '.git')) {
  try {
    $remote = (git -C $sourceRoot remote get-url origin).Trim()
    if ($remote -eq $origin) { $sourceHealthy = $true }
  } catch { $sourceHealthy = $false }
}
if (-not $sourceHealthy) { Reset-SourceCache }

git -C $sourceRoot fetch --depth 1 origin $expectedCommit
git -C $sourceRoot checkout --detach --force FETCH_HEAD | Out-Null
git -C $sourceRoot reset --hard $expectedCommit | Out-Null
# Preserve ignored dependency/build caches for speed, while deleting untracked source files.
git -C $sourceRoot clean -ffd | Out-Null

$actualCommit = (git -C $sourceRoot rev-parse HEAD).Trim().ToLowerInvariant()
if ($actualCommit -ne $expectedCommit) { throw "Pinned UA commit mismatch: $actualCommit" }
$pluginTree = (git -C $sourceRoot rev-parse 'HEAD:understand-anything-plugin').Trim().ToLowerInvariant()
if ($pluginTree -ne $expectedPluginTree) { throw "Pinned UA plugin tree mismatch: $pluginTree" }
foreach ($entry in $checks.GetEnumerator()) {
  $actual = (git -C $sourceRoot hash-object $entry.Key).Trim().ToLowerInvariant()
  if ($actual -ne $entry.Value) { throw "Pinned UA blob mismatch for $($entry.Key): $actual" }
}

corepack enable
corepack prepare pnpm@10.6.2 --activate
Push-Location $sourceRoot
try {
  # A persistent pnpm store is only a transport/cache optimization; the frozen lock remains authoritative.
  pnpm install --frozen-lockfile --prefer-offline
  # Rebuild core on every turn from the verified source/lock instead of trusting cached build bytes.
  pnpm --filter '@understand-anything/core' build
} finally { Pop-Location }
$coreDist = Join-Path $sourceRoot 'understand-anything-plugin\packages\core\dist\index.js'
if (-not (Test-Path $coreDist)) { throw 'Pinned UA core build missing dist/index.js' }

if (Test-Path $viewerTgz) {
  $cachedViewer = (Get-FileHash -Algorithm SHA256 $viewerTgz).Hash.ToLowerInvariant()
  if ($cachedViewer -ne $viewerSha256) { Remove-Item -Force $viewerTgz }
}
if (-not (Test-Path $viewerTgz)) {
  $tmpViewer = "$viewerTgz.$env:GITHUB_RUN_ID.tmp"
  if (Test-Path $tmpViewer) { Remove-Item -Force $tmpViewer }
  try {
    Invoke-WebRequest -Uri 'https://github.com/Egonex-AI/Understand-Anything/releases/download/v2.9.0/understand-anything-viewer.tgz' -OutFile $tmpViewer
    $downloadedViewer = (Get-FileHash -Algorithm SHA256 $tmpViewer).Hash.ToLowerInvariant()
    if ($downloadedViewer -ne $viewerSha256) { throw "Pinned UA viewer sha256 mismatch: $downloadedViewer" }
    Move-Item -Force $tmpViewer $viewerTgz
  } finally {
    if (Test-Path $tmpViewer) { Remove-Item -Force $tmpViewer }
  }
}
$actualViewer = (Get-FileHash -Algorithm SHA256 $viewerTgz).Hash.ToLowerInvariant()
if ($actualViewer -ne $viewerSha256) { throw "Pinned UA viewer cache sha256 mismatch: $actualViewer" }

$viewerRoot = Join-Path $sourceRoot ".kneekura-relay-ua-viewer-v2.9.0-$env:GITHUB_RUN_ID"
if (Test-Path $viewerRoot) { Remove-Item -Recurse -Force $viewerRoot }
New-Item -ItemType Directory -Path $viewerRoot -Force | Out-Null
& tar -xzf $viewerTgz -C $viewerRoot
if ($LASTEXITCODE -ne 0) { throw "Pinned UA viewer extraction failed: exit $LASTEXITCODE" }
$index = Get-ChildItem -Path $viewerRoot -Recurse -File -Filter 'index.html' | Where-Object { $_.FullName -match '[\\/]dist[\\/]index\.html$' } | Select-Object -First 1
if (-not $index) { throw 'Pinned UA viewer artifact missing dist/index.html' }
$dashboardRoot = Split-Path -Parent $index.FullName

"KNEEKURA_UA_ROOT=$sourceRoot" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"KNEEKURA_UA_DASHBOARD_ROOT=$dashboardRoot" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append