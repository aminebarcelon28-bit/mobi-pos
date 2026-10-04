# SAV Staging — On-Device Manual Hardware Checklist

Staging build: `dist/` (fresh `npm run build`, exit 0 — see `C:\Users\Click\AppData\Local\Temp\opencode\build.log`).
Browser E2E status: `e2e/sav-settle-deliver.spec.ts` green (22/22, headless Chromium).
Boundary: live UI-click **payment → Livré** is Tauri-only (`writeCheckoutAtomic` → SQLite authority,
fail-closes in plain Chromium by design). Verify it below on-device, where SQLite exists.

Deploy options:
- Desktop staging: `npx tauri dev` (or serve `dist/` behind the Tauri shell) on the test PC.
- Android staging: `build-android.bat` (verifies + auto-repairs toolchain, then builds APK).

Seed a staging license first (offline, placeholder key — never a customer key):
`node scripts/license-admin.mjs token --key MOBI-LIFE-KSXF-HTV4 --hwid <device-hwid>`,
then paste the JWT into the activation screen. On Android the HWID is the native
Android ID (shown on the activation screen); mint against that exact value.

## Test 1 — Android touch (bottom-sheet + 48px targets + keyboard)

1. Open Gestion → Atelier → **Réparations & SAV Atelier** (badge shows active count) or
   **[+ Nouveau SAV]** shortcut → bottom sheet slides up with drag handle.
2. Fill intake (IMEI blur → Luhn badge; phone auto-masks to `0X XX XX XX XX`).
3. Confirm: every input, preset chip, checklist toggle, CTA is ≥ 48px;
   checklists collapse to the `[Réception | Sortie]` segmented control;
   focusing the lowest input with the virtual keyboard open never covers the
   sticky bottom action bar (`Enregistrer le Ticket SAV`).
4. Save → ticket appears in Historique; set `Prêt / Terminé` → **[Régler & Livrer]**.

PASS = all of the above with no hidden/overlapping controls.

## Test 2 — Thermal print (58mm ESC/POS tag formatting)

Prereqs: pair the BT/Network thermal printer in Android Bluetooth settings
(PIN often 0000/1234), then print a Sale receipt once to confirm routing.

1. In the SAV dossier: **Fiche Reçu** → two Android sheets must open:
   (a) `Bon SAV <ticket>` (customer voucher), (b) `Étiquette <ticket>` (58mm tag).
2. On paper verify the tag: `SAV: <ticket>` header, device model, `Ticket:` line,
   `IMEI:` line, `Client: <name> (<last4>)`, `*<ticket>*` barcode-text line,
   date line — all lines ≤ 32 columns, no wrapping/truncation.
3. Desktop (paired label printer): run intake triad → voucher + workshop slip +
   chassis sticker (or 58mm fallback with the "mode ticket 58mm" toast).

PASS = legible 32-col tag + scannable `*ticket*` line; fallback toast iff no TSPL/ZPL.

## Test 3 — Live payment → Livré (Tauri/Android only)

1. Ticket total 5000 / deposit 1500 → `Prêt / Terminé` → **[Régler & Livrer]** →
   `SAV-<ticket>` 3 500 DA line lands in cart.
2. Encaisser → Exact → **Valider & Imprimer Reçu** → sale commits.
3. Assert: cart cleared, `sav_cart_linkage_v1` empty, dossier shows **Livré**
   without reload (reactive), Z-report drawer math includes the 3 500 DA.

PASS = steps 1–3 with zero cash leakage (remaining never collectible twice).

Record results (PASS/FAIL + device + build hash) back into this file's table:

| Date | Device | Build | T1 Touch | T2 Print | T3 Pay→Livré | Notes |
|------|--------|-------|----------|----------|--------------|-------|
|      |        |       |          |          |              |       |
