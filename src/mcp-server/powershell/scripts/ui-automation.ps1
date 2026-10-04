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
#   taskbar_apps     pinned/running app buttons on the taskbar, with their AppUserModelIDs
#   start_apps       every Start-menu app (shell:AppsFolder), name + AppUserModelID
#   invoke_taskbar   press an app's taskbar button via InvokePattern (no mouse, no keystrokes)
#   app_windows      visible top-level windows belonging to an app (by AppUserModelID/exe)
#   focus_app        restore + foreground the most recently active window of an app
#   foreground_app   the foreground window's title, exe and AppUserModelID

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

# Friendly names for shell surfaces whose UIA Name is empty, so they can't be matched by title.
$WindowClassAliases = @{ 'taskbar' = 'Shell_TrayWnd'; 'system tray' = 'Shell_TrayWnd'; 'desktop' = 'Progman' }

function Find-TopLevelWindow([string]$title) {
  $needle = $title.ToLower()
  $classNeedle = $WindowClassAliases[$needle]
  $topLevel = $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $topLevel) {
    try {
      $class = $w.Current.ClassName
      if ($classNeedle -and $class -eq $classNeedle) { return $w }
      if ($w.Current.Name -and $w.Current.Name.ToLower().Contains($needle)) { return $w }
      if ($class -and $class.ToLower() -eq $needle) { return $w }
    } catch {}
  }
  return $null
}

function Get-OpenWindowTitles {
  $titles = @()
  foreach ($w in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try { if ($w.Current.Name) { $titles += $w.Current.Name } } catch {}
    if ($titles.Count -ge 15) { break }
  }
  return ,$titles
}

function Invoke-FindElement($p) {
  $searchRoot = $null

  if ($p.window_title) {
    $searchRoot = Find-TopLevelWindow ([string]$p.window_title)
    # An explicit window that doesn't exist is an immediate, informative miss — never a silent
    # search of whatever happens to be in the foreground (which then burns the full timeout).
    if (-not $searchRoot) {
      return @{ found = $false; error = "No open window matches window_title '$($p.window_title)' (title or class name; 'taskbar' is an alias for the Windows taskbar)."; open_windows = (Get-OpenWindowTitles) }
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

# --- App launching / switching (launch_app) --------------------------------------------------
# Windows identifies an app by its AppUserModelID (AUMID) everywhere: the taskbar button's
# AutomationId is "Appid: <AUMID>", shell:AppsFolder items are keyed by it, and a window carries
# it in its property store. Matching on the AUMID works identically for Store (UWP/MSIX) and
# classic Win32 apps, with no exe-path or process-name guessing.

$script:AppWinLoaded = $false
function Initialize-AppWin {
  if ($script:AppWinLoaded) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace McpDesktop {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public long pad; }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out uint c); int GetAt(uint i, out PROPERTYKEY k); int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); int Commit();
  }
  public static class AppWin {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int n);

    public static string Title(IntPtr h) { var sb = new StringBuilder(GetWindowTextLength(h) + 1); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint len, StringBuilder id);

    /** The window's own AUMID (UWP frames, apps that stamp it), else its packaged process's (WinUI 3 / MSIX desktop apps such as WhatsApp). */
    public static string Aumid(IntPtr h) {
      string own = WindowAumid(h);
      if (own != null) return own;
      uint pid; GetWindowThreadProcessId(h, out pid);
      IntPtr p = OpenProcess(0x1000, false, pid);
      if (p == IntPtr.Zero) return null;
      try { var sb = new StringBuilder(260); uint n = 260; return GetApplicationUserModelId(p, ref n, sb) == 0 ? sb.ToString() : null; }
      finally { CloseHandle(p); }
    }

    static string WindowAumid(IntPtr h) {
      Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
      IPropertyStore ps;
      if (SHGetPropertyStoreForWindow(h, ref iid, out ps) != 0 || ps == null) return null;
      try {
        PROPERTYKEY k = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        PROPVARIANT v;
        if (ps.GetValue(ref k, out v) != 0) return null;
        string s = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : null;
        PropVariantClear(ref v);
        return s;
      } finally { Marshal.ReleaseComObject(ps); }
    }

    public static string Exe(IntPtr h) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      IntPtr p = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (p == IntPtr.Zero) return null;
      try { var sb = new StringBuilder(1024); int n = sb.Capacity; return QueryFullProcessImageName(p, 0, sb, ref n) ? sb.ToString() : null; }
      finally { CloseHandle(p); }
    }

    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    /**
     * Restores and foregrounds h. Windows' foreground lock refuses SetForegroundWindow from a
     * background process for many windows (WinUI 3 apps like WhatsApp); sharing the current
     * foreground thread's input state for the call is the documented way around it without
     * sending any synthetic input.
     */
    public static bool Activate(IntPtr h) {
      if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
      IntPtr fg = GetForegroundWindow();
      if (fg == h) return true;
      uint fgPid;
      uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
      uint me = GetCurrentThreadId();
      bool attached = fg != IntPtr.Zero && fgThread != me && AttachThreadInput(me, fgThread, true);
      try { BringWindowToTop(h); SetForegroundWindow(h); }
      finally { if (attached) AttachThreadInput(me, fgThread, false); }
      return WaitForeground(h, 300);
    }

    /** Activation is applied asynchronously; a read right after SetForegroundWindow can still see the old window. */
    public static bool WaitForeground(IntPtr h, int timeoutMs) {
      for (int waited = 0; ; waited += 25) {
        if (GetForegroundWindow() == h) return true;
        if (waited >= timeoutMs) return false;
        System.Threading.Thread.Sleep(25);
      }
    }

    static bool IsCloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; } // DWMWA_CLOAKED

    /** Visible, unowned, titled, uncloaked top-level windows, in Z-order (most recently active first). */
    public static List<IntPtr> AppCandidates() {
      var list = new List<IntPtr>();
      EnumWindows((h, l) => {
        if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && GetWindowTextLength(h) > 0 && !IsCloaked(h)) list.Add(h);
        return true;
      }, IntPtr.Zero);
      return list;
    }
  }
}
'@
  $script:AppWinLoaded = $true
}

function Get-TaskbarRoots {
  $roots = @()
  foreach ($class in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) {
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, $class)
    foreach ($el in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) { $roots += $el }
  }
  return $roots
}

function Invoke-TaskbarApps {
  $apps = @{}
  $btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  foreach ($tray in (Get-TaskbarRoots)) {
    foreach ($b in $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) {
      try {
        $id = $b.Current.AutomationId
        if (-not $id -or -not $id.StartsWith('Appid: ')) { continue }
        $appId = $id.Substring(7)
        if ($apps.ContainsKey($appId)) { continue }
        # Button names are "<App> pinned" when idle and "<App> - N running window(s)" when open.
        $label = $b.Current.Name
        $running = 0
        $pinned = $false
        $name = $label
        if ($label -match '^(.*?) - (\d+) running windows?$') { $name = $Matches[1]; $running = [int]$Matches[2] }
        elseif ($label -match '^(.*?) pinned$') { $name = $Matches[1]; $pinned = $true }
        $apps[$appId] = @{ name = $name; app_id = $appId; pinned = $pinned; running_windows = $running }
      } catch {}
    }
  }
  return @{ ok = $true; apps = @($apps.Values) }
}

function Invoke-StartApps {
  $shell = New-Object -ComObject Shell.Application
  $list = @()
  foreach ($item in $shell.NameSpace('shell:AppsFolder').Items()) {
    if ($item.Name -and $item.Path) { $list += @{ name = $item.Name; app_id = $item.Path } }
  }
  return @{ ok = $true; apps = $list }
}

function Invoke-InvokeTaskbar($p) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, "Appid: $($p.app_id)")
  foreach ($tray in (Get-TaskbarRoots)) {
    $btn = $tray.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($btn) {
      $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      return @{ ok = $true }
    }
  }
  return @{ ok = $false; error = "No taskbar button for $($p.app_id)." }
}

# Store apps stamp their AUMID on each window; classic Win32 apps usually don't (VS Code, Word,
# Chrome windows carry none), so for those the Start-menu entry's shortcut target exe is the
# link between AppID and window. Cached per AppID for the worker's lifetime.
$script:TargetExeCache = @{}
function Get-AppTargetExe([string]$appId) {
  if ($script:TargetExeCache.ContainsKey($appId)) { return $script:TargetExeCache[$appId] }
  $target = $null
  try {
    $item = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder').ParseName($appId)
    if ($item) { $target = [string]$item.ExtendedProperty('System.Link.TargetParsingPath') }
  } catch {}
  # Apps registered by exe path ("{KNOWNFOLDER}\Vendor\app.exe" / "C:\...\app.exe") name it directly.
  if (-not $target -and $appId -match '\\[^\\]+\.exe$') { $target = $appId }
  if (-not $target) { $target = '' }
  $script:TargetExeCache[$appId] = $target
  return $target
}

# Does window $h belong to the app? Exact AUMID when the window has one, else the exe.
function Test-WindowOfApp([IntPtr]$h, [string]$appId, [string]$targetExe) {
  $aumid = [McpDesktop.AppWin]::Aumid($h)
  if ($aumid) { return $aumid -ieq $appId }
  if (-not $targetExe) { return $false }
  $exe = [McpDesktop.AppWin]::Exe($h)
  if (-not $exe) { return $false }
  if ($targetExe -match '^[A-Za-z]:\\') { return $exe -ieq $targetExe }
  return [System.IO.Path]::GetFileName($exe) -ieq [System.IO.Path]::GetFileName($targetExe)
}

function Get-AppWindows([string]$appId) {
  Initialize-AppWin
  $targetExe = Get-AppTargetExe $appId
  $found = @()
  foreach ($h in [McpDesktop.AppWin]::AppCandidates()) {
    if (Test-WindowOfApp $h $appId $targetExe) { $found += $h }
  }
  return ,$found
}

function Invoke-AppWindows($p) {
  $wins = Get-AppWindows ([string]$p.app_id)
  $fg = [McpDesktop.AppWin]::GetForegroundWindow()
  return @{
    ok = $true
    count = $wins.Count
    foreground = ($wins -contains $fg)
    windows = @($wins | Select-Object -First 5 | ForEach-Object { @{ title = [McpDesktop.AppWin]::Title($_); minimized = [McpDesktop.AppWin]::IsIconic($_) } })
  }
}

function Invoke-FocusApp($p) {
  $wins = Get-AppWindows ([string]$p.app_id)
  if ($wins.Count -eq 0) { return @{ ok = $false; error = 'No open window for this app.' } }
  $h = $wins[0]
  $ok = [McpDesktop.AppWin]::Activate($h)
  if (-not $ok) {
    # UIA's SetFocus goes through the target's own provider, which some frames (UWP) honor.
    try { $AE::FromHandle($h).SetFocus() } catch {}
    $ok = [McpDesktop.AppWin]::WaitForeground($h, 300)
  }
  return @{ ok = $true; foreground = $ok; title = [McpDesktop.AppWin]::Title($h); window_count = $wins.Count }
}

function Invoke-ForegroundApp {
  Initialize-AppWin
  $h = [McpDesktop.AppWin]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return @{ ok = $true; found = $false } }
  return @{ ok = $true; found = $true; title = [McpDesktop.AppWin]::Title($h); app_id = [McpDesktop.AppWin]::Aumid($h); exe = [McpDesktop.AppWin]::Exe($h) }
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
      "taskbar_apps" { $result = Invoke-TaskbarApps }
      "start_apps" { $result = Invoke-StartApps }
      "invoke_taskbar" { $result = Invoke-InvokeTaskbar $p }
      "app_windows" { $result = Invoke-AppWindows $p }
      "focus_app" { $result = Invoke-FocusApp $p }
      "foreground_app" { $result = Invoke-ForegroundApp }
      "warm" { Initialize-AppWin; $result = @{ ok = $true } }
      default { $result = Invoke-FindElement $p }
    }
  } catch {
    $result = @{ found = $false; ok = $false; error = $_.Exception.Message }
  }
  $writer.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
}
