import sqlite3
import os

for path in [
    os.path.expandvars(r'%APPDATA%\com.mobi.pos\mobi_pos.db'),
    r'c:\Users\Click\Desktop\phone3-sync-lab\mobi_pos.db',
    r'c:\Users\Click\Desktop\phone3-sync-lab\src-tauri\mobi_pos.db'
]:
    if os.path.exists(path):
        conn = sqlite3.connect(path)
        cur = conn.cursor()
        print("=== Checking:", path)
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [r[0] for r in cur.fetchall()]
        print("Table count:", len(tables))
        import_tables = [t for t in tables if 'import' in t]
        print("Import tables:", import_tables)
        if 'import_batches' in import_tables:
            cur.execute("SELECT * FROM import_batches")
            print("Import batches:", cur.fetchall())
        if 'products' in tables:
            cur.execute("SELECT count(*) FROM products")
            print("Product count:", cur.fetchone()[0])
            cur.execute("SELECT id, title, stock, price, category FROM products WHERE id LIKE '%batch%' OR id LIKE '%prod_%' ORDER BY rowid DESC LIMIT 10")
            print("Batch products:")
            for p in cur.fetchall():
                print("  ", p)

