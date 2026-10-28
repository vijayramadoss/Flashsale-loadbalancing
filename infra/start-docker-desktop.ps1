# Starts Docker Desktop on this laptop, working around a Windows quirk seen on
# 2026-10-29: after Docker Desktop crashes (it did while C: was full), the
# AF_UNIX socket files it leaves behind cannot be deleted ("The file cannot be
# accessed by the system", error 1920), and every later start crashes trying
# to remove them. Renaming the folders that hold them works, and Docker then
# creates fresh ones. Docker's data disk lives on E:\DockerDesktopWSL
# (settings-store.json → CustomWslDistroDir).
$ErrorActionPreference = 'Stop'
$docker = "$env:LOCALAPPDATA\Programs\DockerDesktop"
Get-Process 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue | Stop-Process -Force
wsl.exe --shutdown
Start-Sleep -Seconds 2

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($dir in "$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine") {
  if (Test-Path $dir) { Rename-Item $dir "$(Split-Path $dir -Leaf).stale-$stamp"; "moved aside $dir" }
}

Start-Process "$docker\Docker Desktop.exe"
foreach ($i in 1..90) {
  $v = & "$docker\resources\bin\docker.exe" version --format '{{.Server.Version}}' 2>$null
  if ($v) { "Docker engine $v is up"; exit 0 }
  Start-Sleep -Seconds 2
}
"Docker did not come up in 180 s - see $env:LOCALAPPDATA\Docker\log\host\com.docker.backend.exe.log"
exit 1
