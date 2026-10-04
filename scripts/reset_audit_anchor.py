"""
Recover a console that is locked out by a false audit-anchor regression.

    python scripts/reset_audit_anchor.py --yes
    python scripts/reset_audit_anchor.py --client-id mobi-... --yes

When the server refuses an anchor with HTTP 409 ("Sequence regression
detected"), the console drops into read-only mode on purpose: a sequence lower
than the server baseline is the signature of a truncated ledger.

There is one cause that is not an attack. If the local ledger is lost -- wiped
machine, restored backup, reinstall -- the server baseline outlives it, so every
sequence this client can legitimately propose is lower than what the server
already saw. The guard can then never clear and the console stays bricked.

This script clears the server-side anchor so the client can re-anchor at its
real head. It is deliberately explicit:

  * it prints what it is about to destroy, and requires --yes to proceed;
  * it reports the discarded checkpoint so the evidence is not silently lost;
  * it does NOT touch the local ledger. The local ledger is the thing under
    suspicion; this script only clears the server baseline so the console can
    talk again. If the local ledger really was tampered with, restoring it from
    a backup is the correct response, not resetting the anchor.

Exit codes: 0 success, 1 failure, 2 aborted by the operator.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reset the Cloud audit anchor to recover a false 409 lockout."
    )
    parser.add_argument(
        "--client-id",
        default=None,
        help="Override the detected client id (defaults to this machine's id).",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the interactive confirmation.",
    )
    args = parser.parse_args()

    from licensing_app.core.api import AdminApiClient
    from licensing_app.core.audit import client_identifier, load_audit_log
    from licensing_app.config import resolve_settings

    endpoint = resolve_settings().endpoint or "(non configure)"

    client_id = args.client_id or client_identifier()

    try:
        local = load_audit_log()
    except Exception as exc:  # noqa: BLE001
        print(f"[!] Impossible de lire le journal local : {exc}")
        local = None

    print("=" * 68)
    print("  REINITIALISATION DE L'ANCRAGE D'AUDIT CLOUD")
    print("=" * 68)
    print(f"  Worker      : {endpoint}")
    print(f"  client_id   : {client_id}")
    print(f"  Journal local : {len(local) if local is not None else 'illisible'} "
          f"entree(s) -- NON MODIFIE")
    print()
    print("  Cette operation efface le point d'ancrage stocke cote Cloud.")
    print("  A n'utiliser QUE si le journal local a ete perdu ou restaure")
    print("  depuis une sauvegarde. En cas de suspicion d'alteration")
    print("  deliberee, restaurez plutot le journal depuis une sauvegarde.")
    print("=" * 68)

    if not args.yes:
        answer = input("  Taper RESET pour confirmer : ").strip()
        if answer != "RESET":
            print("[i] Annule.")
            return 2

    try:
        api = AdminApiClient()
        result = api.reset_audit_anchor(client_id)
    except Exception as exc:  # noqa: BLE001
        print(f"[X] Echec de la reinitialisation : {exc}")
        return 1

    discarded = result.get("discarded_checkpoint")
    if discarded:
        print()
        print("  Point d'ancrage ecarte (conserve pour reference) :")
        print(f"    sequence_number  : {discarded.get('sequence_number')}")
        print(f"    head_audit_hash  : {discarded.get('head_audit_hash')}")
        print(f"    synced_at        : {discarded.get('synced_at')}")
    else:
        print()
        print("  Aucun ancrage serveur n'existait pour ce client_id.")

    print()
    print("[OK] Ancrage reinitialise. Relancez la console : elle se reancre au")
    print("     sommet de son journal local et le mode lecture seule leve.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
