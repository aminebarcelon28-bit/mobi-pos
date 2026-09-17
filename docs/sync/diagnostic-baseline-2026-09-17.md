# Cloud Diagnostic §10.7 Baseline Evidence

**Date:** 2026-09-17T02:21:49+01:00  
**Database:** `libsql://zou-zoughlal.aws-us-east-1.turso.io`  
**Purpose:** Pre-patch baseline to prove the 36 MB/day fix and track storage hygiene.

---

## 1. Page Allocation & Bloat Metrics
| PRAGMA | Value | Analysis |
|---|---|---|
| `page_size` | `4096` bytes | Standard SQLite page size |
| `page_count` | `8792` pages | **36,012,032 bytes ≈ 34.34 MiB (~36 MB)** |
| `freelist_count` | `0` pages | Currently packed with large BLOB payloads |

---

## 2. Table Footprint (`dbstat` analysis)
| Table Name | Size (KB) | Size (MB) | Share of Total | Primary Cause |
|---|---|---|---|---|
| `products` | 19,844 KB | **19.38 MB** | **56.43%** | 1 product (`prod-1789591848585-909`) carrying 20,260,360 bytes of base64 image data in `json_payload` |
| `transactions` | 14,988 KB | **14.63 MB** | **42.62%** | 26 transactions whose item snapshots embedded the 20 MB product `json_payload` |
| `sqlite_schema` | 20 KB | 0.02 MB | 0.06% | Schema definition & index metadata |
| `transaction_items` | 16 KB | 0.02 MB | 0.05% | Normal relational line items |
| `inventory_ledger` | 16 KB | 0.02 MB | 0.05% | Append-only inventory deltas |
| Other tables | 128 KB | 0.13 MB | 0.38% | Trade-ins, expenses, indexes |
| **Total** | **35,016 KB** | **~34.34 MB** | **100%** | |

---

## 3. Key Forensics Finding
The 36 MB day-one cloud bloat is directly caused by:
1. Unconstrained product image/media storage in `json_payload` (`20.26 MB` in a single product row).
2. Transaction receipts embedding the full unstripped product JSON blob (`14.63 MB` across 26 transactions).
3. Lack of auto-vacuum and outbox payload purging on the legacy replication loop.
