import sqlite3
import os

p = os.path.expandvars(r'%APPDATA%\com.mobi.pos\import_staging.db')
if os.path.exists(p):
    conn = sqlite3.connect(p)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    print("Staging tables:", cur.fetchall())
    cur.execute("SELECT * FROM import_batches")
    batches = cur.fetchall()
    print("Batches count:", len(batches))
    for b in batches:
        print(b)
    cur.execute("SELECT row_index, raw_row_json, normalized_json FROM import_staging_rows LIMIT 5")
    for r in cur.fetchall():
        print("Row:", r[0], repr(r[1]), repr(r[2]))
else:
    print("import_staging.db not found at", p)

