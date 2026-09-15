# ADR-006: Hardening, Chaos Testing & Standing Gap Radar

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision-Makers:** Autonomous Engineering Agent
- **Consulted:** `AGENTS.md` §5.7 & §6.1

---

## 1. Context & Problem Statement

Maintaining the six non-negotiable contracts (C1 to C6) requires continuous automated enforcement, chaos testing, and active radar tracking of ecosystem crates and Turso cloud developments.

---

## 2. Decision

- **Automated Chaos & Benchmark Harness**:
  - `test_sync_contract.mjs`: asserts $\text{p95} \le 1.5\text{ s}$ sync latency and $\le 35\text{ s}$ relay-kill convergence.
  - `test_offline_chaos.mjs`: asserts 100% offline till operation and zero duplicate charges on 5x retry.
- **Standing Radar Review (Quarterly Cadence)**:
  - Track Turso native server-push capability (to retire the Cloudflare relay when released).
  - Monitor partial/lazy sync in Turso client.
  - Audit dependency licenses and security advisories with `cargo audit` and `npm audit`.
