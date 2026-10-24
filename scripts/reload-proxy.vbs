Option Explicit
' anyway2codex one-click reload:
'   1) build  -> if the build fails, the running proxy is left untouched
'   2) stop only the process listening on 8800
'   3) start the proxy detached (survives Codex being closed)
'   4) poll /health and report the result in one dialog
Dim sh, buildLog, killCmd, startCmd, probeCmd, rc, attempt, healthy
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\anyway2codex"
buildLog = sh.ExpandEnvironmentStrings("%TEMP%") & "\anyway2codex-build.log"

rc = sh.Run("cmd.exe /c npm run build > """ & buildLog & """ 2>&1", 0, True)
If rc <> 0 Then
  MsgBox "Build failed (exit code " & rc & ")." & vbCrLf & vbCrLf & _
         "The proxy already listening on port 8800 was NOT touched." & vbCrLf & _
         "Build log: " & buildLog, vbCritical, "anyway2codex reload"
  WScript.Quit rc
End If

killCmd = "powershell -NoProfile -Command ""$p=(Get-NetTCPConnection -LocalPort 8800 " & _
          "-State Listen -ErrorAction SilentlyContinue).OwningProcess; " & _
          "if($p){$p|Select-Object -Unique|ForEach-Object{Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue}}"""
sh.Run killCmd, 0, True
WScript.Sleep 1500

startCmd = "cmd.exe /c cd /d D:\anyway2codex && node dist\cli.js --port 8800 --verbose " & _
           ">> ""%USERPROFILE%\.anyway2codex\server.log"" 2>&1"
sh.Run startCmd, 0, False

probeCmd = "cmd.exe /c curl -s -f --max-time 3 http://127.0.0.1:8800/health > nul"
healthy = False
For attempt = 1 To 12
  WScript.Sleep 1000
  rc = sh.Run(probeCmd, 0, True)
  If rc = 0 Then
    healthy = True
    Exit For
  End If
Next

If healthy Then
  MsgBox "Rebuilt and running: http://127.0.0.1:8800" & vbCrLf & _
         "Admin panel:        http://127.0.0.1:8800/admin" & vbCrLf & vbCrLf & _
         "Restart Codex or open a new chat so it reconnects to the fresh proxy.", _
         vbInformation, "anyway2codex reload"
Else
  MsgBox "Build succeeded, but /health on port 8800 did not answer." & vbCrLf & _
         "Check: %USERPROFILE%\.anyway2codex\server.log", vbExclamation, "anyway2codex reload"
End If
