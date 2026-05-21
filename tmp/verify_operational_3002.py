import sqlite3
TARGETS = ['jamilah1','iwan1','suryani1','budi@cicadas']
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
print('CUSTOMER + INVOICE CHECK')
for pppoe in TARGETS:
    row = cur.execute("""
      select c.id,c.name,c.pppoe_username,c.status,c.router_id,c.normal_pppoe_profile,c.isolate_day,
             i.id as invoice_id,i.amount,i.status as invoice_status,i.paid_at,i.paid_by_name,i.period_month,i.period_year
      from customers c
      left join invoices i on i.customer_id=c.id and i.period_month=5 and i.period_year=2026
      where lower(c.pppoe_username)=lower(?)
      limit 1
    """, (pppoe,)).fetchone()
    print(dict(row) if row else {'pppoe': pppoe, 'missing': True})
print('PORTAL NOTIF COUNT', cur.execute("select count(1) from customer_portal_notifications where customer_id in (163,164,165,166)").fetchone()[0])
