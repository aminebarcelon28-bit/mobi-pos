use thiserror::Error;

#[derive(Error, Debug, PartialEq, Eq)]
pub enum PosError {
    #[error("Validation failed: {0}")]
    Validation(String),

    #[error("Inventory depleted for product {0}")]
    StockDepleted(String),

    #[error("Duplicate idempotency key {0}")]
    DuplicateMutation(String),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Sync failure: {0}")]
    Sync(String),
}
