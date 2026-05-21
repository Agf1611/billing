import sqlite3
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
cur = conn.cursor()
for label, sql in [
  ('before_total_1_3', "select count(1) from customers where coalesce(isolate_day,0) between 1 and 3"),
  ('before_breakdown', "select isolate_day, count(1) from customers where coalesce(isolate_day,0) between 1 and 3 group by isolate_day order by isolate_day")
]:
    print(label)
    rows = cur.execute(sql).fetchall()
    print(rows)
