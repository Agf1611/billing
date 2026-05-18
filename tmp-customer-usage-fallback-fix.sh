set -e
install -m 644 /tmp/customerPortal.js /opt/billing-rtrw/routes/customerPortal.js
install -m 644 /tmp/customerPortal.js /opt/billing-rtrw-3002/routes/customerPortal.js
pm2 restart billing-rtrw
pm2 restart billing-rtrw-3002
curl -s http://127.0.0.1:3001/health
echo
curl -s http://127.0.0.1:3002/health
