set -e
cp /opt/billing-rtrw/services/usageService.js /opt/billing-rtrw/backups/usageService.js.before-reset-usage-$(date +%Y%m%d-%H%M%S)
cp /opt/billing-rtrw/routes/admin/registerCustomerRoutes.js /opt/billing-rtrw/backups/registerCustomerRoutes.js.before-reset-usage-$(date +%Y%m%d-%H%M%S)
cp /opt/billing-rtrw/views/admin/customers.ejs /opt/billing-rtrw/backups/customers.ejs.before-reset-usage-$(date +%Y%m%d-%H%M%S)
install -m 644 /tmp/usageService.js /opt/billing-rtrw/services/usageService.js
install -m 644 /tmp/registerCustomerRoutes.js /opt/billing-rtrw/routes/admin/registerCustomerRoutes.js
install -m 644 /tmp/customers.ejs /opt/billing-rtrw/views/admin/customers.ejs
install -m 644 /tmp/usageService.js /opt/billing-rtrw-3002/services/usageService.js
install -m 644 /tmp/registerCustomerRoutes.js /opt/billing-rtrw-3002/routes/admin/registerCustomerRoutes.js
install -m 644 /tmp/customers.ejs /opt/billing-rtrw-3002/views/admin/customers.ejs
pm2 restart billing-rtrw
pm2 restart billing-rtrw-3002
curl -s http://127.0.0.1:3001/health
echo
curl -s http://127.0.0.1:3002/health
