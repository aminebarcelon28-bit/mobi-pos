function normalizeForSearch(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase();
}

const products = [
  { id: '1', title: 'Câble de charge USB-C', sku: 'CAB-AUT-1001', barcode: '6130000000015', brand: 'Autre', category: 'Câbles' },
  { id: '2', title: 'Souris sans fil', sku: 'PRD-AUT-1002', barcode: '6130000000022', brand: 'Autre', category: 'Tous les produits' },
  { id: '3', title: 'Clé USB 32 Go', sku: 'PRD-AUT-1003', barcode: '6130000000039', brand: 'Autre', category: 'Tous les produits' },
  { id: '4', title: 'Chargeur de téléphone 20 W', sku: 'CHG-AUT-1004', barcode: '6130000000046', brand: 'Autre', category: 'Chargeurs' },
  { id: '5', title: 'Écouteurs filaires', sku: 'AUD-AUT-1005', barcode: '6130000000053', brand: 'Autre', category: 'Audio' },
  { id: '6', title: 'Câble HDMI 2 m', sku: 'CAB-AUT-1006', barcode: '6130000000060', brand: 'Autre', category: 'Câbles' },
  { id: '7', title: 'Batterie externe 10 000 mAh', sku: 'BAT-AUT-1007', barcode: '6130000000077', brand: 'Autre', category: 'Batteries Externes' },
  { id: '8', title: 'Enceinte Bluetooth', sku: 'AUD-AUT-1008', barcode: '6130000000084', brand: 'Autre', category: 'Audio' },
  { id: '9', title: 'Support de refroidissement pour ordinateur portable', sku: 'SUP-AUT-1009', barcode: '6130000000091', brand: 'Autre', category: 'Supports' },
  { id: '10', title: 'Clavier sans fil', sku: 'PRD-AUT-1010', barcode: '6130000000107', brand: 'Autre', category: 'Tous les produits' },
];

function search(query) {
  const q = normalizeForSearch(query.trim());
  const cleanQ = q.replace(/[^a-z0-9]/g, '');
  return products.filter(product => {
    const normTitle = normalizeForSearch(product.title);
    const normSku = normalizeForSearch(product.sku);
    const normBarcode = normalizeForSearch(product.barcode);
    const normBrand = normalizeForSearch(product.brand);
    const normModel = normalizeForSearch(product.compatibleModel);

    if (
      normTitle.includes(q) ||
      normSku.includes(q) ||
      normBarcode.includes(q) ||
      normBrand.includes(q) ||
      normModel.includes(q)
    ) {
      return true;
    }

    if (cleanQ.length >= 3) {
      const cleanSku = normSku.replace(/[^a-z0-9]/g, '');
      const cleanBarcode = normBarcode.replace(/[^a-z0-9]/g, '');
      if (cleanSku.includes(cleanQ) || cleanBarcode.includes(cleanQ)) {
        return true;
      }
    }

    return false;
  });
}

console.log("Searching 'cable':", search('cable').map(p => p.title));
console.log("Searching 'Câble':", search('Câble').map(p => p.title));
console.log("Searching 'souris':", search('souris').map(p => p.title));
console.log("Searching 'cle':", search('cle').map(p => p.title));
console.log("Searching 'Clé':", search('Clé').map(p => p.title));
console.log("Searching 'ecouteur':", search('ecouteur').map(p => p.title));
console.log("Searching 'telephone':", search('telephone').map(p => p.title));
console.log("Searching '6130000000015':", search('6130000000015').map(p => p.title));
console.log("Searching 'CAB-AUT-1001':", search('CAB-AUT-1001').map(p => p.title));
console.log("Searching 'CABAUT1001':", search('CABAUT1001').map(p => p.title));

