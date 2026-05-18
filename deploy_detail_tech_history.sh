#!/bin/bash
set -e
printf '2309\n' | sudo -S -p '' cp /home/agf16/customerDetailService.js /opt/billing-rtrw/services/customerDetailService.js
printf '2309\n' | sudo -S -p '' cp /home/agf16/customerDetailService.js /opt/billing-rtrw-3002/services/customerDetailService.js
printf '2309\n' | sudo -S -p '' cp /home/agf16/customer_detail_modal.ejs /opt/billing-rtrw/views/partials/customer_detail_modal.ejs
printf '2309\n' | sudo -S -p '' cp /home/agf16/customer_detail_modal.ejs /opt/billing-rtrw-3002/views/partials/customer_detail_modal.ejs
printf '2309\n' | sudo -S -p '' pkill -f '^node /opt/billing-rtrw/app-customer.js$' || true
printf '2309\n' | sudo -S -p '' pkill -f '^node /opt/billing-rtrw-3002/app-customer.js$' || true
printf '2309\n' | sudo -S -p '' bash -lc 'cd /opt/billing-rtrw && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &'
printf '2309\n' | sudo -S -p '' bash -lc 'cd /opt/billing-rtrw-3002 && nohup node app-customer.js >/dev/null 2>&1 < /dev/null &'
sleep 4
curl -I -s http://127.0.0.1:3001/admin/login | sed -n '1p'
curl -I -s http://127.0.0.1:3001/tech/login | sed -n '1p'
