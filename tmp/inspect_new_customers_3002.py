import sqlite3
TARGETS = ['jamilah1','iwan1','suryani1','budi@cicadas']
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
for pppoe in TARGETS:
    row = cur.execute("""
      select c.id,c.name,c.phone,c.address,c.package_id,p.name as package_name,p.price,p.pppoe_profile,
             c.router_id,r.name as router_name,c.lat,c.lng,c.pppoe_username,c.normal_pppoe_profile,
             c.status,c.install_date,c.notes,c.nik,c.genieacs_tag,c.auto_isolate,c.isolate_day
      from customers c
      left join packages p on p.id=c.package_id
      left join routers r on r.id=c.router_id
      where lower(c.pppoe_username)=lower(?)
      limit 1
    """, (pppoe,)).fetchone()
    print(dict(row) if row else {'pppoe': pppoe, 'missing': True})
