import hashlib

with open(r'C:\Users\Click\Desktop\produits_stock_prix_fr.csv', 'rb') as f:
    h = hashlib.sha256(f.read()).hexdigest()

print("Desktop file sha256:", h)

