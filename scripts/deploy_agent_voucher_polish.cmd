@echo off
setlocal

set PSCP="C:\Program Files\PuTTY\pscp.exe"
set PLINK="C:\Program Files\PuTTY\plink.exe"
set HOST=agf16@192.168.1.10
set PASS=2309
set ROOT=C:\xampp\htdocs\billing

%PSCP% -batch -pw %PASS% "%ROOT%\views\agent\dashboard.ejs" %HOST%:/tmp/dashboard.ejs || exit /b 1
%PSCP% -batch -pw %PASS% "%ROOT%\views\agent\print_thermal_voucher.ejs" %HOST%:/tmp/print_thermal_voucher.ejs || exit /b 1
%PSCP% -batch -pw %PASS% "%ROOT%\views\admin\vouchers.ejs" %HOST%:/tmp/vouchers.ejs || exit /b 1
%PSCP% -batch -pw %PASS% "%ROOT%\views\admin\print_vouchers.ejs" %HOST%:/tmp/print_vouchers.ejs || exit /b 1
%PSCP% -batch -pw %PASS% "%ROOT%\routes\agentPortal.js" %HOST%:/tmp/agentPortal.js || exit /b 1

%PLINK% -batch -ssh -pw %PASS% %HOST% "echo 2309 | sudo -S install -m 644 /tmp/dashboard.ejs /opt/billing-rtrw/views/agent/dashboard.ejs && echo 2309 | sudo -S install -m 644 /tmp/dashboard.ejs /opt/billing-rtrw-3002/views/agent/dashboard.ejs && echo 2309 | sudo -S install -m 644 /tmp/print_thermal_voucher.ejs /opt/billing-rtrw/views/agent/print_thermal_voucher.ejs && echo 2309 | sudo -S install -m 644 /tmp/print_thermal_voucher.ejs /opt/billing-rtrw-3002/views/agent/print_thermal_voucher.ejs && echo 2309 | sudo -S install -m 644 /tmp/vouchers.ejs /opt/billing-rtrw/views/admin/vouchers.ejs && echo 2309 | sudo -S install -m 644 /tmp/vouchers.ejs /opt/billing-rtrw-3002/views/admin/vouchers.ejs && echo 2309 | sudo -S install -m 644 /tmp/print_vouchers.ejs /opt/billing-rtrw/views/admin/print_vouchers.ejs && echo 2309 | sudo -S install -m 644 /tmp/print_vouchers.ejs /opt/billing-rtrw-3002/views/admin/print_vouchers.ejs && echo 2309 | sudo -S install -m 644 /tmp/agentPortal.js /opt/billing-rtrw/routes/agentPortal.js && echo 2309 | sudo -S install -m 644 /tmp/agentPortal.js /opt/billing-rtrw-3002/routes/agentPortal.js" || exit /b 1

%PLINK% -batch -ssh -pw %PASS% %HOST% "sh -lc \"for pid in \$(pgrep -f '/opt/billing-rtrw/app-customer.js'); do echo 2309 | sudo -S kill \$pid; done 2>/dev/null || true; for pid in \$(pgrep -f '/opt/billing-rtrw-3002/app-customer.js'); do echo 2309 | sudo -S kill \$pid; done 2>/dev/null || true; nohup node /opt/billing-rtrw/app-customer.js >/tmp/billing3001.out 2>/tmp/billing3001.err < /dev/null & nohup node /opt/billing-rtrw-3002/app-customer.js >/tmp/billing3002.out 2>/tmp/billing3002.err < /dev/null & sleep 5; curl -s -o /dev/null -w '3001-admin %{http_code}\n' http://127.0.0.1:3001/admin/login; curl -s -o /dev/null -w '3001-agent %{http_code}\n' http://127.0.0.1:3001/agent/login; curl -s -o /dev/null -w '3001-customer %{http_code}\n' http://127.0.0.1:3001/customer/login; curl -s -o /dev/null -w '3002-admin %{http_code}\n' http://127.0.0.1:3002/admin/login; curl -s -o /dev/null -w '3002-agent %{http_code}\n' http://127.0.0.1:3002/agent/login; curl -s -o /dev/null -w '3002-customer %{http_code}\n' http://127.0.0.1:3002/customer/login; grep -n -m 1 'Voucher WiFi' /opt/billing-rtrw/routes/agentPortal.js; grep -n -m 1 'agentThemeToggle' /opt/billing-rtrw/views/agent/dashboard.ejs; grep -n -m 1 'Thermal Bluetooth' /opt/billing-rtrw/views/admin/vouchers.ejs\"" || exit /b 1

endlocal
