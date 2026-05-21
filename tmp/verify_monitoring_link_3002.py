import sqlite3
TARGETS = ['jamilah1','iwan1','suryani1','budi@cicadas']
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
print('monitoring_state')
for username in TARGETS:
    row = cur.execute("select router_key, username, is_online, profile_name, remote_address, session_uptime, last_online_at, offline_since, updated_at from pppoe_monitoring_state where lower(username)=lower(?) limit 1", (username,)).fetchone()
    print(username, dict(row) if row else None)
print('usage_rows')
for username in TARGETS:
    row = cur.execute("select c.id, c.pppoe_username, count(u.id) as usage_rows from customers c left join customer_usage u on u.customer_id=c.id where lower(c.pppoe_username)=lower(?) group by c.id, c.pppoe_username", (username,)).fetchone()
    print(dict(row) if row else None)
