import sqlite3
import os
import json

p = os.path.expandvars(r'%APPDATA%\com.mobi.pos\mobi_pos.db')
conn = sqlite3.connect(p)
conn.row_factory = sqlite3.Row
cur = conn.cursor()
cur.execute("SELECT * FROM products WHERE id LIKE 'prod_batch_0c514277_1792601581432_%'")
rows = cur.fetchall()
print(f"Found {len(rows)} rows:")
for r in rows:
    d = dict(r)
    print("ID:", d.get('id'))
    print("  title:", repr(d.get('title')))
    print("  sku:", repr(d.get('sku')))
    print("  barcode:", repr(d.get('barcode')))
    print("  brand:", repr(d.get('brand')))
    print("  category:", repr(d.get('category')))
    print("  stock:", d.get('stock'))
    print("  price:", d.get('price'))
    print("  cost_price:", d.get('cost_price'))
    print("  deleted:", d.get('deleted'))
    print("  json_payload:", repr(d.get('json_payload')[:100] if d.get('json_payload') else None))

