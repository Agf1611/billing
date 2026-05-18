set -e
install -m 644 /tmp/customers.ejs /opt/billing-rtrw/views/admin/customers.ejs
install -m 644 /tmp/customers.ejs /opt/billing-rtrw-3002/views/admin/customers.ejs
pm2 restart billing-rtrw
pm2 restart billing-rtrw-3002
curl -s http://127.0.0.1:3001/health
echo
curl -s http://127.0.0.1:3002/health
