use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Product {
    pub id: String,
    pub sku: String,
    pub barcode: String,
    pub title: String,
    pub brand: String,
    pub category: String,
    pub price: i64,          // Integer DZD / minor units (zero floats)
    pub wholesale_price: i64,
    pub cost_price: i64,
    pub stock: i64,
    pub is_serialized: bool,
    pub reorder_point: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CartItem {
    pub product_id: String,
    pub quantity: i64,
    pub applied_price: i64,
    pub discount: i64,
    pub cost_price: i64,
    pub imei: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SaleTransaction {
    pub id: String,
    pub receipt_number: String,
    pub total: i64,
    pub subtotal: i64,
    pub discount_total: i64,
    pub items: Vec<CartItem>,
    pub idempotency_key: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerDelta {
    pub id: String,
    pub product_id: String,
    pub delta: i64,
    pub reason: String,
    pub ref_type: String,
    pub ref_id: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutboxRow {
    pub idempotency_key: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    pub payload_json: String,
    pub status: String,
    pub retry_count: u32,
}
