# Stops whatever listens on the load-test port (8090) — never touches other node processes.
$c = Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue
foreach ($x in $c) { Stop-Process -Id $x.OwningProcess -Force -ErrorAction SilentlyContinue; "stopped pid $($x.OwningProcess)" }
