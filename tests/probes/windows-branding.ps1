param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$Release
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'The HWND branding probe requires Windows.' }
$Root = [IO.Path]::GetFullPath($Root)
Add-Type -Path (Join-Path $Root 'tests/probes/windows-branding.cs')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('devkit-branding-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null

function Stop-OwnedProcess {
    param([Diagnostics.Process]$OwnedProcess, [int]$GraceMilliseconds)
    if ($OwnedProcess.WaitForExit($GraceMilliseconds)) { return }
    try {
        # Identity/Handle is already held. Do not enumerate another process tree during shutdown.
        $OwnedProcess.Kill()
    } catch {
        # Windows can report access denied while an already-exiting child is completing shutdown.
        if (-not $OwnedProcess.WaitForExit(2000)) { throw }
    }
    if (-not $OwnedProcess.WaitForExit(5000)) { throw 'An owned fixture process did not exit.' }
}

function Test-ApplicationBranding {
    param(
        [string]$Name,
        [string]$Executable,
        [string[]]$Arguments,
        [string]$ExpectedIcon,
        [string[]]$ExpectedCommand
    )
    $profile = Join-Path $temp $Name
    [IO.Directory]::CreateDirectory($profile) | Out-Null
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.WorkingDirectory = $Root
    $start.UseShellExecute = $false
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $start.ArgumentList.Add('--user-data-dir=' + $profile)
    foreach ($nameToRemove in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL',
        'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_APP_FILENAME')) {
        $start.Environment.Remove($nameToRemove) | Out-Null
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    $started = $false
    $window = [IntPtr]::Zero
    $children = [Collections.Generic.List[Diagnostics.Process]]::new()
    try {
        $started = $process.Start()
        if (-not $started) { throw "$Name did not start." }
        $owned = [Collections.Generic.HashSet[uint32]]::new()
        $owned.Add([uint32]$process.Id) | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        do {
            # Portable's HWND belongs to the extracted child, not the launcher PID.
            $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 | Select-Object ProcessId, ParentProcessId)
            do {
                $changed = $false
                foreach ($item in $all) {
                    if ($owned.Contains([uint32]$item.ParentProcessId) -and $owned.Add([uint32]$item.ProcessId)) {
                        $changed = $true
                        try {
                            $child = [Diagnostics.Process]::GetProcessById([int]$item.ProcessId)
                            $null = $child.Handle # Hold its actual process identity, even if a PID gets reused.
                            $children.Add($child)
                        } catch [ArgumentException] { } # Child already exited.
                    }
                }
            } while ($changed)
            $window = [DevKitBrandingProbe]::FindWindow([uint32[]]@($owned))
            if ($window -ne [IntPtr]::Zero) { break }
            if ($process.HasExited) { throw "$Name exited before opening a window (exit $($process.ExitCode))." }
            Start-Sleep -Milliseconds 300
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($window -eq [IntPtr]::Zero) { throw "$Name did not show an application window within 45 seconds." }

        $properties = [DevKitBrandingProbe]::ReadProperties($window)
        if ($properties['appId'] -cne 'com.embedded.devkit') { throw "$Name has the wrong HWND AppUserModelID." }
        if ($properties['displayName'] -cne 'DevKit') { throw "$Name has the wrong taskbar display name." }
        if ($properties['icon'] -notmatch '^(.*),(-?\d+)$') { throw "$Name has an invalid RelaunchIconResource." }
        $iconPath = $Matches[1].Trim('"')
        $iconIndex = [int]$Matches[2]
        if ($iconIndex -ne 0 -or
            [IO.Path]::GetFullPath($iconPath) -ine [IO.Path]::GetFullPath($ExpectedIcon) -or
            -not [IO.File]::Exists($iconPath)) {
            throw "$Name relaunch icon points at the wrong/nonexistent file: $($properties['icon'])"
        }
        $parsed = @([DevKitBrandingProbe]::ParseCommand($properties['command']))
        if ($parsed.Count -ne $ExpectedCommand.Count) { throw "$Name has unexpected relaunch arguments." }
        for ($i = 0; $i -lt $parsed.Count; $i++) {
            if ($parsed[$i] -ine $ExpectedCommand[$i]) {
                throw "$Name relaunch argument $i does not refer to its stable application path."
            }
        }
        $sizes = [DevKitBrandingProbe]::CheckIcons($window, (Join-Path $Root 'resources/branding/devkit.ico'))
        Write-Host "PASS Windows branding [$Name]: actual HWND AppID, icon resource, relaunch command/name; DK icon pixels ($sizes)"
    }
    finally {
        # Only close/terminate process identities this invocation actually started/discovered.
        # Chromium children may outlive the browser for a short time; allow orderly shutdown.
        $cleanupErrors = [Collections.Generic.List[string]]::new()
        if ($started) {
            try {
                if ($window -ne [IntPtr]::Zero) { [DevKitBrandingProbe]::CloseWindow($window) }
                Stop-OwnedProcess -OwnedProcess $process -GraceMilliseconds 10000
            } catch { $cleanupErrors.Add($_.Exception.Message) }
        }
        foreach ($child in $children) {
            try {
                Stop-OwnedProcess -OwnedProcess $child -GraceMilliseconds 5000
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            finally { $child.Dispose() }
        }
        $process.Dispose()
        if ($cleanupErrors.Count -gt 0) {
            throw ('Fixture cleanup failed: ' + ($cleanupErrors -join '; '))
        }
    }
}

try {
    $electron = Join-Path $Root 'node_modules/electron/dist/electron.exe'
    $icon = Join-Path $Root 'resources/branding/devkit.ico'
    if ([IO.File]::Exists($electron)) {
        Test-ApplicationBranding -Name 'development' -Executable $electron -Arguments @($Root) -ExpectedIcon $icon -ExpectedCommand @($electron, $Root)
    }
    else {
        # CI 上 electron 二进制 dist 可能未随 npm ci 落盘；packaged 两项已覆盖品牌行为，开发态跳过即可
        Write-Host 'SKIP Windows branding [development]: electron.exe not present (npm ci without electron binary)'
    }

    $unpacked = Join-Path $Root 'release/win-unpacked/DevKit.exe'
    Test-ApplicationBranding -Name 'unpacked' -Executable $unpacked -Arguments @() -ExpectedIcon $unpacked -ExpectedCommand @($unpacked)

    if ($Release) {
        $source = Join-Path $Root 'release/DevKit-portable.exe'
        $portableDir = Join-Path $temp 'portable with spaces 中文'
        [IO.Directory]::CreateDirectory($portableDir) | Out-Null
        $portable = Join-Path $portableDir 'DevKit portable.exe'
        Copy-Item -LiteralPath $source -Destination $portable
        Test-ApplicationBranding -Name 'portable' -Executable $portable -Arguments @() -ExpectedIcon $portable -ExpectedCommand @($portable)
        if (-not [IO.File]::Exists($portable)) { throw 'Portable relaunch target disappeared after exit.' }
        Write-Host 'PASS Windows branding [portable]: renamed outer launcher remains available after the application exits'
    }
}
finally {
    Remove-Item -LiteralPath $temp -Recurse -Force
}
