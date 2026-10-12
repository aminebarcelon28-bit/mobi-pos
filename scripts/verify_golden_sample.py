"""Golden-sample cross-check (third implementation): recompute invoice and
display vectors with Python Fraction/integer arithmetic — no shared code
with the JS generator or the TS oracle.

Usage: python scripts/verify_golden_sample.py
"""
import json
import re
from fractions import Fraction
from pathlib import Path

doc = json.loads(Path(__file__).resolve().parent.parent.joinpath("e2e", "golden", "money-vectors.json").read_text())


def h_up(n: int, d: int) -> int:
    # Trunc-toward-zero half-up (matches Rust/TS mul_div_half_up, incl. negatives).
    q = abs(n) // d * (1 if n >= 0 else -1)
    r = n - q * d
    return q + 1 if 2 * r >= d else q


def display_of(minor: int) -> str:
    neg = minor < 0
    a = abs(minor)
    whole, frac = divmod(a, 100)
    digits = str(whole)
    head = len(digits) % 3 or 3
    parts = [digits[:head]] + [digits[i : i + 3] for i in range(head, len(digits), 3)]
    return f"{'-' if neg else ''}{' '.join(parts)}.{frac:02d} DA"


checked = 0
for v in doc["vectors"]["display"]:
    assert display_of(int(v["minorMinor"])) == v["display"], v["id"]
    checked += 1
for v in doc["vectors"]["parse"]:
    # Fraction-exact decimal parse of the plain-ASCII subset only.
    if any(ord(c) > 127 for c in v["input"]):
        continue
    s = v["input"].replace(" ", "")
    if re.fullmatch(r"\d{1,3}(\.\d{3})+", s):  # FR-grouped integer (both engines)
        assert int(s.replace(".", "")) * 100 == int(v["minorMinor"]), v["id"]
        checked += 1
        continue
    if "," in s and "." in s:  # strict FR grouped
        int_p, frac_p = s.replace(".", "").split(",")
    elif "," in s:
        int_p, frac_p = s.split(",")
    elif "." in s:
        int_p, frac_p = s.split(".")
    else:
        int_p, frac_p = s, ""
    assert len(frac_p) <= 2, v["id"]
    assert int(int_p or 0) * 100 + int(frac_p.ljust(2, "0") or 0) == int(v["minorMinor"]), v["id"]
    checked += 1
for v in doc["vectors"]["invoice"]:
    if "expectedError" in v:
        # Discount exceeds line: verify the generator's rejection is real.
        u = int(v["lines"][0]["unitMinor"])
        f = int(v["lines"][0].get("discountFixedMinor", "0"))
        assert f > u * v["lines"][0]["qty"], v["id"]
        checked += 1
        continue
    base = 0
    for line in v["lines"]:
        gross = int(line["unitMinor"]) * line["qty"]
        base += gross - int(line.get("discountFixedMinor", "0"))
    disc = h_up(base * int(v["cartPctBp"]), 10000) if base > 0 and int(v["cartPctBp"]) > 0 else 0
    assert base - disc == int(v["expectedTotalMinor"]), v["id"]
    checked += 1

print(f"golden-sample: {checked} vectors re-verified with Python Fraction/integer math")
