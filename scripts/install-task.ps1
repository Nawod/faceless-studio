# Registers Windows scheduled tasks so the studio runs without you:
#   1. "FacelessStudio Daily"     - runs the pipeline every day at the time in config/channel.json (wakes the PC, catches up if missed)
#   2. "FacelessStudio Dashboard" - starts the dashboard at logon (http://localhost:3020)
# Run once from the project folder:   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
# Remove:  Unregister-ScheduledTask -TaskName "FacelessStudio Daily","FacelessStudio Dashboard" -Confirm:$false

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$cfg  = Get-Content (Join-Path $root 'config\channel.json') -Raw | ConvertFrom-Json
$at   = [datetime]::ParseExact($cfg.schedule.runAtLocal, 'HH:mm', $null)

$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)

$daily = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $root `
  -Argument "/c `"`"$node`" --disable-warning=ExperimentalWarning src\daily.js >> data\daily.log 2>&1`""
Register-ScheduledTask -TaskName 'FacelessStudio Daily' -Action $daily -Trigger (New-ScheduledTaskTrigger -Daily -At $at) -Settings $settings -Description 'Makes and schedules one YouTube Short' -Force | Out-Null

$dash = New-ScheduledTaskAction -Execute $node -WorkingDirectory $root -Argument '--disable-warning=ExperimentalWarning src\server.js'
Register-ScheduledTask -TaskName 'FacelessStudio Dashboard' -Action $dash -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings $settings -Description 'Faceless Studio dashboard on port 3020' -Force | Out-Null

Write-Host "Registered: daily run at $($cfg.schedule.runAtLocal) and dashboard at logon."
