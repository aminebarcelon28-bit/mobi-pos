# OWNER_ACTIONS — what I need from you (and what happens after)

Three things only you can provide. Each is written as: what to supply → time →
the one command to run → which verdicts flip. Nothing else in the queue needs you.

---

## 1. HAR-002 — printer session (Arabic, cut, drawer on paper)

**What I need**

- Two paper widths: **58 mm** and **80 mm**.
- Two printers: **one Epson-class** (TM-T20/TM-T88 family) and **one clone**.
- The interface for each: **USB** (Windows queue name), **network** (`ip:port`,
  port 9100 by default) or **Bluetooth** (name).
- A person at the machine for ~10 minutes per printer.

**What you do**

1. Plug both printers in; make sure the Epson queue is installed on Windows if USB.
2. Run, once per printer:

   ```
   npm run escpos:kit -- --host <ip>            # network
   npm run escpos:kit -- --host 127.0.0.1 --port <raw-port>
   ```

   Without `--host` it only writes the artifacts; with it, it prints the four test
   tickets (Arabic 80, Latin 80, Arabic 58, drawer pulse).
3. Walk `tests/results/escpos/hardware-kit/CHECKLIST.md` (11 lines: alignment,
   accents, Arabic shaping and RTL, barcode scans, totals, cut, drawer, 58 mm wrap,
   reprint identity) and sign it.

**Time:** 10 minutes per printer.

**Verdicts that flip:** RCP-01/02/12/13/21 stay **PASS-SIM** until this runs; the
checklist signature upgrades them to hardware-verified, and RCP-19/RCP-24 (USB vs
Bluetooth, remote print) become runnable. RCP-06/10 (cut, drawer) gain hardware
confirmation.

---

## 2. HAR-003 — merchant gateway + enrolled device keys

**What I need**

- A **gateway URL** running `proxy/gateway.mjs` (or any server implementing the
  same contract: signed ingest, per-device sequence arbitration,
  `SERVERTIME_V1` tokens).
- The **Ed25519 public key** of each terminal, enrolled on that gateway under its
  device id (`registerDevice(id, pubkeyHex)` at commissioning, or the
  `GATEWAY_DEVICE_KEYS` JSON).
- If the POS must talk to a **real card acquirer** (not the simulator), that
  acquirer's sandbox credentials.

**What you do**

1. Start the gateway with the merchant secret and the enrolled pubkeys.
2. On each terminal, set the gateway URL in Settings → Sync (the value is stored
   in the OS keyring; it is a manager-only action since SEC-01 increment 1).
3. Run:

   ```
   npm run test:sync-e2e                          # loopback verifier
   npm run test:sync-two-device                   # two protocol clients + faults
   npm run test:two-instance                      # two real terminals + faults
   POS_GATEWAY_URL=<url> npm run test:two-instance -- --real
   ```

   (the last form is the one that points at your gateway; it is added with the
   real-transport switch.)

**Time:** ~30 minutes (gateway up + enrol + run), plus your ops time to create the
keys.

**Verdicts that flip:** SYN-05, SYN-06, SYN-07, SYN-11, SYN-21, SYN-29 (currently
**BLOCKED** on exactly this). The signed-lane ship gate ("server verifies device
signatures") also closes.

---

## 3. HAR-004 — fiscal numbering confirmation (accountant)

**What I need — the questions for your accountant**

1. Does the numbering need to be **continuous per outlet/register**, or one
   **global merchant sequence**?
2. Does a **device-prefixed series** (e.g. `REC-AB12-000123`, one continuous
   counter per terminal, printed on the ticket) satisfy the rule, or must the
   numbers be consecutive across all terminals?
3. If a device series is acceptable: must the series be **registered** with the tax
   administration, and does it **reset annually** (and from which date)?
4. Are credit notes (`AVOIR`) required to run in their **own series** (they do
   today), or continuous with sales?

**What I do after your answer**

- If device series are confirmed: nothing changes in the code (the seam is already
  that), I move the counter into the native DB transaction, add
  `UNIQUE(receipt_number)`, and record the confirmation in ADR-006.
- If a global sequence is required: I would need the offline block-reservation
  design (devices reserve number blocks while online) — say so and I will scope it.

**Time:** a conversation with your accountant.

**Verdicts that flip:** SYN-02 is currently **PASS** against the provisional
device-series rule; the confirmation either keeps it (and removes the
"provisional" flag) or reopens it with the global-sequence design.

---

## Everything else is mine

The remaining queue items (SEC-01 increments 2–3, product gaps RCP-05/07/10/11/12/
15/16/18/22/23, TIM-02/07, CRM-03/06, G-23) need no owner input.
