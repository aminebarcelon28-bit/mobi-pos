import sqlite3
import os

p = os.path.expandvars(r'%APPDATA%\com.mobi.pos\mobi_pos.db')
conn = sqlite3.connect(p)
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%import%'")
print("Tables:", cur.fetchall())

try:
    cur.execute("SELECT * FROM import_batches ORDER BY rowid DESC LIMIT 5")
    print("Batches:")
    for r in cur.fetchall():
        print(r)
except Exception as e:
    print("Error querying batches:", e)

try:
    cur.execute("SELECT batch_id, row_index, raw_json, mapped_json FROM import_staged_rows ORDER BY rowid DESC LIMIT 10")
    print("Staged rows:")
    for r in cur.fetchall():
        print(r)
except Exception as e:
    print("Error querying staged rows:", e)

