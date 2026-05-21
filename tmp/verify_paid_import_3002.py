import sqlite3
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
print('paid_may_count', cur.execute("select count(1) from invoices where period_month=5 and period_year=2026 and status='paid'").fetchone()[0])
print('paid_may_total', cur.execute("select coalesce(sum(amount),0) from invoices where period_month=5 and period_year=2026 and status='paid'").fetchone()[0])
print('bookkeeping_invoice_count', cur.execute("select count(1) from bookkeeping_entries where source_type='invoice'").fetchone()[0])
print('bookkeeping_may_total', cur.execute("select coalesce(sum(amount),0) from bookkeeping_entries where source_type='invoice' and entry_date like '2026-05-%'").fetchone()[0])
row = cur.execute("select id,name,status,isolate_day from customers where lower(name)='rustandi' limit 1").fetchone()
print('rustandi', dict(row) if row else None)
print('recent_paid')
for row in cur.execute("select c.name, i.amount, i.paid_at, i.paid_by_name from invoices i join customers c on c.id=i.customer_id where i.period_month=5 and i.period_year=2026 and i.status='paid' order by datetime(i.paid_at) desc, i.id desc limit 5"):
    print(dict(row))
