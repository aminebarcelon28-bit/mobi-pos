import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface DbState {
  integrityCheck: string;
  tables: Array<{ name: string; rows: number }>;
}

interface ImportProbe {
  entity: string;
  found: boolean;
  id?: string;
  sku?: string;
  barcode?: string;
  title?: string;
  price?: number;
  costPrice?: number;
  stock?: number;
  isSerialized?: boolean;
  imeiNumber?: string | null;
  imeiCount?: number;
  imeiStatus?: 'in_stock' | 'defective' | null;
  warrantyMonths?: number | null;
  warrantyExplicitlyDisabled?: boolean;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  currentDebt?: number;
  debtEntries?: number;
  debtTotal?: number;
  importedDebtEntries?: number;
}

interface TauriBridge {
  core?: {
    invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

type TauriWindow = Window & { __TAURI__?: TauriBridge };

const CDP_URL = process.env.E2E_CDP_URL ?? 'http://127.0.0.1:9222';
const IMPORT_BUTTON = "Lancer l'Import Intelligent";
const ROW_LIMIT = 300_000;
const NATIVE_E2E_PIN = '202020';

let browser: Browser;
let page: Page;
let fixtureDir: string;

test.describe('Smart Import native pipeline — adversarial migration suite', () => {
  test.describe.configure({ mode: 'serial', timeout: ROW_LIMIT });

  test.beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobipos-smart-import-'));
    browser = await chromium.connectOverCDP(CDP_URL);
    const pages = browser.contexts().flatMap((context) => context.pages());
    page = pages.find((candidate) => candidate.url().startsWith('http://tauri.localhost/')) ?? pages[0];
    if (!page) throw new Error(`No Tauri WebView page is available at ${CDP_URL}`);
    await expect(page.locator('#catalog-search')).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test.beforeEach(async () => {
    await invoke<unknown>('e2e_reset_db');
    const state = await invoke<DbState>('e2e_get_db_state');
    expect(state.integrityCheck).toBe('ok');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#catalog-search')).toBeVisible({ timeout: 30_000 });
    await ensureUnlocked();
  });

  test('imports bannered French XLSX and semicolon CSV, then searches the live catalog', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Catalogue');
    sheet.addRow([]);
    sheet.addRow(['Migration catalogue — Octobre']);
    sheet.addRow([
      'Code-barres',
      'Réf Code',
      'Désignation Article',
      'P.Achat',
      'Prix Vente TTC',
      'Dispo',
    ]);
    sheet.addRow([
      makeEan13('613245001928'),
      'CAM-01',
      'Écran Protège Caméra',
      '1 000,00 DA',
      '1 450,50 DA',
      '7',
    ]);
    sheet.addRow([
      makeEan13('613245001936'),
      'COQ-02',
      'Coque Étoilée',
      '500,00 DA',
      '850,00 DA',
      '4',
    ]);
    const xlsxPath = path.join(fixtureDir, 'catalogue-fr.xlsx');
    await workbook.xlsx.writeFile(xlsxPath);

    await importFile(xlsxPath, 'products', ['barcode', 'sku', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 2, created: 2, updated: 0, rejected: 0 });
    await closeImport();

    const csvPath = path.join(fixtureDir, 'catalogue-fr.csv');
    writeDelimited(csvPath, ';', [
      ['Code-barres', 'Réf Code', 'Désignation Article', 'Prix Achat', 'Prix Vente', 'Dispo'],
      [makeEan13('613245001944'), 'USB-03', 'Clé USB Élégante', '500,00 DA', '950,00 DA', '3'],
    ]);
    await importFile(csvPath, 'products', ['barcode', 'sku', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    expect(await tableCount('products')).toBe(3);
    for (const [name, barcode] of [
      ['Écran Protège Caméra', makeEan13('613245001928')],
      ['Coque Étoilée', makeEan13('613245001936')],
      ['Clé USB Élégante', makeEan13('613245001944')],
    ]) {
      await expectCatalogSearch(barcode, name);
    }

    await page.getByRole('button', { name: /Stock F10/ }).click();
    const inventory = page.getByRole('dialog', { name: 'Gestionnaire de stock' });
    await expect(inventory).toBeVisible();
    await expectInventoryProduct(inventory, 'Écran Protège Caméra', 1451, 7);
    await expectInventoryProduct(inventory, 'Coque Étoilée', 850, 4);
    await expectInventoryProduct(inventory, 'Clé USB Élégante', 950, 3);
  });

  test('imports an opening stock snapshot only through the stock destination', async () => {
    const initialPath = path.join(fixtureDir, 'opening-stock-initial.csv');
    writeDelimited(initialPath, ';', [
      ['SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Dispo'],
      ['STOCK-SNAPSHOT-01', 'Produit stock instantané', '2000', '1000', '3'],
    ]);
    await importFile(initialPath, 'products', ['sku', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    const beforeSnapshot = await invoke<DbState>('e2e_get_db_state');
    const unaffectedTables = beforeSnapshot.tables
      .filter(({ name }) => /cash|wallet|sales|shift/i.test(name))
      .map(({ name, rows }) => [name, rows] as const);
    const snapshotPath = path.join(fixtureDir, 'opening-stock-snapshot.csv');
    writeDelimited(snapshotPath, ';', [
      ['SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Stock Initial'],
      ['STOCK-SNAPSHOT-01', 'Produit stock instantané', '2000', '1000', '5'],
    ]);
    await importFile(snapshotPath, 'opening_stock', ['sku', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 1, rejected: 0 });
    await closeImport();

    await expect(importProbe('products', 'STOCK-SNAPSHOT-01')).resolves.toMatchObject({
      found: true,
      stock: 5,
      price: 2000,
    });
    const afterSnapshot = await invoke<DbState>('e2e_get_db_state');
    expect(
      afterSnapshot.tables
        .filter(({ name }) => /cash|wallet|sales|shift/i.test(name))
        .map(({ name, rows }) => [name, rows] as const),
    ).toEqual(unaffectedTables);
    await expectCatalogSearch('STOCK-SNAPSHOT-01', 'Produit stock instantané');
  });

  test('imports real XLS, DBF, JSONL, pipe TXT, UTF-8 BOM, Windows-1252 and UTF-16LE files', async () => {
    const legacyXlsPath = path.resolve('e2e/fixtures/smart-import/legacy-multisheet.xls');
    await importFile(legacyXlsPath, 'products', ['barcode', 'sku', 'title', 'price'], 1, ['quantity']);
    await expectSuccessMetrics({ parsed: 2, created: 2, updated: 0, rejected: 0 });
    await closeImport();
    expect(await tableCount('products')).toBe(2);
    await expectCatalogSearch('XLS-01', 'Téléphone Écran Protégé');

    const dbfPath = path.join(fixtureDir, 'products.dbf');
    writeDbf(dbfPath, [
      ['SKU', 'C', 12],
      ['TITLE', 'C', 32],
      ['PRICE', 'N', 8],
      ['COST', 'N', 8],
      ['STOCK', 'N', 4],
    ], [
      ['DBF-01', 'Adaptateur DBF robuste', '2200', '1400', '6'],
    ]);
    await importFile(dbfPath, 'products', ['sku', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    const jsonlPath = path.join(fixtureDir, 'products.jsonl');
    fs.writeFileSync(jsonlPath, [
      JSON.stringify({ SKU: 'JSONL-01', 'Désignation Article': 'Produit JSON Lines', 'Prix Achat': 500, 'Prix Vente': 900, Dispo: 2 }),
      JSON.stringify({ SKU: 'JSONL-02', 'Désignation Article': 'Deuxième JSON Lines', 'Prix Achat': 700, 'Prix Vente': 1250, Dispo: 3 }),
    ].join('\n'), 'utf8');
    await importFile(jsonlPath, 'products', ['sku', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 2, created: 2, updated: 0, rejected: 0 });
    await closeImport();

    const pipePath = path.join(fixtureDir, 'pipe-delimited.txt');
    writeDelimited(pipePath, '|', [
      ['SKU', 'Désignation Article', 'Prix Achat', 'Prix Vente', 'Dispo'],
      ['TXT-01', 'Produit texte délimité', '800,00 DA', '1 250,00 DA', '4'],
    ]);
    await importFile(pipePath, 'products', ['sku', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    const utf8BomPath = path.join(fixtureDir, 'utf8-bom.csv');
    fs.writeFileSync(utf8BomPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('SKU;Désignation Article;Prix Achat;Prix Vente;Dispo\r\nBOM-01;Écran BOM;400;800;2', 'utf8'),
    ]));
    await importFile(utf8BomPath, 'products', ['sku', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    const cp1252Path = path.resolve('e2e/fixtures/smart-import/french-windows-1252.csv');
    await importFile(cp1252Path, 'products', ['sku', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    const utf16Path = path.join(fixtureDir, 'utf16le.csv');
    fs.writeFileSync(utf16Path, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('SKU;Désignation Article;Prix Achat;Prix Vente;Dispo\r\nUTF16-01;Produit UTF-16;400;750;1', 'utf16le'),
    ]));
    await importFile(utf16Path, 'products', ['sku', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    expect(await tableCount('products')).toBe(9);
    for (const [sku, title] of [
      ['DBF-01', 'Adaptateur DBF robuste'],
      ['JSONL-01', 'Produit JSON Lines'],
      ['JSONL-02', 'Deuxième JSON Lines'],
      ['TXT-01', 'Produit texte délimité'],
      ['BOM-01', 'Écran BOM'],
      ['CP1252-01', 'Écran d’été à câble'],
      ['UTF16-01', 'Produit UTF-16'],
    ]) {
      await expectCatalogSearch(sku, title);
    }
  });

  test('preserves textual identities across CSV, zero-formatted XLSX and DBF; quarantines damaged identities', async () => {
    const cp1256Path = path.join(fixtureDir, 'arabic-cp1256.csv');
    const cp1256 = spawnSync('python', [
      '-c',
      'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes("SKU;TITLE;Cost Price;Price;Stock\\nCP1256-01;هاتف عربي;500;900;2".encode("cp1256"))',
      cp1256Path,
    ], { encoding: 'utf8' });
    if (cp1256.status !== 0) {
      throw new Error(`Could not generate the Windows-1256 fixture: ${cp1256.stderr || cp1256.error}`);
    }
    await importFile(
      cp1256Path,
      'products',
      ['sku', 'title', 'cost_price', 'price', 'quantity'],
      undefined,
      [],
      'WINDOWS-1256',
      'WINDOWS-1252',
    );
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();
    await expectCatalogSearch('CP1256-01', 'هاتف عربي');

    const csvProductPath = path.join(fixtureDir, 'leading-zero-product.csv');
    const csvBarcode = makeEan13('061234567890');
    writeDelimited(csvProductPath, ';', [
      ['SKU', 'Barcode', 'TITLE', 'Cost Price', 'Price', 'Stock'],
      ['0001234', csvBarcode, 'Leading zero CSV product', '500', '900', '2'],
    ]);
    await importFile(csvProductPath, 'products', ['sku', 'barcode', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();
    await expect(importProbe('products', '0001234')).resolves.toMatchObject({
      found: true,
      sku: '0001234',
      barcode: csvBarcode,
    });

    const xlsxWorkbook = new ExcelJS.Workbook();
    const xlsxSheet = xlsxWorkbook.addWorksheet('Leading zeros');
    xlsxSheet.addRow(['SKU', 'Barcode', 'TITLE', 'Cost Price', 'Price', 'Stock']);
    const xlsxBarcode = makeEan13('061234567898');
    const xlsxRow = xlsxSheet.addRow([
      1234,
      Number(xlsxBarcode),
      'Leading zero XLSX product',
      500,
      900,
      3,
    ]);
    xlsxRow.getCell(1).numFmt = '0000000';
    xlsxRow.getCell(2).numFmt = '0000000000000';
    const xlsxProductPath = path.join(fixtureDir, 'leading-zero-product.xlsx');
    await xlsxWorkbook.xlsx.writeFile(xlsxProductPath);
    await resetIsolatedDb();
    await importFile(xlsxProductPath, 'products', ['sku', 'barcode', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();
    await expect(importProbe('products', '0001234')).resolves.toMatchObject({
      found: true,
      sku: '0001234',
      barcode: xlsxBarcode,
    });

    const dbfProductPath = path.join(fixtureDir, 'leading-zero-product.dbf');
    writeDbf(dbfProductPath, [
      ['SKU', 'C', 12],
      ['BARCODE', 'C', 16],
      ['TITLE', 'C', 40],
      ['COST', 'N', 8],
      ['PRICE', 'N', 8],
      ['STOCK', 'N', 4],
    ], [
      ['0001234', '061234567904', 'Leading zero DBF product', '500', '900', '1'],
    ]);
    await resetIsolatedDb();
    await importFile(dbfProductPath, 'products', ['sku', 'barcode', 'title', 'cost_price', 'price', 'quantity']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();
    await expect(importProbe('products', '0001234')).resolves.toMatchObject({
      found: true,
      sku: '0001234',
      barcode: '061234567904',
    });

    const csvCustomerPath = path.join(fixtureDir, 'leading-zero-customer.csv');
    writeDelimited(csvCustomerPath, ';', [
      ['Customer Name', 'Phone'],
      ['CSV zero phone', '0612345678'],
    ]);
    await importFile(csvCustomerPath, 'customers', ['customer_name', 'phone']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();
    await expect(importProbe('customers', '0612345678')).resolves.toMatchObject({
      found: true,
      phone: '0612345678',
    });

    const customerWorkbook = new ExcelJS.Workbook();
    const customerSheet = customerWorkbook.addWorksheet('Clients');
    customerSheet.addRow(['Customer Name', 'Phone']);
    const customerRow = customerSheet.addRow(['XLSX zero phone', 612345679]);
    customerRow.getCell(2).numFmt = '0000000000';
    const xlsxCustomerPath = path.join(fixtureDir, 'leading-zero-customer.xlsx');
    await customerWorkbook.xlsx.writeFile(xlsxCustomerPath);
    await importFile(xlsxCustomerPath, 'customers', ['customer_name', 'phone']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();
    await expect(importProbe('customers', '0612345679')).resolves.toMatchObject({
      found: true,
      phone: '0612345679',
    });

    const dbfCustomerPath = path.join(fixtureDir, 'leading-zero-customer.dbf');
    writeDbf(dbfCustomerPath, [
      ['CUSTOMER', 'C', 24],
      ['PHONE', 'C', 16],
    ], [
      ['DBF zero phone', '0612345680'],
    ]);
    await importFile(dbfCustomerPath, 'customers', ['customer_name', 'phone']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();
    await expect(importProbe('customers', '0612345680')).resolves.toMatchObject({
      found: true,
      phone: '0612345680',
    });

    const scientificPath = path.join(fixtureDir, 'scientific-identity.csv');
    writeDelimited(scientificPath, ';', [
      ['Barcode', 'SKU', 'TITLE', 'IMEI', 'Price', 'Stock'],
      ['3.5E+14', 'SCI-BARCODE', 'Lost barcode precision', '', '700', '1'],
      ['', 'SCI-IMEI', 'Lost IMEI precision', '3.5E+14', '900', '1'],
    ]);
    await resetIsolatedDb();
    const productsBeforeScientific = await tableCount('products');
    const imeisBeforeScientific = await tableCount('imei_records');
    await importFile(scientificPath, 'products', ['barcode', 'sku', 'title', 'imei', 'price', 'quantity']);
    const importDialog = page.getByRole('dialog', { name: /Import intelligent de données/i });
    await expect(
      importDialog.getByText(
        /ScientificNotationIdentityRejected: Excel converted this to scientific notation; re-export the column as text\./,
      ),
    ).toHaveCount(2);
    await expectSuccessMetrics({ parsed: 2, created: 0, updated: 0, rejected: 2 });
    await closeImport();
    await expect(importProbe('products', 'SCI-BARCODE')).resolves.toMatchObject({ found: false });
    await expect(importProbe('products', 'SCI-IMEI')).resolves.toMatchObject({ found: false });
    expect(await tableCount('products')).toBe(productsBeforeScientific);
    expect(await tableCount('imei_records')).toBe(imeisBeforeScientific);
  });

  test('migrates folded vCard 2.1/3.0 and JSON contacts with primary and secondary phones', async () => {
    const firstName = 'Élodie Benali';
    const arabicName = 'ليلى بن صالح';
    const vcfPath = path.join(fixtureDir, 'contacts.vcf');
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${foldQuotedPrintable(firstName)}`,
      'TEL;TYPE=CELL:+213 550 12 34 56',
      'TEL;TYPE=HOME:0661987654',
      'EMAIL:elodie@example.test',
      'ADR;TYPE=HOME:;;12 Rue des Lilas;Alger;;;',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${foldQuotedPrintable(arabicName)}`,
      'TEL;CELL:0661987654',
      'TEL;HOME:0770123456',
      'EMAIL:layla@example.test',
      'END:VCARD',
    ].join('\r\n');
    fs.writeFileSync(vcfPath, vcf, 'utf8');

    await importFile(vcfPath, 'customers', ['customer_name', 'phone', 'secondary_phone', 'email']);
    await expectSuccessMetrics({ parsed: 2, created: 2, updated: 0, rejected: 0 });
    await closeImport();

    const jsonPath = path.join(fixtureDir, 'contacts.json');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify([
        { 'Nom Client': 'Samir Haddad', Téléphone: '0555123456', Email: 'samir@example.test' },
      ]),
      'utf8',
    );
    await importFile(jsonPath, 'customers', ['customer_name', 'phone', 'email']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    expect(await tableCount('customers')).toBe(3);
    await page.getByTestId('clients-button').click();
    const directory = page.getByRole('dialog', { name: 'CRM et fichier clients' });
    await expect(directory).toBeVisible();
    const customerSearch = directory.getByTestId('customer-search');
    for (const name of [firstName, arabicName, 'Samir Haddad']) {
      await customerSearch.fill(name);
      await expect(directory.getByText(name, { exact: true }).first()).toBeVisible();
    }
    await directory.getByRole('button', { name: 'Fermer' }).last().click();

    await page.getByRole('button', { name: /\+ Client/ }).click();
    const picker = page.getByRole('dialog', { name: 'CRM et fichier clients' });
    await picker.getByTestId('customer-search').fill(firstName);
    await expect(picker.getByText(firstName, { exact: true }).first()).toBeVisible();
    await picker.getByTestId('customer-search').press('Enter');
    await expect(picker).toHaveCount(0);
    await expect(page.getByText(firstName).first()).toBeVisible();
  });

  test('quarantines debt from a customer profile import instead of changing the balance', async () => {
    const pathName = path.join(fixtureDir, 'customers-opening-debt.csv');
    writeDelimited(pathName, ';', [
      ['Nom Client', 'Téléphone', 'Email', 'Dette Initiale'],
      ['Nadia Dette', '0550000101', 'nadia-debt@example.test', '1 250,00 DA'],
    ]);

    await importFile(pathName, 'customers', ['customer_name', 'phone', 'email', 'debt_balance']);
    const review = page.getByRole('region', { name: /Lignes à vérifier ou mises en quarantaine/ });
    await expect(review).toBeVisible();
    await expect(review.getByText(/DebtRequiresDedicatedDestination/)).toBeVisible();
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, rejected: 1 });
    await closeImport();

    expect(await tableCount('customers')).toBe(0);
    expect(await tableCount('customer_debts')).toBe(0);
  });

  test('imports a verified opening-debt snapshot through its dedicated destination', async () => {
    const customerPath = path.join(fixtureDir, 'debt-snapshot-customer.csv');
    writeDelimited(customerPath, ';', [
      ['Nom Client', 'Téléphone', 'Email'],
      ['Nadia Snapshot', '0550000102', 'nadia-snapshot@example.test'],
    ]);
    await importFile(customerPath, 'customers', ['customer_name', 'phone', 'email']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    const beforeDebtImport = await invoke<DbState>('e2e_get_db_state');
    const unaffectedTables = beforeDebtImport.tables
      .filter(({ name }) => /cash|wallet|sales|shift/i.test(name))
      .map(({ name, rows }) => [name, rows] as const);

    const snapshotPath = path.join(fixtureDir, 'debt-opening-snapshot.csv');
    writeDelimited(snapshotPath, ';', [
      ['Nom Client', 'Téléphone', 'Email', 'Solde Dette'],
      ['Nadia Snapshot', '0550000102', 'nadia-snapshot@example.test', '1 250,00 DA'],
    ]);
    await importFile(snapshotPath, 'customer_debts', ['customer_name', 'phone', 'email', 'debt_balance']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 1, rejected: 0 });
    await closeImport();

    expect(await tableCount('customer_debts')).toBe(1);
    await expect(importProbe('customers', '0550000102')).resolves.toMatchObject({
      found: true,
      currentDebt: 1250,
      debtEntries: 1,
      debtTotal: 1250,
      importedDebtEntries: 1,
    });
    const afterDebtImport = await invoke<DbState>('e2e_get_db_state');
    expect(
      afterDebtImport.tables
        .filter(({ name }) => /cash|wallet|sales|shift/i.test(name))
        .map(({ name, rows }) => [name, rows] as const),
    ).toEqual(unaffectedTables);

    await page.getByTestId('clients-button').click();
    const directory = page.getByRole('dialog', { name: 'CRM et fichier clients' });
    await directory.getByTestId('customer-search').fill('Nadia Snapshot');
    await expect(directory.getByText('Nadia Snapshot', { exact: true }).first()).toBeVisible();
    await expect(directory.getByText(/1\s?250/).first()).toBeVisible();
    await directory.getByRole('button', { name: 'Fermer' }).last().click();

    await importFile(snapshotPath, 'customer_debts', ['customer_name', 'phone', 'email', 'debt_balance']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, skipped: 1, rejected: 0 });
    await closeImport();
    expect(await tableCount('customer_debts')).toBe(1);
  });

  test('imports supplier contacts only, patches blanks safely, and quarantines conflicts', async () => {
    const supplierPath = path.join(fixtureDir, 'supplier-contacts.csv');
    writeDelimited(supplierPath, ';', [
      ['Fournisseur', 'Téléphone', 'Email', 'Adresse', 'Notes'],
      ['EURL Import Fournitures', '0550123456', 'contact@fournitures.example.test', 'Alger Centre', 'Compte historique'],
    ]);
    await importFile(supplierPath, 'suppliers', ['supplier_name', 'phone', 'email', 'address', 'notes']);
    await expectSuccessMetrics({ parsed: 1, created: 1, updated: 0, rejected: 0 });
    await closeImport();

    await expect(importProbe('suppliers', ' eurl   import fournitures ')).resolves.toMatchObject({
      found: true,
      name: 'EURL Import Fournitures',
      phone: '0550123456',
      email: 'contact@fournitures.example.test',
      address: 'Alger Centre',
      notes: 'Compte historique',
    });
    expect(await tableCount('vendor_aliases')).toBe(0);

    await importFile(supplierPath, 'suppliers', ['supplier_name', 'phone', 'email', 'address', 'notes']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, skipped: 1, rejected: 0 });
    await closeImport();

    const conflictPath = path.join(fixtureDir, 'supplier-contact-conflict.csv');
    writeDelimited(conflictPath, ';', [
      ['Fournisseur', 'Téléphone'],
      ['EURL Import Fournitures', '0661987654'],
    ]);
    await importFile(conflictPath, 'suppliers', ['supplier_name', 'phone']);
    const review = page.getByRole('region', { name: /Lignes à vérifier ou mises en quarantaine/ });
    await expect(review.getByText(/ConflictingSupplierContact/)).toBeVisible();
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, rejected: 1 });
    await closeImport();

    await expect(importProbe('suppliers', 'EURL Import Fournitures')).resolves.toMatchObject({
      found: true,
      phone: '0550123456',
    });
  });

  test('imports serialized phone products with IMEI and warranty snapshots', async () => {
    const productCsv = path.join(fixtureDir, 'phones-imei-warranty.csv');
    writeDelimited(productCsv, ';', [
      ['SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Dispo', 'IMEI', 'Garantie'],
      ['PHONE-IMEI-01', 'Téléphone IMEI garanti', '120000', '90000', '1', makeImei('49015420323751'), '24 mois'],
      ['PHONE-IMEI-02', 'Téléphone vendu sans garantie', '95000', '70000', '1', makeImei('49015420323750'), 'Sans'],
      ['PHONE-IMEI-BAD', 'Téléphone IMEI invalide', '50000', '30000', '1', '356938035643803', '12 mois'],
    ]);

    await importFile(productCsv, 'products', ['sku', 'title', 'price', 'cost_price', 'quantity', 'imei', 'warranty']);
    await expect(page.getByRole('region', { name: /Lignes à vérifier ou mises en quarantaine/ })
      .getByText(/InvalidImeiLuhnChecksum/)).toBeVisible();
    await expectSuccessMetrics({ parsed: 3, created: 2, updated: 0, rejected: 1 });
    await closeImport();

    const guaranteed = await importProbe('products', 'PHONE-IMEI-01');
    expect(guaranteed).toMatchObject({
      found: true,
      sku: 'PHONE-IMEI-01',
      title: 'Téléphone IMEI garanti',
      isSerialized: true,
      imeiNumber: makeImei('49015420323751'),
      imeiCount: 1,
      imeiStatus: 'in_stock',
      warrantyMonths: 24,
      warrantyExplicitlyDisabled: false,
    });
    const noWarranty = await importProbe('products', 'PHONE-IMEI-02');
    expect(noWarranty).toMatchObject({
      found: true,
      isSerialized: true,
      imeiNumber: makeImei('49015420323750'),
      imeiCount: 1,
      imeiStatus: 'in_stock',
      warrantyMonths: 0,
      warrantyExplicitlyDisabled: true,
    });
    await expectCatalogSearch('PHONE-IMEI-01', 'Téléphone IMEI garanti');
    await expectCatalogSearch('PHONE-IMEI-02', 'Téléphone vendu sans garantie');

    const conflictPath = path.join(fixtureDir, 'imei-reassignment.csv');
    writeDelimited(conflictPath, ';', [
      ['SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Dispo', 'IMEI', 'Garantie'],
      ['PHONE-IMEI-OTHER', 'Téléphone IMEI réaffecté', '130000', '95000', '1', makeImei('49015420323751'), 'Sans'],
    ]);
    await importFile(conflictPath, 'products', ['sku', 'title', 'price', 'cost_price', 'quantity', 'imei', 'warranty']);
    await expect(page.getByRole('region', { name: /Lignes à vérifier ou mises en quarantaine/ })
      .getByText(/ImeiAlreadyRegistered/)).toBeVisible();
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, rejected: 1 });
    await closeImport();
    expect(await tableCount('products')).toBe(2);
    await expect(importProbe('products', 'PHONE-IMEI-01')).resolves.toMatchObject({
      imeiNumber: makeImei('49015420323751'),
      imeiCount: 1,
      imeiStatus: 'in_stock',
      warrantyMonths: 24,
    });
  });

  test('quarantines repairs, trade-ins, standalone serials and debt-ledger rows instead of misimporting them', async () => {
    const repairPath = path.join(fixtureDir, 'repair-history.csv');
    writeDelimited(repairPath, ';', [
      ['Nom Client', 'Téléphone', 'Appareil', 'Panne', 'Acompte', 'Date'],
      ['Client SAV', '0550000201', 'iPhone 13', 'Écran cassé', '5000', '2026-10-20'],
    ]);
    await importFile(repairPath, 'products', ['title']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, rejected: 1 });
    await closeImport();

    const tradePath = path.join(fixtureDir, 'trade-in-history.csv');
    writeDelimited(tradePath, ';', [
      ['Nom Client', 'Téléphone', 'Appareil repris', 'IMEI', 'Valeur Reprise', 'Date Reprise'],
      ['Client reprise', '0550000202', 'Galaxy S22 usagé', '350000000000006', '45000', '2026-10-19'],
    ]);
    await importFile(tradePath, 'products', ['title']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, rejected: 1 });
    await closeImport();

    const serialPath = path.join(fixtureDir, 'standalone-imei.csv');
    writeDelimited(serialPath, ';', [
      ['IMEI', 'Modèle'],
      ['490154203237518', 'Téléphone isolé'],
    ]);
    await importFile(serialPath, 'products', ['imei', 'compatible_model']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, rejected: 1 });
    await closeImport();

    const debtHistoryPath = path.join(fixtureDir, 'standalone-debt-ledger.csv');
    writeDelimited(debtHistoryPath, ';', [
      ['Référence Dette', 'Nom Client', 'Montant Dette', 'Solde Restant', 'Date Opération'],
      ['DET-01', 'Client historique', '1500', '1000', '2026-10-18'],
    ]);
    await importFile(debtHistoryPath, 'customers', ['customer_name']);
    await expectSuccessMetrics({ parsed: 1, created: 0, updated: 0, rejected: 1 });
    await closeImport();

    expect(await tableCount('products')).toBe(0);
    expect(await tableCount('customers')).toBe(0);
    expect(await tableCount('customer_debts')).toBe(0);
  });

  test('extracts only literal product INSERT rows from hostile SQL dumps', async () => {
    const sqlPath = path.join(fixtureDir, 'legacy-products.sql');
    fs.writeFileSync(
      sqlPath,
      [
        '-- legacy product export',
        'CREATE TABLE products (id TEXT, title TEXT);',
        `INSERT INTO products (sku, barcode, title, price, cost_price, stock) VALUES ('SQL-01', '${makeEan13('613245001952')}', 'Produit SQL sûr', 1450, 900, 5);`,
        '/* unrelated statement */',
        'DROP TABLE products;',
        `INSERT INTO products (sku, barcode, title, price, cost_price, stock) VALUES ('SQL-02', '${makeEan13('613245001960')}', 'Produit après DROP ignoré', 2250, 1300, 2);`,
      ].join('\n'),
      'utf8',
    );

    await importFile(sqlPath, 'products', ['sku', 'barcode', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 2, created: 2, updated: 0, rejected: 0 });
    await closeImport();

    expect(await tableCount('products')).toBe(2);
    const state = await invoke<DbState>('e2e_get_db_state');
    expect(state.integrityCheck).toBe('ok');
    await expectCatalogSearch('SQL-01', 'Produit SQL sûr');
    await expectCatalogSearch('SQL-02', 'Produit après DROP ignoré');
  });

  test('re-imports ten changed products and adds five without duplicating identities', async () => {
    const original = Array.from({ length: 50 }, (_, index) => [
      makeEan13((613300000000 + index).toString()),
      `UP-${String(index + 1).padStart(3, '0')}`,
      `Produit Upsert ${String(index + 1).padStart(3, '0')}`,
      String(1000 + index),
      String(500 + index),
      String(index + 1),
    ]);
    const firstPath = path.join(fixtureDir, 'upsert-original.csv');
    writeDelimited(firstPath, ';', [
      ['Code-barres', 'SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Dispo'],
      ...original,
    ]);
    await importFile(firstPath, 'products', ['barcode', 'sku', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 50, created: 50, updated: 0, rejected: 0 });
    await closeImport();
    expect(await tableCount('products')).toBe(50);

    const changed = original.slice(0, 10).map((row, index) => [
      row[0],
      row[1],
      row[2],
      String(5000 + index),
      String(2500 + index),
      String(20 + index),
    ]);
    const additions = Array.from({ length: 5 }, (_, index) => [
      makeEan13((613400000000 + index).toString()),
      `NEW-${index + 1}`,
      `Nouveau Upsert ${index + 1}`,
      String(6000 + index),
      String(3000 + index),
      '9',
    ]);
    const secondPath = path.join(fixtureDir, 'upsert-modified.csv');
    writeDelimited(secondPath, ';', [
      ['Code-barres', 'SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Dispo'],
      ...changed,
      ...additions,
    ]);
    await importFile(secondPath, 'products', ['barcode', 'sku', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 15, created: 5, updated: 10, rejected: 0 });
    await closeImport();

    expect(await tableCount('products')).toBe(55);
    await expectCatalogSearch('UP-001', 'Produit Upsert 001');
    await page.getByRole('button', { name: /Stock F10/ }).click();
    const inventory = page.getByRole('dialog', { name: 'Gestionnaire de stock' });
    await expectInventoryProduct(inventory, 'Produit Upsert 001', 5000, 20);
    await expectInventoryProduct(inventory, 'Produit Upsert 010', 5009, 29);
  });

  test('quarantines five malformed TSV rows while committing 95 valid rows', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => {
      if (index < 3) {
        return [
          makeEan13((614000000000 + index).toString()),
          `BAD-PRICE-${index}`,
          `Produit prix invalide ${index}`,
          index === 0 ? 'prix inconnu' : 'DZD ??',
          '500',
          '1',
        ];
      }
      if (index < 5) {
        return [makeEan13((614000000000 + index).toString()), `BAD-NAME-${index}`, '', '750,00 DA', '500', '1'];
      }
      return [
        makeEan13((614000000000 + index).toString()),
        `TSV-${index}`,
        `Produit TSV valide ${index}`,
        '750,00 DA',
        '400',
        '2',
      ];
    });
    const tsvPath = path.join(fixtureDir, 'quarantine.tsv');
    writeDelimited(tsvPath, '\t', [
      ['Code-barres', 'SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Dispo'],
      ...rows,
    ]);

    await importFile(tsvPath, 'products', ['barcode', 'sku', 'title', 'price', 'cost_price', 'quantity']);
    const review = page.getByRole('region', { name: /Lignes à vérifier ou mises en quarantaine/ });
    await expect(review).toBeVisible();
    await expect(review.getByText(/Ligne source/).first()).toBeVisible();
    await expect(review.getByText(/InvalidSellingPrice|MissingProductName/).first()).toBeVisible();
    await expectSuccessMetrics({ parsed: 100, created: 95, updated: 0, rejected: 5 });
    await closeImport();

    expect(await tableCount('products')).toBe(95);
    await expectCatalogSearch('TSV-99', 'Produit TSV valide 99');
    await expectCatalogSearch('TSV-05', 'Produit TSV valide 5');
    await page.locator('#catalog-search').fill('BAD-PRICE-0');
    await expect(page.getByText('Produit prix invalide 0', { exact: true })).toHaveCount(0);
  });

  test('imports 2,500 rows within the responsiveness budget and searches first, middle, and last', async () => {
    const pageErrors: string[] = [];
    const onPageError = (error: Error) => pageErrors.push(error.message);
    page.on('pageerror', onPageError);
    const rows = Array.from({ length: 2500 }, (_, index) => [
      `STRESS-${String(index + 1).padStart(4, '0')}`,
      `Produit Stress ${String(index + 1).padStart(4, '0')}`,
      '1250',
      '750',
      '3',
    ]);
    const csvPath = path.join(fixtureDir, 'stress-2500.csv');
    writeDelimited(csvPath, ';', [
      ['SKU', 'Désignation Article', 'Prix Vente', 'Prix Achat', 'Dispo'],
      ...rows,
    ]);

    const startedAt = Date.now();
    await importFile(csvPath, 'products', ['sku', 'title', 'price', 'cost_price', 'quantity']);
    await expectSuccessMetrics({ parsed: 2500, created: 2500, updated: 0, rejected: 0 });
    await closeImport();
    const durationMs = Date.now() - startedAt;

    expect(durationMs, '2,500-row import should complete in under 90 seconds').toBeLessThan(90_000);
    expect(pageErrors, 'no uncaught WebView errors during large import').toEqual([]);
    expect(await tableCount('products')).toBe(2500);
    for (const index of [1, 1250, 2500]) {
      const suffix = String(index).padStart(4, '0');
      await expectCatalogSearch(`STRESS-${suffix}`, `Produit Stress ${suffix}`);
    }

    await page.getByRole('button', { name: /Stock F10/ }).click();
    const inventory = page.getByRole('dialog', { name: 'Gestionnaire de stock' });
    await expect(inventory.getByRole('heading', { name: /Gestionnaire de Stock \(2500 Articles\)/ })).toBeVisible();
    await expect(inventoryProductCount(inventory)).toContainText('2500');
    page.off('pageerror', onPageError);
  });
});

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return page.evaluate(async ({ name, payload }) => {
    const bridge = (window as TauriWindow).__TAURI__;
    if (!bridge?.core?.invoke) {
      throw new Error('Tauri IPC is unavailable; this spec must run against the isolated native app.');
    }
    return bridge.core.invoke(name, payload);
  }, { name: command, payload: args }) as Promise<T>;
}

async function resetIsolatedDb(): Promise<void> {
  await invoke<unknown>('e2e_reset_db');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#catalog-search')).toBeVisible({ timeout: 30_000 });
  await ensureUnlocked();
}

async function importProbe(
  entity: 'products' | 'customers' | 'suppliers',
  identity: string,
): Promise<ImportProbe> {
  return invoke<ImportProbe>('e2e_get_import_probe', { entity, identity });
}

async function importFile(
  filePath: string,
  entity: 'products' | 'opening_stock' | 'customers' | 'customer_debts' | 'suppliers',
  expectedMappings: string[],
  expectedSheetIndex?: number,
  ignoreMappings: string[] = [],
  expectedEncoding?: string,
  overrideEncoding?: string,
): Promise<void> {
  await ensureUnlocked();
  await page.getByRole('button', { name: /Param/ }).click();
  await page.getByRole('button', { name: /Base de Donn/ }).click();
  await page.getByRole('button', { name: IMPORT_BUTTON }).click();

  const dialog = page.getByRole('dialog', { name: /Import intelligent de données/i });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles(filePath);
  await expect(dialog.getByText('Mappage des Colonnes')).toBeVisible({ timeout: 30_000 });
  if (expectedEncoding) {
    await expect(dialog.getByTestId('import-detected-encoding')).toHaveText(expectedEncoding);
  }
  if (overrideEncoding) {
    const encodingSelect = dialog.getByRole('combobox', { name: "Remplacer l'encodage du fichier" });
    await encodingSelect.selectOption(overrideEncoding);
    await expect(dialog.getByTestId('import-detected-encoding')).toHaveText(overrideEncoding);
    await encodingSelect.selectOption(expectedEncoding ?? 'auto');
    await expect(dialog.getByTestId('import-detected-encoding')).toHaveText(expectedEncoding ?? '');
  }
  if (expectedSheetIndex !== undefined) {
    await expect(dialog.locator('select').first()).toHaveValue(String(expectedSheetIndex));
  }

  const entityLabel = {
    products: 'Produits',
    opening_stock: 'Stock',
    customers: 'Clients',
    customer_debts: 'Dettes',
    suppliers: 'Fournisseurs',
  }[entity];
  await dialog.getByRole('button', { name: entityLabel, exact: true }).click();
  for (const mapping of ignoreMappings) {
    const selectedValues = await dialog.locator('select').evaluateAll((elements) =>
      elements.map((element) => (element as HTMLSelectElement).value),
    );
    const mappingIndex = selectedValues.findIndex((value) => value === mapping);
    if (mappingIndex < 0) throw new Error(`Could not find detected mapping ${mapping} to ignore`);
    await dialog.locator('select').nth(mappingIndex).selectOption('ignored');
  }
  const mappings = await dialog.locator('select').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLSelectElement).value),
  );
  for (const mapping of expectedMappings) {
    expect(mappings, `expected import mapping ${mapping}`).toContain(mapping);
  }

  await dialog.getByRole('button', { name: /Préparer l/ }).click();
  await expect(dialog.getByText('Données Préparées & Vérifiées')).toBeVisible({ timeout: 60_000 });
}

async function expectSuccessMetrics(metrics: {
  parsed: number;
  created: number;
  updated: number;
  skipped?: number;
  rejected: number;
}): Promise<void> {
  await ensureUnlocked();
  const dialog = page.getByRole('dialog', { name: /Import intelligent de données/i });
  await dialog.getByRole('button', { name: /Confirmer et Importer/ }).click();
  await expect(dialog.getByRole('heading', { name: /Importation Terminée/ })).toBeVisible({
    timeout: 90_000,
  });
  const metricLabels: Array<[string, number]> = [
    ['Total analysé', metrics.parsed],
    ['Nouveaux', metrics.created],
    ['Mis à jour', metrics.updated],
    ['Ignorés', metrics.skipped ?? 0],
    ['Mis en quarantaine', metrics.rejected],
  ];
  for (const [label, value] of metricLabels) {
    const metricCard = dialog.getByText(label, { exact: true }).locator('..');
    await expect(metricCard.getByText(String(value), { exact: true })).toBeVisible();
  }
}

async function closeImport(): Promise<void> {
  await ensureUnlocked();
  await page.getByRole('button', { name: /Fermer et retourner/ }).click();
  await expect(page.getByRole('dialog', { name: /Import intelligent de données/i })).toHaveCount(0);
  await expect(page.locator('#catalog-search')).toBeVisible();
}

async function expectCatalogSearch(query: string, title: string): Promise<void> {
  await ensureUnlocked();
  const search = page.locator('#catalog-search');
  await expect(search).toBeVisible();
  await search.fill(query);
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await search.fill('');
}

async function expectInventoryProduct(
  inventory: ReturnType<Page['getByRole']>,
  title: string,
  price: number,
  stock: number,
): Promise<void> {
  await ensureUnlocked();
  const search = inventory.getByTestId('inventory-manager-search');
  await search.fill(title);
  const row = inventory.locator('tbody tr').filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(new RegExp(priceWithGrouping(price)));
  await expect(row).toContainText(new RegExp(`${stock}\\s*un\\.`));
}

async function ensureUnlocked(): Promise<void> {
  const lockScreen = page.locator('[data-testid="lock-screen"]');
  if ((await lockScreen.count()) === 0) return;

  await lockScreen.getByTestId('login-pin-input').fill(NATIVE_E2E_PIN);
  await lockScreen.getByRole('button', { name: /Valider/ }).click();
  await expect(lockScreen).toHaveCount(0, { timeout: 20_000 });
}

function inventoryProductCount(inventory: ReturnType<Page['getByRole']>) {
  return inventory.locator('span').filter({ hasText: /^\d+\s*\/\s*2500$/ }).last();
}

async function tableCount(tableName: string): Promise<number> {
  const state = await invoke<DbState>('e2e_get_db_state');
  expect(state.integrityCheck).toBe('ok');
  const table = state.tables.find((entry) => entry.name === tableName);
  if (!table) throw new Error(`The isolated SQLite database has no ${tableName} table.`);
  return table.rows;
}

function writeDelimited(filePath: string, delimiter: string, rows: string[][]): void {
  const escapeCell = (value: string) => {
    if (!value.includes(delimiter) && !value.includes('"') && !/[\r\n]/.test(value)) return value;
    return `"${value.replace(/"/g, '""')}"`;
  };
  fs.writeFileSync(filePath, rows.map((row) => row.map(escapeCell).join(delimiter)).join('\r\n'), 'utf8');
}

function writeDbf(
  filePath: string,
  fields: Array<[name: string, type: 'C' | 'N', length: number]>,
  rows: string[][],
): void {
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((total, [, , length]) => total + length, 0);
  const header = Buffer.alloc(headerLength);
  header[0] = 0x03;
  header[1] = 126;
  header[2] = 10;
  header[3] = 22;
  header.writeUInt32LE(rows.length, 4);
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);

  fields.forEach(([name, type, length], index) => {
    const offset = 32 + index * 32;
    header.write(name.slice(0, 11), offset, 11, 'ascii');
    header[offset + 11] = type.charCodeAt(0);
    header[offset + 16] = length;
  });
  header[headerLength - 1] = 0x0d;

  const records = rows.map((row) => {
    const record = Buffer.alloc(recordLength, 0x20);
    record[0] = 0x20;
    let offset = 1;
    fields.forEach(([, type, length], index) => {
      const value = String(row[index] ?? '').slice(0, length);
      const cell = Buffer.from(value, 'ascii');
      const start = type === 'N' ? offset + length - cell.length : offset;
      cell.copy(record, start);
      offset += length;
    });
    return record;
  });
  fs.writeFileSync(filePath, Buffer.concat([header, ...records, Buffer.from([0x1a])]));
}

function makeEan13(prefix: string): string {
  if (!/^\d{12}$/.test(prefix)) throw new Error(`EAN prefix must be 12 digits: ${prefix}`);
  const sum = [...prefix].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${prefix}${(10 - (sum % 10)) % 10}`;
}

function makeImei(first14: string): string {
  if (!/^\d{14}$/.test(first14)) throw new Error(`IMEI prefix must be 14 digits: ${first14}`);
  const sum = [...first14].reduce((total, digit, index) => {
    const value = Number(digit) * (index % 2 === 1 ? 2 : 1);
    return total + (value > 9 ? value - 9 : value);
  }, 0);
  return `${first14}${(10 - (sum % 10)) % 10}`;
}

function foldQuotedPrintable(value: string): string {
  const encoded = [...Buffer.from(value, 'utf8')]
    .map((byte) => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
  const chunks = encoded.match(/(?:=[A-F0-9]{2}){1,13}/g) ?? [encoded];
  return chunks.join('\r\n ');
}

function priceWithGrouping(value: number): string {
  const digits = String(value);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '[\\s\\u00a0\\u202f]?');
}
