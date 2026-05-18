#!/bin/bash
set -e
stamp=$(date +%Y%m%d-%H%M%S)
for base in /opt/billing-rtrw /opt/billing-rtrw-3002; do
  cp "$base/services/customerDetailService.js" "$base/services/customerDetailService.js.detailfix-$stamp" 2>/dev/null || true
  cp "$base/services/mikrotikService.js" "$base/services/mikrotikService.js.detailfix-$stamp" 2>/dev/null || true
  cp "$base/config/database.js" "$base/config/database.js.detailfix-$stamp" 2>/dev/null || true
  cp "$base/routes/admin/registerCustomerRoutes.js" "$base/routes/admin/registerCustomerRoutes.js.detailfix-$stamp" 2>/dev/null || true
  cp "$base/routes/techPortal.js" "$base/routes/techPortal.js.detailfix-$stamp" 2>/dev/null || true
  cp "$base/views/partials/customer_detail_modal.ejs" "$base/views/partials/customer_detail_modal.ejs.detailfix-$stamp" 2>/dev/null || true
  cp /home/agf16/customerDetailService.js "$base/services/customerDetailService.js"
  cp /home/agf16/mikrotikService.js "$base/services/mikrotikService.js"
  cp /home/agf16/database.js "$base/config/database.js"
  cp /home/agf16/registerCustomerRoutes.js "$base/routes/admin/registerCustomerRoutes.js"
  cp /home/agf16/techPortal.js "$base/routes/techPortal.js"
  cp /home/agf16/customer_detail_modal.ejs "$base/views/partials/customer_detail_modal.ejs"
done
pkill -f '^node /opt/billing-rtrw/app-customer.js$' || true
pkill -f '^node /opt/billing-rtrw-3002/app-customer.js$' || true
cd /opt/billing-rtrw && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &
cd /opt/billing-rtrw-3002 && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &
sleep 4
curl -I -s http://127.0.0.1:3001/admin/login | head -n 1
curl -I -s http://127.0.0.1:3002/admin/login | head -n 1
