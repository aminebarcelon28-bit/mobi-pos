with open(r'C:\Users\Click\Desktop\produits_stock_prix_fr.csv', 'rb') as f:
    raw = f.read()

print("File size:", len(raw))
print("First 200 bytes repr:")
print(repr(raw[:200]))

# Check if UTF-8
try:
    text_utf8 = raw.decode('utf-8')
    print("Decodes as UTF-8 cleanly!")
except Exception as e:
    print("UTF-8 decode failed:", e)

# Check Windows-1252
try:
    text_cp1252 = raw.decode('cp1252')
    print("Decodes as CP1252 cleanly!")
except Exception as e:
    print("CP1252 decode failed:", e)

