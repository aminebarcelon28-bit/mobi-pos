#!/usr/bin/env python3
"""
MobiPOS - Outil Technicien de Récupération de Code PIN (Modèle 1)

Cet outil est destiné exclusivement au distributeur / technicien agréé.
Lorsqu'un client oublie son code PIN gérant :
1. Le client clique sur "Code oublié ? Assistance technicien" sur sa caisse.
2. La caisse affiche un code de défi (ex: MOBI-8F2A-W9ET).
3. Vous saisissez ce code de défi dans cet outil.
4. L'outil génère un code de secours à 6 chiffres (ex: 137680) valable aujourd'hui.
5. Vous donnez ce code au client par téléphone ou WhatsApp.
6. Le client le saisit sur sa caisse pour débloquer la caisse et choisir son nouveau code PIN.
"""

import sys
import hmac
import hashlib
from datetime import datetime, timezone, timedelta

TECHNICIAN_MASTER_SECRET = b"MOBI-TECH-RESCUE-SECRET-v1-SECURE-KEY"
CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

def get_utc_date_str(offset_days: int = 0) -> str:
    now = datetime.now(timezone.utc) + timedelta(days=offset_days)
    return now.strftime("%Y%m%d")

def compute_challenge_checksum(date_str: str, nonce: str) -> str:
    msg = f"CHALLENGE:{date_str}:{nonce}".encode("utf-8")
    h = hmac.new(TECHNICIAN_MASTER_SECRET, msg, hashlib.sha256).digest()
    val = int.from_bytes(h[:4], "big")
    res = []
    for i in reversed(range(4)):
        res.append(CROCKFORD_ALPHABET[(val >> (5 * i)) & 31])
    return "".join(res)

def compute_technician_otp(date_str: str, nonce: str) -> str:
    msg = f"RESPONSE:{date_str}:{nonce}".encode("utf-8")
    h = hmac.new(TECHNICIAN_MASTER_SECRET, msg, hashlib.sha256).digest()
    code = int.from_bytes(h[:4], "big") % 1_000_000
    return f"{code:06d}"

def solve_challenge(challenge_str: str) -> dict:
    clean = challenge_str.strip().upper()
    parts = clean.split("-")
    
    if len(parts) == 3 and parts[0] == "MOBI":
        nonce, chk = parts[1], parts[2]
    elif len(parts) == 2:
        nonce, chk = parts[0], parts[1]
    else:
        return {"error": "Format invalide. Format attendu : MOBI-XXXX-YYYY (ex: MOBI-8F2A-W9ET)"}

    if len(nonce) != 4 or len(chk) != 4:
        return {"error": "Longueur invalide. Le code doit comporter 2 blocs de 4 caractères."}

    # Verify against today, yesterday, tomorrow
    matched_date = None
    matched_offset = None
    for offset in (0, -1, 1):
        d = get_utc_date_str(offset)
        expected_chk = compute_challenge_checksum(d, nonce)
        if expected_chk == chk:
            matched_date = d
            matched_offset = offset
            break

    if not matched_date:
        # Generate OTP anyway for today as fallback, but flag checksum warning
        d = get_utc_date_str(0)
        otp = compute_technician_otp(d, nonce)
        return {
            "warning": "Attention : La somme de contrôle ne correspond pas à aujourd'hui (date de caisse décalée ?).",
            "date": d,
            "nonce": nonce,
            "otp": otp,
        }

    otp = compute_technician_otp(matched_date, nonce)
    return {
        "ok": True,
        "date": matched_date,
        "offset": matched_offset,
        "nonce": nonce,
        "otp": otp,
    }

def main():
    if len(sys.argv) > 1:
        raw_input_code = sys.argv[1]
    else:
        print("=" * 60)
        print("  MobiPOS - ASSISTANCE TECHNICIEN (RÉCUPÉRATION CODE PIN)")
        print("=" * 60)
        try:
            raw_input_code = input("\nEntrez le code de défi du client (ex: MOBI-8F2A-W9ET) : ")
        except (KeyboardInterrupt, EOFError):
            print("\nAnnulé.")
            return

    res = solve_challenge(raw_input_code)
    if "error" in res:
        print(f"\n[ERREUR] {res['error']}")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("  CODE DE DÉVERROUILLAGE GÉNÉRÉ")
    print("=" * 60)
    print(f"  Code de Défi Client : {raw_input_code.strip().upper()}")
    print(f"  Date UTC Validée    : {res['date']}")
    if res.get("warning"):
        print(f"  [Avertissement]     : {res['warning']}")
    print("-" * 60)
    print(f"  >>> CODE DE SECOURS (6 CHIFFRES) : {res['otp']} <<<")
    print("-" * 60)
    print("  Transmettez ce code au client.")
    print("  Dès sa saisie sur la caisse, la caisse se déverrouillera")
    print("  et lui demandera de saisir son nouveau code PIN gérant.")
    print("=" * 60 + "\n")

if __name__ == "__main__":
    main()

