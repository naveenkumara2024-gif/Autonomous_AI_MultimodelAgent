# Persistent system-control worker (see line-worker.ts): master volume via Core Audio's
# IAudioEndpointVolume, display brightness via WMI. Both sit behind non-IDispatch COM
# interfaces PowerShell's late-bound COM can't call, so the interop is compiled C# (once, at
# worker start — the reason this runs as a persistent worker instead of per call).
#
# Brightness note: WmiMonitorBrightnessMethods only exists when the display reports brightness
# support to Windows (typically laptop panels) — external monitors usually don't, and callers
# get `supported: false` rather than an error. Simulating Fn+F7/F8 was tried and rejected in the
# original project: "Fn" never reaches the OS, and VK_BRIGHTNESS_* is a silent no-op without an
# OEM driver listening. WMI is the only path that reliably works across machines.

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume
{
    int RegisterControlChangeNotify(IntPtr pNotify);
    int UnregisterControlChangeNotify(IntPtr pNotify);
    int GetChannelCount(out int pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute(bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(Guid pguidEventContext);
    int VolumeStepDown(Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IAudioEndpointVolume ppInterface);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    int NotImpl1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public static class McpDesktopAudio
{
    static IAudioEndpointVolume GetVol()
    {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev;
        enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        IAudioEndpointVolume epv;
        dev.Activate(ref iid, 23, IntPtr.Zero, out epv);
        return epv;
    }

    public static void SetVolume(float scalar0to1)
    {
        var epv = GetVol();
        try { epv.SetMasterVolumeLevelScalar(scalar0to1, Guid.Empty); }
        finally { Marshal.ReleaseComObject(epv); }
    }

    public static float GetVolume()
    {
        var epv = GetVol();
        try { float f; epv.GetMasterVolumeLevelScalar(out f); return f; }
        finally { Marshal.ReleaseComObject(epv); }
    }

    public static void SetMute(bool mute)
    {
        var epv = GetVol();
        try { epv.SetMute(mute, Guid.Empty); }
        finally { Marshal.ReleaseComObject(epv); }
    }

    public static bool GetMute()
    {
        var epv = GetVol();
        try { bool m; epv.GetMute(out m); return m; }
        finally { Marshal.ReleaseComObject(epv); }
    }
}
'@

function Invoke-SystemControl($p) {
  switch ($p.action) {
    "get_volume" {
      return @{ ok = $true; volume = [math]::Round([McpDesktopAudio]::GetVolume() * 100); muted = [McpDesktopAudio]::GetMute() }
    }
    "set_volume" {
      if ($null -ne $p.level) { [McpDesktopAudio]::SetVolume([float]$p.level / 100.0) }
      if ($null -ne $p.muted) { [McpDesktopAudio]::SetMute([bool]$p.muted) }
      return @{ ok = $true; volume = [math]::Round([McpDesktopAudio]::GetVolume() * 100); muted = [McpDesktopAudio]::GetMute() }
    }
    "get_brightness" {
      try {
        $b = Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightness -ErrorAction Stop
        return @{ ok = $true; supported = $true; brightness = [int]$b.CurrentBrightness }
      } catch {
        return @{ ok = $true; supported = $false; brightness = $null; error = $_.Exception.Message }
      }
    }
    "set_brightness" {
      try {
        $methods = Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightnessMethods -ErrorAction Stop
        $methods.WmiSetBrightness(1, [int]$p.level) | Out-Null
        Start-Sleep -Milliseconds 300
        $b = Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightness -ErrorAction Stop
        return @{ ok = $true; supported = $true; brightness = [int]$b.CurrentBrightness }
      } catch {
        return @{ ok = $false; supported = $false; brightness = $null; error = $_.Exception.Message }
      }
    }
    default {
      return @{ ok = $false; error = "Unknown action: $($p.action)" }
    }
  }
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
    $result = Invoke-SystemControl $p
  } catch {
    $result = @{ ok = $false; error = $_.Exception.Message }
  }
  $writer.WriteLine(($result | ConvertTo-Json -Compress -Depth 6))
}
