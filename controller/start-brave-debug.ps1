param(
  [string]$Page = "examples\job-application-demo.html",
  [int]$Port = 9222
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$bravePath = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
$profileDir = Join-Path $projectRoot "automation-profile"
$demoPage = if ([System.IO.Path]::IsPathRooted($Page)) { $Page } else { Join-Path $projectRoot $Page }
$port = $Port

if (-not (Test-Path $bravePath)) {
  throw "No encuentro Brave en $bravePath"
}

if (-not (Test-Path $demoPage)) {
  throw "No encuentro la pagina de arranque en $demoPage"
}

New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$arguments = @(
  "--remote-debugging-port=$port",
  "--user-data-dir=$profileDir",
  "--new-window",
  $demoPage
)

Start-Process -FilePath $bravePath -ArgumentList $arguments
Write-Host "Brave lanzado con depuracion remota en http://127.0.0.1:$port"
Write-Host "Perfil aislado: $profileDir"
Write-Host "Pagina inicial: $demoPage"
