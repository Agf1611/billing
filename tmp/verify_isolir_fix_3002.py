import sqlite3
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
cur = conn.cursor()
print('remaining_1_3', cur.execute("select count(1) from customers where coalesce(isolate_day,0) between 1 and 3").fetchone()[0])
print('sample_5', cur.execute("select id,name,pppoe_username,isolate_day from customers where isolate_day=5 order by id limit 10").fetchall())
