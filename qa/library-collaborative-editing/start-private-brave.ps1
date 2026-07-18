param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [Parameter(Mandatory = $true)]
  [string]$ProfileDirectory,

  [Parameter(Mandatory = $true)]
  [string]$EvidenceDirectory,

  [string]$Page = 'about:blank',

  [switch]$Visible
)

$ErrorActionPreference = 'Stop'

$bravePath = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
if (-not (Test-Path -LiteralPath $bravePath -PathType Leaf)) {
  throw "Brave was not found at $bravePath"
}

$qaBrowserRoot = [System.IO.Path]::GetFullPath((Join-Path $HOME '.lovelace\qa-browser'))
$qaEvidenceRoot = [System.IO.Path]::GetFullPath((Join-Path $HOME '.lovelace\qa-evidence'))
$resolvedProfile = [System.IO.Path]::GetFullPath($ProfileDirectory)
$resolvedEvidence = [System.IO.Path]::GetFullPath($EvidenceDirectory)
$comparison = [System.StringComparison]::OrdinalIgnoreCase

if (-not $resolvedProfile.StartsWith($qaBrowserRoot + [System.IO.Path]::DirectorySeparatorChar, $comparison)) {
  throw "The QA profile must be a fresh child of $qaBrowserRoot"
}
if (-not $resolvedEvidence.StartsWith($qaEvidenceRoot + [System.IO.Path]::DirectorySeparatorChar, $comparison)) {
  throw "The evidence directory must be a child of $qaEvidenceRoot"
}
if ($resolvedProfile.IndexOf('automation-profile', $comparison) -ge 0) {
  throw 'Refusing to reuse an Agent Navigator automation-profile directory.'
}
if (Test-Path -LiteralPath $resolvedProfile) {
  $existing = Get-ChildItem -LiteralPath $resolvedProfile -Force -ErrorAction Stop | Select-Object -First 1
  if ($null -ne $existing) {
    throw "The QA profile is not fresh: $resolvedProfile"
  }
}

$portProbe = [System.Net.Sockets.TcpClient]::new()
$portAlreadyOpen = $false
try {
  $portProbe.Connect([System.Net.IPAddress]::Loopback, $Port)
  $portAlreadyOpen = $portProbe.Connected
} catch [System.Net.Sockets.SocketException] {
  $portAlreadyOpen = $false
} finally {
  $portProbe.Dispose()
}
if ($portAlreadyOpen) {
  throw "Refusing to start Brave because localhost port $Port is already in use."
}

New-Item -ItemType Directory -Force -Path $resolvedProfile | Out-Null
New-Item -ItemType Directory -Force -Path $resolvedEvidence | Out-Null

$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$resolvedProfile",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update'
)
if (-not $Visible) {
  $arguments += '--headless=new'
  $arguments += '--disable-gpu'
}
$arguments += $Page

$start = @{
  FilePath = $bravePath
  ArgumentList = $arguments
  PassThru = $true
}
if (-not $Visible) {
  $start.WindowStyle = 'Hidden'
}
$process = Start-Process @start

$deadline = [DateTimeOffset]::UtcNow.AddSeconds(15)
$cdpReady = $false
while ([DateTimeOffset]::UtcNow -lt $deadline) {
  if ($process.HasExited) {
    throw "Brave exited before its Agent Navigator CDP endpoint became ready (exit code $($process.ExitCode))."
  }

  try {
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
    if ($version.webSocketDebuggerUrl) {
      $webSocketUri = [System.Uri]$version.webSocketDebuggerUrl
      $loopbackHost = $webSocketUri.Host -in @('127.0.0.1', 'localhost', '::1')
      if ($webSocketUri.Scheme -in @('ws', 'wss') -and $loopbackHost -and $webSocketUri.Port -eq $Port) {
        $cdpReady = $true
        break
      }
    }
  } catch {}

  Start-Sleep -Milliseconds 100
}

if (-not $cdpReady) {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  throw "Brave did not expose its Agent Navigator CDP endpoint on port $Port within 15 seconds."
}

[pscustomobject]@{
  pid = $process.Id
  port = $Port
  profile_directory = $resolvedProfile
  evidence_directory = $resolvedEvidence
  visible = [bool]$Visible
} | ConvertTo-Json -Compress
