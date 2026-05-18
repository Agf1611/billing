set -e
node /tmp/tmp-remote-routers.js
printf '\n--- grep ---\n'
grep -n "ensureMonitoringRouterSelected\|data-default-router-id\|global-router-id" /opt/billing-rtrw/views/admin/mikrotik.ejs || true
