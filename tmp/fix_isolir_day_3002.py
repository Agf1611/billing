import sqlite3, shutil, datetime
DB = '/opt/billing-rtrw-3002/database/billing.db'
stamp = datetime.datetime.now().isoformat().replace(':','-').replace('.','-')
backup = DB + f'.isolir-day-fix-{stamp}.bak'
shutil.copyfile(DB, backup)
conn = sqlite3.connect(DB)
cur = conn.cursor()
before = cur.execute("select count(1) from customers where coalesce(isolate_day,0) between 1 and 3").fetchone()[0]
cur.execute("update customers set isolate_day=5 where coalesce(isolate_day,0) between 1 and 3")
changed = conn.total_changes
conn.commit()
after = cur.execute("select count(1) from customers where coalesce(isolate_day,0) between 1 and 3").fetchone()[0]
breakdown = cur.execute("select isolate_day, count(1) from customers where isolate_day=5 group by isolate_day").fetchall()
print({'backup': backup, 'before': before, 'changed': changed, 'after': after, 'breakdown5': breakdown})
