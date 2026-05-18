import sqlite3, json
con = sqlite3.connect('/opt/billing-rtrw/database/billing.db')
cur = con.cursor()
cur.execute('select id,name,host,port,is_active from routers order by id')
rows = cur.fetchall()
print(json.dumps(rows))
