set -e
TS=$(date +%Y%m%d-%H%M%S)
APP=/opt/billing-rtrw
if [ -f "$APP/routes/adminPortal.js" ]; then cp "$APP/routes/adminPortal.js" "$APP/routes/adminPortal.js.sticky-$TS"; fi
install -D /home/agf16/adminPortal.js "$APP/routes/adminPortal.js"
pkill -f '/opt/billing-rtrw/app-customer.js' || true
cd "$APP"
nohup node app-customer.js >/dev/null 2>&1 &
sleep 4
curl -I -s http://127.0.0.1:3001/admin/login | head -n 1
rm -f /home/agf16/adminPortal.js /home/agf16/deploy_sticky_settings.sh