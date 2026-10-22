' Starts the Faceless Studio dashboard in the background (no console window).
' Placed in the Windows Startup folder by install-task.ps1.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run "cmd /c node --disable-warning=ExperimentalWarning src\server.js >> data\dashboard.log 2>&1", 0, False
