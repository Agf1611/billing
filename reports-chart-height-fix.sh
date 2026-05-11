set -e
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/opt/billing-rtrw/backups/${TS}-reports-chart-height-fix"
printf '2309\n' | sudo -S -p '' mkdir -p "$BACKUP_DIR"
printf '2309\n' | sudo -S -p '' cp /opt/billing-rtrw/views/admin/reports.ejs "$BACKUP_DIR/reports.ejs.bak"
printf '2309\n' | sudo -S -p '' cp /home/agf16/reports.ejs /opt/billing-rtrw/views/admin/reports.ejs
printf '2309\n' | sudo -S -p '' pkill -f '/opt/billing-rtrw/app-customer.js' || true
sleep 2
printf '2309\n' | sudo -S -p '' bash -lc 'cd /opt/billing-rtrw && nohup node app-customer.js >/opt/billing-rtrw/run-out.log 2>&1 </dev/null &' 
sleep 6
curl -s http://127.0.0.1:3001/health
