import hashlib

with open(r'C:\Users\Click\.gemini\antigravity\brain\dc29124b-f2b8-4d1b-80ab-3522df1cbed1\.user_uploaded\media_1792601638114_33ff942c.csv', 'rb') as f:
    raw = f.read()

print("Uploaded file size:", len(raw))
print("Uploaded file sha256:", hashlib.sha256(raw).hexdigest())
print("First 200 bytes repr:")
print(repr(raw[:200]))

