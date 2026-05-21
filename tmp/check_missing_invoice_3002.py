import sqlite3
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
period_month = 5
period_year = 2026
q = """
select c.id, c.name, c.pppoe_username, c.status, c.install_date, c.isolate_day,
       p.name as package_name,
       case
         when c.install_date is not null and substr(c.install_date,1,7)=? then 1
         else 0
       end as is_new_this_month
from customers c
left join packages p on p.id = c.package_id
left join invoices i
  on i.customer_id = c.id and i.period_month = ? and i.period_year = ?
where i.id is null
  and c.package_id is not null
  and c.status in ('active','suspended')
order by is_new_this_month desc, date(c.install_date) desc, c.name asc
"""
rows = cur.execute(q, (f'{period_year}-{period_month:02d}', period_month, period_year)).fetchall()
summary = {
  'total_without_invoice': len(rows),
  'new_this_month_without_invoice': sum(1 for r in rows if r['is_new_this_month'] == 1),
  'older_without_invoice': sum(1 for r in rows if r['is_new_this_month'] != 1),
}
print(summary)
print('OLDER_WITHOUT_INVOICE')
for r in rows:
    if r['is_new_this_month'] != 1:
        print(dict(r))
print('NEW_THIS_MONTH_WITHOUT_INVOICE')
for r in rows:
    if r['is_new_this_month'] == 1:
        print(dict(r))
