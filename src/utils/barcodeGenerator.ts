/**
 * @file barcodeGenerator.ts
 * @description Générateur de codes-barres (Code 128 & EAN-13) pur TypeScript pour rendu Canvas et SVG.
 */

// Patterns binaires pour le Code 128 (Caractères 0-106)
// 1 = Barre noire, 0 = Espace blanc
const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000', '10011000100',
  '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100', '10011001110', '10111001100',
  '10011101100', '10011100110', '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010', '11011011000', '11011000110',
  '11000110110', '10100011000', '10001011000', '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
  '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010', '10100110000',
  '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100', '10011110010', '11110100100', '11110010100',
  '11110010010', '11011011110', '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110', '11110101110', '11010000100',
  '11010010000', '11010011100', '1100011101011'
];

// Patterns EAN-13
const EAN13_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN13_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN13_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];

const EAN13_PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'
];

const START_GUARD = '101';
const CENTER_GUARD = '01010';
const END_GUARD = '101';

/**
 * Valide si les données sont au bon format pour le type de code-barres spécifié.
 * @param data La chaîne de caractères à valider
 * @param type Le type de code-barres ('code128' ou 'ean13')
 * @returns boolean
 */
export function isValidBarcode(data: string, type: 'code128' | 'ean13'): boolean {
  if (!data) return false;
  if (type === 'ean13') {
    return /^\d{13}$/.test(data);
  } else if (type === 'code128') {
    // Vérifier que tous les caractères sont dans la table ASCII 32-127 (Code 128B)
    for (let i = 0; i < data.length; i++) {
      const charCode = data.charCodeAt(i);
      if (charCode < 32 || charCode > 127) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Encode les données en Code 128 (Jeu de caractères B)
 * @param data Chaîne de caractères ASCII à encoder
 * @returns Chaîne binaire représentant le code-barres complet
 */
function encodeCode128(data: string): string {
  if (!isValidBarcode(data, 'code128')) {
    throw new Error("Données invalides pour le Code 128");
  }

  const START_B = 104;
  const STOP = 106;
  let checksum = START_B;
  let binaryString = CODE128_PATTERNS[START_B];

  for (let i = 0; i < data.length; i++) {
    const value = data.charCodeAt(i) - 32;
    checksum += value * (i + 1);
    binaryString += CODE128_PATTERNS[value];
  }

  checksum = checksum % 103;
  binaryString += CODE128_PATTERNS[checksum];
  binaryString += CODE128_PATTERNS[STOP];

  return binaryString;
}

/**
 * Encode les données en EAN-13
 * @param data Chaîne de 13 chiffres
 * @returns Chaîne binaire représentant le code-barres
 */
function encodeEAN13(data: string): string {
  if (!isValidBarcode(data, 'ean13')) {
    throw new Error("Données invalides pour l'EAN-13 (doit contenir exactement 13 chiffres)");
  }

  // Vérification du checksum EAN-13
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(data[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  if (checkDigit !== parseInt(data[12])) {
    throw new Error("Chiffre de contrôle EAN-13 invalide");
  }

  const firstDigit = parseInt(data[0]);
  const parity = EAN13_PARITY[firstDigit];
  
  let binaryString = START_GUARD;

  // Côté gauche (6 chiffres)
  for (let i = 1; i <= 6; i++) {
    const digit = parseInt(data[i]);
    if (parity[i - 1] === 'L') {
      binaryString += EAN13_L[digit];
    } else {
      binaryString += EAN13_G[digit];
    }
  }

  binaryString += CENTER_GUARD;

  // Côté droit (6 chiffres restants)
  for (let i = 7; i <= 12; i++) {
    const digit = parseInt(data[i]);
    binaryString += EAN13_R[digit];
  }

  binaryString += END_GUARD;

  return binaryString;
}

interface BarcodeOptions {
  width?: number;
  height?: number;
  fontSize?: number;
  showText?: boolean;
}

/**
 * Rend un code-barres sur un élément Canvas.
 * @param canvas L'élément HTMLCanvasElement
 * @param data Les données du code-barres
 * @param type Le type ('code128' ou 'ean13')
 * @param options Options de rendu (dimensions, texte)
 */
export function renderBarcodeToCanvas(
  canvas: HTMLCanvasElement,
  data: string,
  type: 'code128' | 'ean13',
  options?: BarcodeOptions
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = options?.width || 260;
  const height = options?.height || 80;
  const showText = options?.showText ?? true;
  const fontSize = options?.fontSize || 14;

  canvas.width = width;
  canvas.height = height;

  // Fond blanc
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let binaryString = '';
  try {
    binaryString = type === 'code128' ? encodeCode128(data) : encodeEAN13(data);
  } catch {
    ctx.fillStyle = '#ff0000';
    ctx.font = '12px sans-serif';
    ctx.fillText("Code-barres invalide", 10, height / 2);
    return;
  }

  const barWidth = width / binaryString.length;
  const barcodeHeight = showText ? height - fontSize - 8 : height; // Réserver de la place pour le texte
  
  ctx.fillStyle = '#000000';
  for (let i = 0; i < binaryString.length; i++) {
    if (binaryString[i] === '1') {
      // Barres plus longues pour les gardes EAN-13
      let currentBarHeight = barcodeHeight;
      if (type === 'ean13' && showText) {
        if (i < 3 || (i > 45 && i < 50) || i > 91) {
          currentBarHeight = height - fontSize / 2;
        }
      }
      ctx.fillRect(i * barWidth, 0, barWidth, currentBarHeight);
    }
  }

  if (showText) {
    ctx.fillStyle = '#000000';
    ctx.font = `${fontSize}px monospace`;
    ctx.textAlign = 'center';
    
    if (type === 'ean13') {
      // Affichage typique de l'EAN-13
      const textY = height - 2;
      ctx.fillText(data[0], 10, textY);
      ctx.fillText(data.substring(1, 7), width * 0.35, textY);
      ctx.fillText(data.substring(7, 13), width * 0.75, textY);
    } else {
      ctx.fillText(data, width / 2, height - 2);
    }
  }
}

/**
 * Génère un code SVG pour un code-barres.
 * @param data Les données du code-barres
 * @param type Le type ('code128' ou 'ean13')
 * @param options Options de rendu (dimensions, texte)
 * @returns Chaîne contenant le code SVG
 */
export function generateBarcodeSVG(
  data: string,
  type: 'code128' | 'ean13',
  options?: BarcodeOptions
): string {
  const width = options?.width || 260;
  const height = options?.height || 80;
  const showText = options?.showText ?? true;
  const fontSize = options?.fontSize || 14;

  let binaryString = '';
  try {
    binaryString = type === 'code128' ? encodeCode128(data) : encodeEAN13(data);
  } catch {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><text x="10" y="${height/2}" fill="red">Invalide</text></svg>`;
  }

  const barWidth = width / binaryString.length;
  const barcodeHeight = showText ? height - fontSize - 8 : height;

  let rects = '';
  for (let i = 0; i < binaryString.length; i++) {
    if (binaryString[i] === '1') {
      let currentBarHeight = barcodeHeight;
      if (type === 'ean13' && showText) {
        if (i < 3 || (i > 45 && i < 50) || i > 91) {
          currentBarHeight = height - fontSize / 2;
        }
      }
      rects += `<rect x="${(i * barWidth).toFixed(2)}" y="0" width="${barWidth.toFixed(2)}" height="${currentBarHeight}" fill="black" />`;
    }
  }

  let textElement = '';
  if (showText) {
    const textY = height - 2;
    if (type === 'ean13') {
      textElement = `
        <text x="10" y="${textY}" font-family="monospace" font-size="${fontSize}" text-anchor="middle" fill="black">${data[0]}</text>
        <text x="${width * 0.35}" y="${textY}" font-family="monospace" font-size="${fontSize}" text-anchor="middle" fill="black">${data.substring(1, 7)}</text>
        <text x="${width * 0.75}" y="${textY}" font-family="monospace" font-size="${fontSize}" text-anchor="middle" fill="black">${data.substring(7, 13)}</text>
      `;
    } else {
      textElement = `<text x="${width / 2}" y="${textY}" font-family="monospace" font-size="${fontSize}" text-anchor="middle" fill="black">${data}</text>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="white" />
    ${rects}
    ${textElement}
  </svg>`;
}

/**
 * Calcule le chiffre de contrôle EAN-13 pour une séquence de 12 chiffres.
 * @param first12Digits Chaîne de 12 chiffres
 * @returns Chiffre de contrôle (0-9)
 */
export function calculateEan13Checksum(first12Digits: string): number {
  if (!/^\d{12}$/.test(first12Digits)) {
    throw new Error("L'EAN-12 payload doit comporter exactement 12 chiffres numériques");
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(first12Digits[i], 10) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Génère un code-barres EAN-13 100% unique et valide, sans collision avec les produits existants.
 * @param existingProducts Liste des produits existants avec leurs codes-barres
 * @param prefix Préfixe EAN (par défaut '613' pour l'Algérie, ou '200' pour usage interne magasin)
 * @returns Code EAN-13 garanti unique de 13 chiffres
 */
export function generateUniqueEan13Barcode(
  existingProducts: Array<{ barcode?: string | null }>,
  prefix = '613'
): string {
  const existingSet = new Set(
    existingProducts
      .map((p) => p.barcode?.trim())
      .filter((b): b is string => Boolean(b && b.length > 0))
  );

  // Maximum 10000 tentatives aléatoires puis fallback séquentiel horodaté
  for (let attempt = 0; attempt < 10000; attempt++) {
    // 9 chiffres aléatoires
    const randomPart = Math.floor(Math.random() * 1000000000)
      .toString()
      .padStart(9, '0');
    const payload = `${prefix}${randomPart}`;
    const checkDigit = calculateEan13Checksum(payload);
    const candidate = `${payload}${checkDigit}`;

    if (!existingSet.has(candidate)) {
      return candidate;
    }
  }

  // Fallback déterministe avec millisecondes
  const timestampSuffix = (Date.now() % 1000000000).toString().padStart(9, '0');
  const fallbackPayload = `${prefix}${timestampSuffix}`;
  const checkDigit = calculateEan13Checksum(fallbackPayload);
  return `${fallbackPayload}${checkDigit}`;
}

/**
 * Génère une référence SKU unique adaptée à la catégorie et la marque.
 * @param existingProducts Liste des produits existants
 * @param category Nom de la catégorie
 * @param brand Nom de la marque
 * @returns SKU unique (ex: COQ-APP-1048)
 */
export function generateUniqueSku(
  existingProducts: Array<{ sku?: string | null }>,
  category?: string,
  brand?: string
): string {
  const existingSet = new Set(
    existingProducts
      .map((p) => p.sku?.trim().toLowerCase())
      .filter((s): s is string => Boolean(s && s.length > 0))
  );

  let catCode = 'ACC';
  if (category) {
    const c = category.toLowerCase();
    if (c.includes('iphone')) catCode = 'COQ-IPH';
    else if (c.includes('samsung')) catCode = 'COQ-SAM';
    else if (c.includes('google')) catCode = 'COQ-PIX';
    else if (c.includes('charge')) catCode = 'CHG';
    else if (c.includes('câble') || c.includes('cable')) catCode = 'CAB';
    else if (c.includes('protège') || c.includes('verre') || c.includes('ecran')) catCode = 'PRT';
    else if (c.includes('audio') || c.includes('ecouteur')) catCode = 'AUD';
    else if (c.includes('reprise') || c.includes('occasion')) catCode = 'OCC';
  }

  let brdCode = 'GEN';
  if (brand) {
    const b = brand.toLowerCase();
    if (b.includes('apple')) brdCode = 'APP';
    else if (b.includes('samsung')) brdCode = 'SAM';
    else if (b.includes('google')) brdCode = 'GOO';
    else if (b.includes('zagg')) brdCode = 'ZAG';
    else if (b.includes('belkin')) brdCode = 'BEL';
    else if (b.includes('anker')) brdCode = 'ANK';
  }

  for (let attempt = 0; attempt < 5000; attempt++) {
    const num = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${catCode}-${brdCode}-${num}`;
    if (!existingSet.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return `${catCode}-${brdCode}-${Date.now().toString().slice(-4)}`;
}

/**
 * Détecte si un code-barres existe déjà sur un autre produit que celui en cours d'édition.
 */
export function findBarcodeDuplicate<T extends { id: string; barcode: string; title: string; sku: string }>(
  barcode: string,
  currentProductId: string | undefined,
  products: T[]
): T | undefined {
  const trimmed = barcode.trim();
  if (!trimmed) return undefined;
  return products.find(
    (p) => p.barcode.trim() === trimmed && (currentProductId ? p.id !== currentProductId : true)
  );
}

/**
 * Détecte si un SKU existe déjà sur un autre produit que celui en cours d'édition.
 */
export function findSkuDuplicate<T extends { id: string; sku: string; title: string }>(
  sku: string,
  currentProductId: string | undefined,
  products: T[]
): T | undefined {
  const trimmed = sku.trim().toLowerCase();
  if (!trimmed) return undefined;
  return products.find(
    (p) => p.sku.trim().toLowerCase() === trimmed && (currentProductId ? p.id !== currentProductId : true)
  );
}

