' Auto-start the anonymous Q&A site: keep-awake guard + web server + tunnel.
'
' This file is copied into the Windows Startup folder:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AnonAsk.vbs
' so it runs automatically at logon (no admin rights needed, unlike schtasks).
'
' Because it lives outside the project folder, PROJECT_DIR is hardcoded.
' ASCII-only on purpose: .vbs/.bat files with non-ASCII text break depending
' on the console code page.

Option Explicit

Dim sh, fso, base, nodeExe, logDir, psExe

base = "D:\\AI\ Project\\anon-ask"

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If Not fso.FolderExists(base) Then WScript.Quit 1

sh.CurrentDirectory = base

logDir = base & "\logs"
If Not fso.FolderExists(logDir) Then
  fso.CreateFolder(logDir)
End If

' Prefer the standard install paths, fall back to PATH lookup.
nodeExe = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
  nodeExe = """C:\Program Files\nodejs\node.exe"""
End If

psExe = "powershell.exe"
If fso.FileExists("C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe") Then
  psExe = """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"""
End If

' 1) Keep-awake guard: stops idle sleep and Modern Standby suspension.
'    Must be a persistent process - the API is per-thread.
sh.Run "cmd /c " & psExe & " -NoProfile -ExecutionPolicy Bypass -File """ & base & "\keepawake.ps1"" >> """ & logDir & "\keepawake.log"" 2>&1", 0, False

' 2) Web server.
WScript.Sleep 2000
sh.Run "cmd /c " & nodeExe & " server.js >> """ & logDir & "\server.out.log"" 2>&1", 0, False

' 3) Tunnel.
WScript.Sleep 3000
sh.Run "cmd /c " & nodeExe & " ngrok.mjs >> """ & logDir & "\ngrok-sup.out.log"" 2>&1", 0, False
