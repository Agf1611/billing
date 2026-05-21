import sqlite3
updates = [
  ('jamilah1', 'Auto dibuat dari master pelanggan untuk impor lunas Mei 2026 | legacyId 107 | area kp cicadas | router sickas'),
  ('iwan1', 'Auto dibuat dari master pelanggan untuk impor lunas Mei 2026 | legacyId 93 | area pasirkalapa | router sickas'),
  ('suryani1', 'Auto dibuat dari master pelanggan untuk impor lunas Mei 2026 | legacyId 123 | area kp cicadas | router sickas'),
  ('budi@cicadas', 'Auto dibuat dari master pelanggan untuk impor lunas Mei 2026 | legacyId 204 | area kp cicadas | router sickas | modem gm220')
]
conn = sqlite3.connect('/opt/billing-rtrw-3002/database/billing.db')
cur = conn.cursor()
for pppoe, notes in updates:
    cur.execute("update customers set notes=? where lower(pppoe_username)=lower(?)", (notes, pppoe))
conn.commit()
print('updated', conn.total_changes)
for pppoe, _ in updates:
    row = cur.execute("select id,name,pppoe_username,notes from customers where lower(pppoe_username)=lower(?)", (pppoe,)).fetchone()
    print(row)
