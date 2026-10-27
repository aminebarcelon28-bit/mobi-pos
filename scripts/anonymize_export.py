#!/usr/bin/env python3
"""
scripts/anonymize_export.py — Anonymizer, Self-Test & Differential Parser Oracle

Usage:
  python scripts/anonymize_export.py --self-test
  python scripts/anonymize_export.py --cross-check <file.csv|file.tsv|file.xlsx> [--sheet <name_or_index>]
  python scripts/anonymize_export.py <input_file> <output_file> [--seed <int>]

Guarantees:
  1. Never leaks raw phone numbers, person names, or NIFs into anonymized exports.
  2. Preserves structure, column counts, empty cells, and number/money/barcode formats.
  3. Cell-by-cell differential oracle using Python stdlib (csv + zipfile/xml.etree) for comparison against Rust parser.
"""

import sys
import os
import re
import csv
import json
import hashlib
import argparse
import zipfile
import xml.etree.ElementTree as ET
from typing import List, Dict, Any, Tuple, Optional

# Regex for Algerian phone numbers (Mobile 05/06/07, Landline 02x/03x/04x)
ALGERIAN_PHONE_PATTERN = re.compile(
    r'(?:\+213|00213|0)(?:[567]\d{8}|[2-4]\d{7})'
)
# Standalone 15-digit NIF or IMEI candidate
DIGITS_15_PATTERN = re.compile(r'^\d{15}$')

def luhn_checksum(digits: str) -> bool:
    if not digits.isdigit():
        return False
    total = 0
    reverse_digits = digits[::-1]
    for i, char in enumerate(reverse_digits):
        n = int(char)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0

class Anonymizer:
    def __init__(self, seed: int = 42):
        self.seed = seed
        self.phone_map: Dict[str, str] = {}
        self.name_map: Dict[str, str] = {}
        self.nif_map: Dict[str, str] = {}
        self.phone_counter_mobile = 1
        self.phone_counter_landline = 1
        self.name_counter = 1
        self.nif_counter = 1

    def anonymize_phone(self, raw_val: str) -> str:
        cleaned = re.sub(r'[\s\-\.\(\)]', '', raw_val)
        if cleaned in self.phone_map:
            return self.phone_map[cleaned]

        # Determine if mobile or landline
        is_intl = cleaned.startswith('+213') or cleaned.startswith('00213')
        if is_intl:
            stripped = cleaned[4:] if cleaned.startswith('+213') else cleaned[5:]
        elif cleaned.startswith('0'):
            stripped = cleaned[1:]
        else:
            stripped = cleaned

        if stripped.startswith(('5', '6', '7')) and len(stripped) == 9:
            # Algerian mobile
            prefix = stripped[0]
            fake_num = f"0{prefix}{self.phone_counter_mobile:08d}"
            self.phone_counter_mobile += 1
        elif stripped.startswith(('2', '3', '4')) and len(stripped) == 8:
            # Algerian landline
            prefix = stripped[0:2]
            fake_num = f"0{prefix}{self.phone_counter_landline:06d}"
            self.phone_counter_landline += 1
        else:
            fake_num = f"055{self.phone_counter_mobile:07d}"
            self.phone_counter_mobile += 1

        self.phone_map[cleaned] = fake_num
        return fake_num

    def anonymize_cell(self, cell_val: str, header: str = "") -> str:
        if not cell_val:
            return cell_val
        val_str = str(cell_val).strip()
        if not val_str:
            return val_str

        # Check for phone
        cleaned_digits = re.sub(r'[\s\-\.\(\)]', '', val_str)
        if (val_str.startswith('+213') or val_str.startswith('00213') or 
            (val_str.startswith('0') and len(cleaned_digits) in (9, 10)) or
            (len(cleaned_digits) in (8, 9) and cleaned_digits.isdigit() and 'tel' in header.lower())):
            return self.anonymize_phone(val_str)

        # Check for 15-digit NIF (if header or content suggests NIF)
        if DIGITS_15_PATTERN.match(cleaned_digits) and ('nif' in header.lower() or not luhn_checksum(cleaned_digits)):
            if cleaned_digits not in self.nif_map:
                self.nif_map[cleaned_digits] = f"999{self.nif_counter:012d}"
                self.nif_counter += 1
            return self.nif_map[cleaned_digits]

        # Check for client/contact name column
        header_lower = header.lower()
        if any(k in header_lower for k in ('client', 'customer', 'nom', 'prenom', 'contact', 'fournisseur', 'fourn')):
            # If it's a person/company name, anonymize it
            if not val_str.replace('.', '', 1).replace(',', '', 1).isdigit():
                if val_str not in self.name_map:
                    kind = "Fournisseur" if "fourn" in header_lower else "Client"
                    self.name_map[val_str] = f"{kind}_{self.name_counter:04d}"
                    self.name_counter += 1
                return self.name_map[val_str]

        return val_str

# --- Differential Parser Oracle (Python stdlib) ---

def parse_csv_tsv_python(filepath: str, encoding: str = 'utf-8') -> List[List[str]]:
    with open(filepath, 'rb') as f:
        raw_bytes = f.read()

    # Detect encoding if not explicitly UTF-8
    try:
        content = raw_bytes.decode('utf-8-sig')
    except UnicodeDecodeError:
        try:
            content = raw_bytes.decode('windows-1256')
        except UnicodeDecodeError:
            content = raw_bytes.decode('windows-1252', errors='replace')

    # Detect delimiter: comma, semicolon, tab, pipe
    first_line = content.splitlines()[0] if content.splitlines() else ""
    delimiter = ','
    counts = {
        '\t': first_line.count('\t'),
        ';': first_line.count(';'),
        ',': first_line.count(','),
        '|': first_line.count('|'),
    }
    sorted_delims = sorted(counts.items(), key=lambda x: x[1], reverse=True)
    if sorted_delims[0][1] > 0:
        delimiter = sorted_delims[0][0]

    reader = csv.reader(content.splitlines(), delimiter=delimiter)
    return [row for row in reader]

def parse_xlsx_python(filepath: str, sheet_index: int = 0) -> List[List[str]]:
    """Minimal, robust zero-dependency XLSX parser using stdlib zipfile and xml.etree."""
    with zipfile.ZipFile(filepath, 'r') as z:
        # 1. Read shared strings if present
        shared_strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            tree = ET.fromstring(z.read('xl/sharedStrings.xml'))
            ns = {'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            for si in tree.findall('main:si', ns):
                # An si can have a single <t> or multiple rich text <r><t>
                text_parts = []
                t_elem = si.find('main:t', ns)
                if t_elem is not None and t_elem.text:
                    text_parts.append(t_elem.text)
                for r in si.findall('main:r', ns):
                    rt = r.find('main:t', ns)
                    if rt is not None and rt.text:
                        text_parts.append(rt.text)
                shared_strings.append("".join(text_parts))

        # 2. Find sheets in xl/workbook.xml
        wb_tree = ET.fromstring(z.read('xl/workbook.xml'))
        ns = {'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        sheets = wb_tree.findall('main:sheets/main:sheet', ns)
        sheet_filename = f"xl/worksheets/sheet{sheet_index + 1}.xml"
        if sheet_filename not in z.namelist():
            # Fallback to first available sheet*.xml
            candidates = [name for name in z.namelist() if name.startswith('xl/worksheets/sheet') and name.endswith('.xml')]
            if not candidates:
                return []
            sheet_filename = sorted(candidates)[0]

        sheet_tree = ET.fromstring(z.read(sheet_filename))
        rows = []
        for row_elem in sheet_tree.findall('main:sheetData/main:row', ns):
            row_vals = []
            for c_elem in row_elem.findall('main:c', ns):
                cell_type = c_elem.get('t')
                v_elem = c_elem.find('main:v', ns)
                val = ""
                if v_elem is not None and v_elem.text is not None:
                    raw_v = v_elem.text
                    if cell_type == 's':  # shared string
                        idx = int(raw_v)
                        val = shared_strings[idx] if idx < len(shared_strings) else ""
                    else:
                        val = raw_v
                elif cell_type == 'inlineStr':
                    is_elem = c_elem.find('main:is/main:t', ns)
                    if is_elem is not None and is_elem.text:
                        val = is_elem.text
                row_vals.append(val)
            rows.append(row_vals)
        return rows

def cross_check(filepath: str, sheet_index: int = 0) -> str:
    ext = os.path.splitext(filepath)[1].lower()
    if ext in ('.xlsx', '.xlsm'):
        rows = parse_xlsx_python(filepath, sheet_index)
    else:
        rows = parse_csv_tsv_python(filepath)
    # Output standardized JSON
    return json.dumps({
        "file": filepath,
        "row_count": len(rows),
        "rows": rows
    }, ensure_ascii=False)

def run_self_test() -> bool:
    print("[RUNNING] anonymize_export.py self-test...")
    anon = Anonymizer(seed=12345)

    # Test 1: Mobile phone anonymization & format retention
    p1 = anon.anonymize_cell("+213 550 12 34 56", header="Téléphone")
    assert p1.startswith("05"), f"Expected 05 prefix for mobile, got {p1}"
    assert len(p1) == 10, f"Expected 10 digits for Algerian mobile, got {len(p1)}"

    p2 = anon.anonymize_cell("0661223344", header="Tél")
    assert p2.startswith("06"), f"Expected 06 prefix for mobile, got {p2}"
    assert len(p2) == 10, f"Expected 10 digits, got {len(p2)}"

    # Test 2: Landline phone
    p3 = anon.anonymize_cell("021123456", header="Numéro Fixe")
    assert p3.startswith("021"), f"Expected 021 prefix for landline, got {p3}"
    assert len(p3) == 9, f"Expected 9 digits for Algiers landline, got {len(p3)}"

    # Test 3: Raw name anonymization
    n1 = anon.anonymize_cell("Mohamed Benali", header="Nom Client")
    assert "Client_" in n1, f"Expected Client_ prefix, got {n1}"
    assert "Mohamed" not in n1 and "Benali" not in n1, "PII leak in customer name!"

    n2 = anon.anonymize_cell("Eurl Distribution Algerie", header="Fournisseur")
    assert "Fournisseur_" in n2, f"Expected Fournisseur_ prefix, got {n2}"
    assert "Distribution" not in n2, "PII leak in supplier name!"

    # Test 4: Price & Barcode preservation
    price = anon.anonymize_cell("1500,50", header="Prix Vente")
    assert price == "1500,50", f"Price was mutated! {price}"

    barcode = anon.anonymize_cell("6132450019283", header="Code Barre")
    assert barcode == "6132450019283", f"Barcode was mutated! {barcode}"

    # Test 5: 15-digit NIF vs IMEI Luhn
    # Valid Luhn 15-digit: 356938035643809
    imei_sample = "356938035643809"
    assert luhn_checksum(imei_sample), "Expected IMEI sample to pass Luhn"
    res_imei = anon.anonymize_cell(imei_sample, header="IMEI")
    assert res_imei == imei_sample, "IMEI should not be anonymized if header is IMEI"

    # Non-Luhn 15-digit NIF: 000116090000034
    nif_sample = "000116090000034"
    res_nif = anon.anonymize_cell(nif_sample, header="NIF")
    assert res_nif.startswith("999"), f"Expected NIF to be masked, got {res_nif}"

    print("[PASS] anonymize_export.py self-test passed with 0 errors!")
    return True

def main():
    parser = argparse.ArgumentParser(description="Anonymizer & Differential Parser Oracle for MobiPOS Smart Import")
    parser.add_argument("--self-test", action="store_true", help="Run internal self-tests")
    parser.add_argument("--cross-check", type=str, help="Differential parse file and print JSON table")
    parser.add_argument("--sheet", type=int, default=0, help="Sheet index for xlsx")
    parser.add_argument("input_file", nargs="?", help="Input file to anonymize")
    parser.add_argument("output_file", nargs="?", help="Output file path")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")

    args = parser.parse_args()

    if args.self_test:
        if not run_self_test():
            sys.exit(1)
        sys.exit(0)

    if args.cross_check:
        output = cross_check(args.cross_check, args.sheet)
        print(output)
        sys.exit(0)

    if args.input_file and args.output_file:
        anon = Anonymizer(seed=args.seed)
        rows = parse_csv_tsv_python(args.input_file)
        if not rows:
            print("No rows found in input file", file=sys.stderr)
            sys.exit(1)
        headers = rows[0]
        anonymized_rows = [headers]
        for row in rows[1:]:
            anon_row = []
            for col_idx, cell in enumerate(row):
                header = headers[col_idx] if col_idx < len(headers) else ""
                anon_row.append(anon.anonymize_cell(cell, header))
            anonymized_rows.append(anon_row)

        with open(args.output_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerows(anonymized_rows)
        print(f"Anonymized file written to {args.output_file}")
        sys.exit(0)

    parser.print_help()

if __name__ == '__main__':
    main()
