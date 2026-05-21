import sqlite3, json
TARGETS = [
  ('JAMILAH','jamilah1'),
  ('IWAN','iwan1'),
  ('SURYANI','suryani1'),
  ('budi','budi@cicadas'),
]
for label, dbpath in [('3001','/opt/billing-rtrw/database/billing.db'), ('3002','/opt/billing-rtrw-3002/database/billing.db')]:
    print('===', label, '===')
    conn = sqlite3.connect(dbpath)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    for name, pppoe in TARGETS:
        rows = cur.execute("""
            select c.id, c.name, c.phone, c.address, c.pppoe_username, c.status, c.package_id, c.isolate_day,
                   p.name as package_name, p.price
            from customers c
            left join packages p on p.id = c.package_id
            where lower(c.name)=lower(?) or lower(c.pppoe_username)=lower(?)
            order by c.id
        """, (name, pppoe)).fetchall()
        print(json.dumps({'target': {'name': name, 'pppoe': pppoe}, 'matches': [dict(r) for r in rows]}, ensure_ascii=False))
