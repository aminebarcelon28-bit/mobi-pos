/**
 * Spreadsheet-output safety (CSV / SpreadsheetML / XLSX formula injection).
 *
 * A cell whose text starts with `=`, `+`, `-`, `@` (or tab/CR) is executed
 * as a formula when the export opens in Excel/Sheets/LibreOffice. Attacker-
 * controlled labels flow into exports (customer names, expense titles,
 * movement reasons, PO notes), so every string cell must pass through here.
 * The leading apostrophe is Excel/Sheets' text marker: hidden on display,
 * stored as plain text. Numbers, dates and already-safe strings pass through
 * untouched. Apply BEFORE XML-escaping (the marker must survive as a real
 * apostrophe, not an entity, at the XML layer — escapeXml maps it back via
 * &apos;, which parses to the same character).
 */
export function neutralizeSpreadsheetFormula(value: unknown): string {
  const s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

/** CSV field writer: neutralize + RFC-4180 quote. Use for every CSV column. */
export function csvCell(value: unknown): string {
  const s = neutralizeSpreadsheetFormula(value).replace(/"/g, '""');
  return `"${s}"`;
}
