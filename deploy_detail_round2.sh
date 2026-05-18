#!/bin/bash
set -e
for base in /opt/billing-rtrw /opt/billing-rtrw-3002; do
  cp /home/agf16/customerDetailService.js "$base/services/customerDetailService.js"
  cp /home/agf16/customer_detail_modal.ejs "$base/views/partials/customer_detail_modal.ejs"
  cp /home/agf16/settingsManager.js "$base/config/settingsManager.js"
done
pkill -f '^node /opt/billing-rtrw/app-customer.js$' || true
pkill -f '^node /opt/billing-rtrw-3002/app-customer.js$' || true
cd /opt/billing-rtrw && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &
cd /opt/billing-rtrw-3002 && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &
sleep 4
curl -I -s http://127.0.0.1:3001/admin/login | head -n 1
curl -I -s http://127.0.0.1:3002/admin/login | head -n 1
