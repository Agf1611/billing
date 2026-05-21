import sqlite3
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
for username in ['unang1','rustandi','jamilah1','iwan1','suryani1','budi@cicadas']:
    row = cur.execute("""
      select c.id,c.name,c.pppoe_username,c.status,c.normal_pppoe_profile,c.isolir_profile,c.router_id,
             s.is_online,s.remote_address,s.session_uptime,s.last_online_at,s.offline_since
      from customers c
      left join pppoe_monitoring_state s on lower(s.username)=lower(c.pppoe_username)
      where lower(c.pppoe_username)=lower(?) or lower(c.name)=lower(?)
      limit 1
    """, (username, username)).fetchone()
    print(dict(row) if row else {'target': username, 'missing': True})
