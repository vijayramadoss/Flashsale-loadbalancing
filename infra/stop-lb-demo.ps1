# Stops everything started by start-lb-demo.ps1 (only processes using backend/.env.sim, and the demo NGINX).
$root = Split-Path $PSScriptRoot -Parent
$nginx = 'E:\tools\nginx-1.28.0'
& "$nginx\nginx.exe" -p "$($nginx -replace '\\','/')/" -c "$($root -replace '\\','/')/infra/nginx.local.conf" -s quit 2>$null
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match '\.env\.sim' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped node $($_.ProcessId)" }
