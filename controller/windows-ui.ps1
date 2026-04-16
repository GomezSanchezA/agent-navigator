param(
  [Parameter(Mandatory = $true)]
  [string]$Action,
  [string]$JsonArgs = "{}"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

public static class WinApi {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
"@

function Get-JsonArg {
  param(
    [object]$Object,
    [string]$Name,
    $Default = $null
  )

  if ($null -eq $Object) {
    return $Default
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $Default
  }

  if ($null -eq $property.Value) {
    return $Default
  }

  return $property.Value
}

function Get-VisibleWindows {
  $items = New-Object System.Collections.Generic.List[object]
  $callback = [EnumWindowsProc]{
    param([IntPtr]$Handle, [IntPtr]$LParam)

    if (-not [WinApi]::IsWindowVisible($Handle)) {
      return $true
    }

    $length = [WinApi]::GetWindowTextLength($Handle)
    if ($length -le 0) {
      return $true
    }

    $builder = New-Object System.Text.StringBuilder ($length + 1)
    [void][WinApi]::GetWindowText($Handle, $builder, $builder.Capacity)
    $title = $builder.ToString().Trim()
    if ([string]::IsNullOrWhiteSpace($title)) {
      return $true
    }

    $processId = [uint32]0
    [void][WinApi]::GetWindowThreadProcessId($Handle, [ref]$processId)
    $processName = ""
    try {
      $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
    } catch {
      $processName = ""
    }

    $items.Add([pscustomobject]@{
      handle = $Handle.ToInt64()
      title = $title
      processId = [int]$processId
      processName = $processName
    })

    return $true
  }

  [void][WinApi]::EnumWindows($callback, [IntPtr]::Zero)
  return $items
}

function Find-Window {
  param(
    [string]$Title
  )

  if ([string]::IsNullOrWhiteSpace($Title)) {
    throw "Falta el titulo de ventana."
  }

  $needle = $Title.ToLowerInvariant()
  return Get-VisibleWindows |
    Where-Object { $_.title.ToLowerInvariant().Contains($needle) } |
    Select-Object -First 1
}

function Wait-Window {
  param(
    [string]$Title,
    [int]$TimeoutMs = 10000
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $match = Find-Window -Title $Title
    if ($null -ne $match) {
      return $match
    }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "No he encontrado una ventana que coincida con '$Title'."
}

function Activate-WindowHandle {
  param(
    [Int64]$Handle
  )

  $pointer = [IntPtr]::new($Handle)
  [void][WinApi]::ShowWindowAsync($pointer, 5)
  Start-Sleep -Milliseconds 120
  [void][WinApi]::SetForegroundWindow($pointer)
  Start-Sleep -Milliseconds 180
}

function Activate-WindowByTitle {
  param(
    [string]$Title
  )

  $window = Wait-Window -Title $Title
  Activate-WindowHandle -Handle $window.handle
  return $window
}

function Send-WindowsKeys {
  param(
    [string]$Keys,
    [string]$Title
  )

  if ($Title) {
    [void](Activate-WindowByTitle -Title $Title)
  }

  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds 150
}

function Type-WindowsText {
  param(
    [string]$Text,
    [string]$Title,
    [bool]$Replace = $false
  )

  if ($Title) {
    [void](Activate-WindowByTitle -Title $Title)
  }

  if ($Replace) {
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 80
  }

  Set-Clipboard -Value $Text
  Start-Sleep -Milliseconds 80
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 150
}

$argsObject = if ([string]::IsNullOrWhiteSpace($JsonArgs)) { $null } else { $JsonArgs | ConvertFrom-Json }
$result = $null

switch ($Action) {
  "list-windows" {
    $result = Get-VisibleWindows
    break
  }

  "wait-window" {
    $result = Wait-Window -Title (Get-JsonArg $argsObject "title") -TimeoutMs ([int](Get-JsonArg $argsObject "timeoutMs" 10000))
    break
  }

  "activate-window" {
    $result = Activate-WindowByTitle -Title (Get-JsonArg $argsObject "title")
    break
  }

  "send-keys" {
    Send-WindowsKeys -Keys (Get-JsonArg $argsObject "keys") -Title (Get-JsonArg $argsObject "title")
    $result = [pscustomobject]@{
      ok = $true
      keys = Get-JsonArg $argsObject "keys"
      title = Get-JsonArg $argsObject "title"
    }
    break
  }

  "type-text" {
    Type-WindowsText `
      -Text (Get-JsonArg $argsObject "text") `
      -Title (Get-JsonArg $argsObject "title") `
      -Replace ([bool](Get-JsonArg $argsObject "replace" $false))
    $result = [pscustomobject]@{
      ok = $true
      title = Get-JsonArg $argsObject "title"
      text = Get-JsonArg $argsObject "text"
    }
    break
  }

  "navigate-explorer" {
    $title = Get-JsonArg $argsObject "title"
    $targetPath = Get-JsonArg $argsObject "path"
    $window = Wait-Window -Title $title -TimeoutMs ([int](Get-JsonArg $argsObject "timeoutMs" 10000))
    Activate-WindowHandle -Handle $window.handle
    [System.Windows.Forms.SendKeys]::SendWait("^l")
    Start-Sleep -Milliseconds 180
    Set-Clipboard -Value $targetPath
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 250
    $result = [pscustomobject]@{
      ok = $true
      title = $window.title
      path = $targetPath
    }
    break
  }

  "save-file" {
    $title = Get-JsonArg $argsObject "title"
    $targetPath = Get-JsonArg $argsObject "path"
    $window = Wait-Window -Title $title -TimeoutMs ([int](Get-JsonArg $argsObject "timeoutMs" 10000))
    Activate-WindowHandle -Handle $window.handle
    [System.Windows.Forms.SendKeys]::SendWait("%n")
    Start-Sleep -Milliseconds 220
    Set-Clipboard -Value $targetPath
    Start-Sleep -Milliseconds 80
    [System.Windows.Forms.SendKeys]::SendWait("^a")
    Start-Sleep -Milliseconds 60
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 250
    $result = [pscustomobject]@{
      ok = $true
      title = $window.title
      path = $targetPath
    }
    break
  }

  default {
    throw "Accion no soportada: $Action"
  }
}

$result | ConvertTo-Json -Depth 8 -Compress

