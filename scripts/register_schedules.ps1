param(
    [switch]$Register,
    [switch]$Unregister,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$PythonExe = (Get-Command python -ErrorAction Stop).Source

$Tasks = @(
    @{
        Name        = "VCP_US_PostMarket_0615"
        Description = "US Post-Market SEPA/VCP Scan at 06:15 (Tue-Sat Asia/Taipei)"
        Time        = "06:15"
        DaysOfWeek  = @("Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
        Arguments   = "-m runners.run_post_market_scan --market US --notify"
    },
    @{
        Name        = "VCP_TW_PostMarket_1530"
        Description = "TW Post-Market SEPA/VCP Scan at 15:30 (Mon-Fri Asia/Taipei)"
        Time        = "15:30"
        DaysOfWeek  = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")
        Arguments   = "-m runners.run_post_market_scan --market TW --notify"
    }
)

if (-not $Register -and -not $Unregister) {
    $DryRun = $true
}

if ($Unregister) {
    foreach ($t in $Tasks) {
        if ($DryRun) {
            Write-Host "[DRY-RUN] Unregister-ScheduledTask -TaskName $($t.Name) -Confirm:`$false"
        } else {
            Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue
            Write-Host "[Unregistered] $($t.Name)"
        }
    }
    exit 0
}

foreach ($t in $Tasks) {
    $daysStr = ($t.DaysOfWeek -join ", ")
    if ($DryRun) {
        Write-Host "[DRY-RUN] Task: $($t.Name)"
        Write-Host "  Schedule : $($t.Time) ($daysStr)"
        Write-Host "  Command  : `"$PythonExe`" $($t.Arguments)"
        Write-Host "  WorkDir  : $RepoRoot"
        Write-Host ""
    } else {
        $action = New-ScheduledTaskAction -Execute $PythonExe -Argument $t.Arguments -WorkingDirectory $RepoRoot
        $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $t.DaysOfWeek -At $t.Time
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $t.Name -Description $t.Description -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Write-Host "[Registered] $($t.Name) -> $($t.Time) ($daysStr)"
    }
}
