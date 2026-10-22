' Runs today's video production with no visible window, and waits until it finishes
' (so Task Scheduler shows the real run time). Used by the "FacelessStudio Daily" task.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
code = sh.Run("cmd /c node --disable-warning=ExperimentalWarning src\daily.js >> data\daily.log 2>&1", 0, True)
WScript.Quit code
