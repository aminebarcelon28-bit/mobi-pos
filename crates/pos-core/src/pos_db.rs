use crate::error::PosError;
use crate::models::{LedgerDelta, OutboxRow, Product, SaleTransaction};

/// Universal PosDb trait unifying local terminal SQLite and Turso Cloud sync.
/// Implements AGENTS.md §1 Decision 4 & §6.1.
pub trait PosDb: Send + Sync {
    /// Retrieve product by ID
    fn get_product(&self, id: &str) -> Result<Option<Product>, PosError>;

    /// Retrieve all active catalog products
    fn get_all_products(&self) -> Result<Vec<Product>, PosError>;

    /// Atomic product upsert + ledger adjust recording
    fn upsert_product(&self, product: &Product) -> Result<(), PosError>;

    /// Process atomic sale: record sale, deduct ledger deltas, enqueue outbox
    fn record_sale(
        &self,
        sale: &SaleTransaction,
        deltas: &[LedgerDelta],
    ) -> Result<(), PosError>;

    /// Read pending mutations from the sync outbox
    fn get_pending_outbox(&self, limit: usize) -> Result<Vec<OutboxRow>, PosError>;

    /// Mark an outbox mutation as synced or inflight
    fn mark_outbox_status(
        &self,
        idempotency_key: &str,
        status: &str,
    ) -> Result<(), PosError>;
}
