import sqlite3
import os

p = os.path.expandvars(r'%APPDATA%\com.mobi.pos\import_staging.db')
conn = sqlite3.connect(p)
cur = conn.cursor()
cur.execute("SELECT raw_row_json FROM import_staging_rows WHERE batch_id='batch_0c514277_1792625659333' AND row_index=0")
row = cur.fetchone()[0]
print("Raw string:", repr(row))
for i, ch in enumerate(row):
    print(f"[{i}] {repr(ch)} : U+{ord(ch):04X}")

