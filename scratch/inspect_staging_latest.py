import sqlite3
import os

p = os.path.expandvars(r'%APPDATA%\com.mobi.pos\import_staging.db')
conn = sqlite3.connect(p)
cur = conn.cursor()
cur.execute("SELECT batch_id, row_index, raw_row_json, normalized_json FROM import_staging_rows ORDER BY rowid DESC LIMIT 10")
for r in cur.fetchall():
    print(r[0], r[1], repr(r[2]), repr(r[3]))

