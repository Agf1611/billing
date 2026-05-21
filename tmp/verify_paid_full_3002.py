import sqlite3
TARGETS = ['jamilah1','iwan1','suryani1','budi@cicadas']
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
print('paid_may_count', cur.execute("select count(1) from invoices where period_month=5 and period_year=2026 and status='paid'").fetchone()[0])
print('paid_may_total', cur.execute("select coalesce(sum(amount),0) from invoices where period_month=5 and period_year=2026 and status='paid'").fetchone()[0])
print('bookkeeping_may_total', cur.execute("select coalesce(sum(amount),0) from bookkeeping_entries where source_type='invoice' and entry_date like '2026-05-%'").fetchone()[0])
print('customers_total', cur.execute("select count(1) from customers").fetchone()[0])
for pppoe in TARGETS:
    row = cur.execute("select id,name,phone,address,pppoe_username,status,isolate_day from customers where lower(pppoe_username)=lower(?) limit 1", (pppoe,)).fetchone()
    print('target', pppoe, dict(row) if row else None)
PY
