# Makes the studio run without you (no administrator rights needed):
#   1. "FacelessStudio Daily" scheduled task - makes today's videos at the time in config/channel.json
#      (wakes the PC from sleep, catches up if the PC was off at that time)
#   The dashboard (npm start → http://localhost:3020) is never started automatically; run it yourself when you want.
# Run once from the project folder:   powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
# Remove:  Unregister-ScheduledTask -TaskName "FacelessStudio Daily" -Confirm:$false

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$cfg  = Get-Content (Join-Path $root 'config\channel.json') -Raw | ConvertFrom-Json
$at   = [datetime]::ParseExact($cfg.schedule.runAtLocal, 'HH:mm', $null)
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null

# 1. daily production task (current user, no elevation)
try {
  $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 10) -MultipleInstances IgnoreNew
  # wscript + run-daily.vbs = no console window; it exits by itself when today's videos are done
  $daily = New-ScheduledTaskAction -Execute 'wscript.exe' -WorkingDirectory $root -Argument "`"$(Join-Path $root 'scripts\run-daily.vbs')`""
  Register-ScheduledTask -TaskName 'FacelessStudio Daily' -Action $daily -Trigger @((New-ScheduledTaskTrigger -Daily -At $at), (New-ScheduledTaskTrigger -Daily -At $at.AddMinutes(150))) -Settings $settings -Description 'Makes and schedules the day''s YouTube Shorts' -Force -ErrorAction Stop | Out-Null
  Write-Host "OK   daily video run registered for $($cfg.schedule.runAtLocal) every day, plus a catch-up at $($at.AddMinutes(150).ToString('HH:mm')) (only works if videos are missing)" -ForegroundColor Green
} catch { Write-Host "FAIL daily task: $($_.Exception.Message)" -ForegroundColor Red }

# 2. The dashboard is NOT started automatically — run `npm start` yourself when you want to look.
#    Remove launchers that earlier versions of this script created.
Unregister-ScheduledTask -TaskName 'FacelessStudio Dashboard' -Confirm:$false -ErrorAction SilentlyContinue
$old = Join-Path ([Environment]::GetFolderPath('Startup')) 'Faceless Studio Dashboard.lnk'
if (Test-Path $old) { Remove-Item $old -Force; Write-Host "OK   removed the dashboard auto-start shortcut" -ForegroundColor Green }
Write-Host "INFO dashboard runs only when you start it: npm start  ->  http://localhost:3020"
