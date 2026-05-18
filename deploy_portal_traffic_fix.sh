#!/bin/bash
set -e
for base in /opt/billing-rtrw /opt/billing-rtrw-3002; do
  cp /home/agf16/dashboard.ejs "$base/views/dashboard.ejs"
  cp /home/agf16/dashboard_home_screen.ejs "$base/views/partials/customer/dashboard_home_screen.ejs"
  cp /home/agf16/customer_detail_modal.ejs "$base/views/partials/customer_detail_modal.ejs"
done
pkill -f '^node /opt/billing-rtrw/app-customer.js$' || true
pkill -f '^node /opt/billing-rtrw-3002/app-customer.js$' || true
cd /opt/billing-rtrw && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &
cd /opt/billing-rtrw-3002 && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &
sleep 4
curl -I -s http://127.0.0.1:3001/customer/login | sed -n '1p'
curl -I -s http://127.0.0.1:3002/customer/login | sed -n '1p'
