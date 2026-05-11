set -e
TS=$(date +%Y%m%d-%H%M%S)
APP=/opt/billing-rtrw
backup() {
  src="$1"
  if [ -f "$src" ]; then
    cp "$src" "$src.profileclean-$TS"
  fi
}
backup "$APP/routes/adminPortal.js"
backup "$APP/views/admin/partials/sidebar.ejs"
backup "$APP/views/admin/settings.ejs"
backup "$APP/views/admin/billing.ejs"
backup "$APP/views/admin/customers.ejs"
backup "$APP/views/dashboard.ejs"
backup "$APP/views/public_check_billing.ejs"
backup "$APP/views/admin/print_invoice.ejs"
backup "$APP/services/whatsappBot.mjs"
backup "$APP/settings.json"
install -D /home/agf16/adminPortal.js "$APP/routes/adminPortal.js"
install -D /home/agf16/sidebar.ejs "$APP/views/admin/partials/sidebar.ejs"
install -D /home/agf16/settings.ejs "$APP/views/admin/settings.ejs"
install -D /home/agf16/billing.ejs "$APP/views/admin/billing.ejs"
install -D /home/agf16/customers.ejs "$APP/views/admin/customers.ejs"
install -D /home/agf16/dashboard.ejs "$APP/views/dashboard.ejs"
install -D /home/agf16/public_check_billing.ejs "$APP/views/public_check_billing.ejs"
install -D /home/agf16/print_invoice.ejs "$APP/views/admin/print_invoice.ejs"
install -D /home/agf16/whatsappBot.mjs "$APP/services/whatsappBot.mjs"
install -D /home/agf16/settings.json "$APP/settings.json"
pkill -f '/opt/billing-rtrw/app-customer.js' || true
cd "$APP"
nohup node app-customer.js >/dev/null 2>&1 &
sleep 4
curl -I -s http://127.0.0.1:3001/admin/login | head -n 1
curl -I -s http://127.0.0.1:3001/customer/login | head -n 1
rm -f /home/agf16/adminPortal.js /home/agf16/sidebar.ejs /home/agf16/settings.ejs /home/agf16/billing.ejs /home/agf16/customers.ejs /home/agf16/dashboard.ejs /home/agf16/public_check_billing.ejs /home/agf16/print_invoice.ejs /home/agf16/whatsappBot.mjs /home/agf16/settings.json /home/agf16/deploy_profile_cleanup.sh