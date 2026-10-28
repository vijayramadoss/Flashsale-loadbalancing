# Starts the load-balancer demo on this machine:
#   3 stateless API replicas (api-1..3 on ports 4001-4003)
#   2 order workers sharing the Redis Streams consumer group
#   NGINX on http://127.0.0.1:8088 balancing across the replicas (least_conn)
#   CDN edge (second NGINX, pull-through cache) on http://127.0.0.1:8090 for the built assets
# Uses the isolated "sim" database / Redis prefix from backend/.env.sim.
# Prerequisites: MongoDB (rs0 on 27018) and Redis running; `npm run build:cdn` done in frontend/
# (plain `npm run build` also works: assets are then served by :8088 itself).
# Stop with infra/stop-lb-demo.ps1.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$backend = Join-Path $root 'backend'
$logs = Join-Path $root '.data\logs'
$nginx = 'E:\tools\nginx-1.28.0'
New-Item -ItemType Directory -Force $logs | Out-Null

foreach ($i in 1..3) {
  # Child processes inherit the current environment; variables beat the .env files.
  $env:PORT = "$(4000 + $i)"
  $env:REPLICA_ID = "api-$i"
  Start-Process node -ArgumentList '--env-file=.env', '--env-file=.env.sim', 'src/server.js' -WorkingDirectory $backend `
    -WindowStyle Hidden -RedirectStandardOutput "$logs\sim-api-$i.log" -RedirectStandardError "$logs\sim-api-$i.err.log"
}
foreach ($i in 1..2) {
  $env:REPLICA_ID = "worker-$i"
  Start-Process node -ArgumentList '--env-file=.env', '--env-file=.env.sim', 'src/worker.js' -WorkingDirectory $backend `
    -WindowStyle Hidden -RedirectStandardOutput "$logs\sim-worker-$i.log" -RedirectStandardError "$logs\sim-worker-$i.err.log"
}
Remove-Item Env:PORT, Env:REPLICA_ID -ErrorAction SilentlyContinue

Start-Process "$nginx\nginx.exe" -ArgumentList '-p', "$($nginx -replace '\\','/')/", '-c', "$($root -replace '\\','/')/infra/nginx.local.conf" `
  -WorkingDirectory $nginx -WindowStyle Hidden
Start-Process "$nginx\nginx.exe" -ArgumentList '-p', "$($nginx -replace '\\','/')/", '-c', "$($root -replace '\\','/')/infra/cdn.local.conf" `
  -WorkingDirectory $nginx -WindowStyle Hidden

Start-Sleep -Seconds 3
foreach ($port in 4001, 4002, 4003, 8088) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/health" -TimeoutSec 3
    "port $port -> $($r.StatusCode) served by $($r.Headers['X-Served-By'])"
  } catch { "port $port -> NOT RESPONDING ($($_.Exception.Message))" }
}
"Store via load balancer: http://127.0.0.1:8088   (CDN edge: http://127.0.0.1:8090, check with: node scripts/cdn-check.js)"
