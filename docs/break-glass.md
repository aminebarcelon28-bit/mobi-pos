# Break-glass runbook — operating MobiPOS licensing without the owner

**Status: DRAFT skeleton.** Every `[FILL]` marker must be completed by the
owner before this document is accepted. A printed copy lives with the key
escrow; this file is the working copy. Nothing in this file may contain a
secret value — names and locations only.

**Acceptance test (plan §9.5):** a second person, on a laptop that has never
built this project, follows this runbook and mints one working key in under
30 minutes without contacting the owner. Record the attempt as an `E-####`
evidence entry. If it takes longer, this runbook is wrong, not the person.

---

## 1. What breaks if the owner is unreachable

| Thing | Behaviour | Action needed |
|---|---|---|
| Lifetime licences | Keep working. They never phone home for validity. | None. |
| Expiring trials / 90-day licences | Stop at `exp` (signed expiry), by design. | Mint a new key (§3). |
| New sales | Stop until someone mints a key. | Mint a key (§3). |
| Cloudflare Worker outage | Activation/verify fail; existing devices keep working offline until signed expiry. | See `docs/ops.md` §Health. |
| Turso master DB outage | Same as above; rate limits fail open, activation fails. | Restore per `docs/ops.md` §Backups. |

## 2. Where the signing key lives

- **Live copy:** Cloudflare Worker secret `LICENSE_ED25519_PRIVATE_JWK_K2`
  (current signing key, `kid: k2`). Paste-once via
  `npx wrangler secret put LICENSE_ED25519_PRIVATE_JWK_K2`; never readable
  back. Legacy key `LICENSE_ED25519_PRIVATE_JWK` (`kid: k1`) is sunset —
  verification-only via the public key in the app; never sign with it.
- **Offline escrow:** two sealed copies (one at home `[FILL location]`, one
  off-site `[FILL location]`). Each envelope contains: the date, the key id
  (`kid: k2`, public key `h8uQ-7zm_yApFXmdGKj5QQnRNu39QkMBKxEje4aQGxU`),
  and a card with the restore command (§4). Never in git, never in a
  password-manager note alone, never in a screenshot.
- **Public keys** are not secret; they are pinned in `src/licensing/publicKey.ts`.

## 3. How to mint a lifetime key by hand

Prerequisites: a clone of the repo, Node 22+, the `.env.licensing` file
(stored `[FILL location]` — it holds the pepper and Turso credentials, never
commit it), and network access to the Turso DB.

```bash
npm install
npm run license:mint        # interactive: customer name, formula, seats
npm run test:license        # must stay green — proves the tooling is sane
```

`license:mint` prints the activation key and writes the ledger. Hand the
customer the key over WhatsApp; they paste it into the app's activation
screen. Verify afterwards in the console (`npm run license:ui`) that the
licence appears with the right seats.

If the Worker is down, the key still activates: activation verifies the
Ed25519 signature locally against the pinned public key. Only the server-side
seat bookkeeping needs the DB.

## 4. How to rotate the signing key (k2 → k3)

1. Generate a new Ed25519 JWK offline; name its id `k3`.
2. Add `LICENSE_ED25519_PRIVATE_JWK_K3` as a Worker secret and teach
   `pickSigningKey` (`workers/licensing/src/crypto.ts`) to prefer `k3`.
3. Add the k3 public key to `src/licensing/publicKey.ts` and extend the
   kernel's accepted `kid` set (`allowedKids`): **k1 and k2 stay listed
   forever** so already-stored tokens keep verifying.
4. `npx wrangler deploy`; run `npm run test:license` and the kernel suite.
5. Replace the escrow envelope contents; record an `E-####` entry.
6. Never delete a `kid` from the accepted set — rotation adds, it never removes.

## 5. Account access (the list, not the secrets)

| Account | Email | Recovery codes |
|---|---|---|
| Domain registrar | `[FILL]` | `[FILL location]` |
| Cloudflare (Workers, Pages, R2) | `[FILL]` | `[FILL location]` |
| Turso (master + replica DBs) | `[FILL]` | `[FILL location]` |
| GitHub (repo, Actions, releases) | `[FILL]` | `[FILL location]` |
| Telegram (owner doorbell bot) | `[FILL]` | via @BotFather reset |
| WhatsApp business number | `[FILL number]` | SIM/phone in `[FILL location]` |

When the R2 distribution path is live (plan §7.7), also record here the
payment-provider webhook secret name (`POLAR_WEBHOOK_SECRET` or equivalent)
and the agreed lifetime price `[PRIX]` — break-glass must be able to mint a
paid key without the owner if the webhook is down.

## 6. How to revoke and re-issue

1. Open the console: `npm run license:ui` (local admin dashboard).
2. Find the customer in the licence table; use **Revoke** (suspends the
   licence server-side; the next verify on the device locks the app).
3. Seat resets and expiry changes are in the same table's action menu.
4. The customer sees the suspension reason from the app's lock screen; for a
   re-issue, mint a fresh key (§3) and send it over WhatsApp. A revoked key
   never becomes valid again — always mint a new one.
5. Every admin action is audit-logged; check the audit trail if a customer
   disputes what happened.

## 7. If this document is wrong

Fix it in the same change that revealed the problem, append an `E-####`
evidence entry, and reprint the escrow copy. A runbook that drifts from
reality is worse than none.
