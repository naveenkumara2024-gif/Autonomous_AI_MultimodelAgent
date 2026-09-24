# Persistent UI Automation worker (see line-worker.ts). One JSON request per stdin line, one
# JSON response per stdout line. UI Automation is a COM API; PowerShell loads the managed
# UIAutomationClient assemblies directly, which beats hand-marshalling COM vtables via bun:ffi
# and is far cheaper and more exact than asking a vision model to find the same element.
#
# Actions:
#   find_element     (default — the reference server's only action) search by name/id/type
#   focused_element  the element that currently has keyboard focus (risk classification)
#   element_at_point the element under a screen point (risk classification of clicks)
#   password_rects   bounding rects of password fields in the foreground window (redaction)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase # System.Windows.Point, for element_at_point
Add-Type -Name Win32 -Namespace McpDesktop -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'
[McpDesktop.Win32]::SetProcessDPIAware() | Out-Null

$AE = [System.Windows.Automation.AutomationElement]

function Describe-Element($el) {
  $rect = $el.Current.BoundingRectangle
  $isPassword = $false
  try { $isPassword = [bool]$el.GetCurrentPropertyValue($AE::IsPasswordProperty) } catch {}
  return @{
    found = $true
    name = $el.Current.Name
    automation_id = $el.Current.AutomationId
    control_type = $el.Current.ControlType.ProgrammaticName
    is_enabled = $el.Current.IsEnabled
    has_keyboard_focus = $el.Current.HasKeyboardFocus
    is_password = $isPassword
    bounding_rect = @{ left = [int]$rect.Left; top = [int]$rect.Top; width = [int]$rect.Width; height = [int]$rect.Height }
    center = @{ x = [int]($rect.Left + $rect.Width / 2); y = [int]($rect.Top + $rect.Height / 2) }
  }
}

function Get-ForegroundRoot {
  $hwnd = [McpDesktop.Win32]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  return $AE::FromHandle($hwnd)
}

function Invoke-FindElement($p) {
  $root = $AE::RootElement
  $searchRoot = $null

  if ($p.window_title) {
    $topLevel = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $topLevel) {
      try {
        if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($p.window_title.ToLower())) {
          $searchRoot = $w
          break
        }
      } catch {}
    }
  }

  if (-not $searchRoot) { $searchRoot = Get-ForegroundRoot }
  if (-not $searchRoot) { return @{ found = $false; error = "No search root window found." } }

  $conditions = New-Object 'System.Collections.Generic.List[System.Windows.Automation.Condition]'
  if ($p.name) {
    $conditions.Add((New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$p.name)))
  }
  if ($p.automation_id) {
    $conditions.Add((New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, [string]$p.automation_id)))
  }
  if ($p.control_type) {
    try {
      $ctField = [System.Windows.Automation.ControlType].GetField($p.control_type, [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Static)
      if ($ctField) {
        $conditions.Add((New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $ctField.GetValue($null))))
      }
    } catch {}
  }

  $condition = [System.Windows.Automation.Condition]::TrueCondition
  if ($conditions.Count -eq 1) {
    $condition = $conditions[0]
  } elseif ($conditions.Count -gt 1) {
    $condition = New-Object System.Windows.Automation.AndCondition($conditions.ToArray())
  }

  $timeoutMs = 3000
  if ($p.timeout_ms) { $timeoutMs = [int]$p.timeout_ms }
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  $found = $null
  do {
    $found = $searchRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($found) { break }
    Start-Sleep -Milliseconds 150
  } while ((Get-Date) -lt $deadline)

  if (-not $found) { return @{ found = $false } }
  return Describe-Element $found
}

function Invoke-FocusedElement {
  $el = $AE::FocusedElement
  if (-not $el) { return @{ found = $false } }
  return Describe-Element $el
}

function Invoke-ElementAtPoint($p) {
  $pt = New-Object System.Windows.Point([double]$p.x, [double]$p.y)
  $el = $AE::FromPoint($pt)
  if (-not $el) { return @{ found = $false } }
  return Describe-Element $el
}

function Invoke-PasswordRects {
  $root = Get-ForegroundRoot
  if (-not $root) { return @{ ok = $true; rects = @() } }
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::IsPasswordProperty, $true)
  $rects = @()
  foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
    $r = $el.Current.BoundingRectangle
    if ($r.Width -gt 0 -and $r.Height -gt 0) {
      $rects += @{ x = [int]$r.Left; y = [int]$r.Top; width = [int]$r.Width; height = [int]$r.Height }
    }
  }
  return @{ ok = $true; rects = $rects }
}

$stdin = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
$stdout = [Console]::OpenStandardOutput()
$writer = New-Object System.IO.StreamWriter($stdout, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  try {
    $p = $line | ConvertFrom-Json
    switch ($p.action) {
      "focused_element" { $result = Invoke-FocusedElement }
      "element_at_point" { $result = Invoke-ElementAtPoint $p }
      "password_rects" { $result = Invoke-PasswordRects }
      default { $result = Invoke-FindElement $p }
    }
  } catch {
    $result = @{ found = $false; ok = $false; error = $_.Exception.Message }
  }
  $writer.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
}
