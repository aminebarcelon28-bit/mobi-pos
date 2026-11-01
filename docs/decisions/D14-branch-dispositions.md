# Decision D14 — disposition of the four unmerged branches

- **Status:** applied 2026-11-01. Three branches retired (content preserved as archive tags), one retained with a
  reason. Nothing was deleted without a permanent reference.

## Inventory (before)

| Branch | Head | Ahead / behind `main` | Last commit | Disposition |
|---|---|---|---|---|
| `feature/imei-support` | `ed77409` | 1 / 1 | “wip(imei): shared warranty-anchor probe (unreviewed, parked for A3 sequencing)” | **Retired** → `archive/feature-imei-support-2026-11-01` |
| `stash-audit-wip` | `f541821` | 2 / 2 | “On feat/fifo-costing-price-override: cmd-ticket-wip” | **Retired** → `archive/stash-audit-wip-2026-11-01` |
| `stash-sync-harness-wip` | `65ee580` | 3 / 3 | “On feat/fifo-costing-price-override: audit-fix-session-WIP” | **Retired** → `archive/stash-sync-harness-wip-2026-11-01` |
| `remediation/a3-wt` | `b6c42df` | 33 / 33 | “docs(fifo): canonical ledger contract on getProductStockBatches” | **Retained** (checked out in the external worktree `C:/Users/Click/Desktop/worktree-a3`); archived as `archive/remediation-a3-wt-2026-11-01` |

## Why this shape

- Merging unreviewed WIP (1–3 commits whose own subjects say “unreviewed, parked”, “wip”) into a release
  candidate would trade a clean tree for unverified behaviour — the opposite of the money-first rule.
- Deleting them outright would discard work. An **annotated tag at the exact commit** keeps every object
  reachable forever (`git rev-parse 'archive/<name>-2026-11-01^{commit}'` resolves), so the branch name can go.
- `remediation/a3-wt` is **checked out in a worktree** (git refuses to delete it). Deleting the worktree is a
  user-environment decision, not a repository one, so the branch is retained and only archived.

## Verification

```
git tag -l 'archive/*'
# archive/feature-imei-support-2026-11-01
# archive/remediation-a3-wt-2026-11-01
# archive/stash-audit-wip-2026-11-01
# archive/stash-sync-harness-wip-2026-11-01
git branch        # only main (+ remediation/a3-wt, worktree-checked-out)
```

## Reversal

`git branch <name> archive/<name>-2026-11-01` restores any retired branch exactly.

## Follow-up (recorded, not done)

`remediation/a3-wt`’s 33 commits need a dedicated integration review cycle (its subject line suggests FIFO
ledger-contract docs). Until then it must not be merged into a release tag.
