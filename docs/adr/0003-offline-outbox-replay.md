# ADR-003: Idempotent Offline Outbox Replay Engine

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision-Makers:** Autonomous Engineering Agent
- **Consulted:** `AGENTS.md` §1, §6.6 (Durability) & Contracts C2, C5, C6

---

## 1. Context & Problem Statement

Offline sales must survive unexpected power loss, OS termination, and network flapping. Network retries must never cause duplicate ledger adjustments or double-charging merchants.

---

## 2. Decision

We implement the **Transactional Outbox Pattern** (`sync_outbox`) paired with the **`OutboxFlusher`**:
- Every checkout mutation is committed inside an immediate SQLite transaction alongside domain rows.
- Client generates deterministic ULID/UUID `idempotency_key` prior to commit.
- The flusher operates with exponential backoff and random jitter (`backoffMs`), flight locking to prevent race conditions, and `ON CONFLICT DO NOTHING / UPDATE` idempotent replay.
