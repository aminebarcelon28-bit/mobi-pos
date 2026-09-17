// Domain Reducers — Rust Mirror & Headless Verification
// Implements Authority ③ §5.3 and AGENTS.md Contract C6.

use crate::contract::{DomainEvent, Envelope};
use std::collections::HashMap;

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct ProjectedProduct {
    pub id: String,
    pub name: String,
    pub price_cents: i64,
    pub stock: i64,
    pub deleted: bool,
    pub row_hlc: String,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct ProjectedTransaction {
    pub id: String,
    pub total_cents: i64,
    pub row_hlc: String,
    pub device_id: String,
}

#[derive(Default, Debug, Clone)]
pub struct InMemoryProjections {
    pub products: HashMap<String, ProjectedProduct>,
    pub transactions: HashMap<String, ProjectedTransaction>,
    pub last_hlc: String,
}

impl InMemoryProjections {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reduce(&mut self, envelope: &Envelope) {
        match &envelope.event {
            DomainEvent::ProductCreated {
                id,
                name,
                price_cents,
                ..
            } => {
                if let Some(existing) = self.products.get_mut(id) {
                    if envelope.hlc > existing.row_hlc {
                        existing.name = name.clone();
                        existing.price_cents = *price_cents;
                        existing.row_hlc = envelope.hlc.clone();
                    }
                } else {
                    self.products.insert(
                        id.clone(),
                        ProjectedProduct {
                            id: id.clone(),
                            name: name.clone(),
                            price_cents: *price_cents,
                            stock: 0,
                            deleted: false,
                            row_hlc: envelope.hlc.clone(),
                        },
                    );
                }
            }

            DomainEvent::ProductRenamed { id, new_name } => {
                if let Some(p) = self.products.get_mut(id) {
                    if !p.deleted && envelope.hlc > p.row_hlc {
                        p.name = new_name.clone();
                        p.row_hlc = envelope.hlc.clone();
                    }
                }
            }

            DomainEvent::PriceChanged { id, new_cents, .. } => {
                if let Some(p) = self.products.get_mut(id) {
                    if !p.deleted && envelope.hlc > p.row_hlc {
                        p.price_cents = *new_cents;
                        p.row_hlc = envelope.hlc.clone();
                    }
                }
            }

            DomainEvent::StockSold { product_id, qty, .. } => {
                if let Some(p) = self.products.get_mut(product_id) {
                    if !p.deleted {
                        p.stock -= *qty;
                        p.row_hlc = envelope.hlc.clone();
                    }
                }
            }

            DomainEvent::StockReceived { product_id, qty, .. } => {
                if let Some(p) = self.products.get_mut(product_id) {
                    if !p.deleted {
                        p.stock += *qty;
                        p.row_hlc = envelope.hlc.clone();
                    }
                }
            }

            DomainEvent::StockAdjusted {
                product_id, delta, ..
            } => {
                if let Some(p) = self.products.get_mut(product_id) {
                    if !p.deleted {
                        p.stock += *delta;
                        p.row_hlc = envelope.hlc.clone();
                    }
                }
            }

            DomainEvent::ProductDeleted { id } => {
                if let Some(p) = self.products.get_mut(id) {
                    if envelope.hlc > p.row_hlc {
                        p.deleted = true;
                        p.row_hlc = envelope.hlc.clone();
                    }
                }
            }

            DomainEvent::CheckoutCompleted {
                transaction_id,
                total_cents,
                ..
            } => {
                self.transactions.insert(
                    transaction_id.clone(),
                    ProjectedTransaction {
                        id: transaction_id.clone(),
                        total_cents: *total_cents,
                        row_hlc: envelope.hlc.clone(),
                        device_id: envelope.device_id.clone(),
                    },
                );
            }

            DomainEvent::DevicePaired { .. } | DomainEvent::DeviceRevoked { .. } => {}
        }

        if envelope.hlc >= self.last_hlc {
            self.last_hlc = envelope.hlc.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{CheckoutLine, PaymentInfo};

    #[test]
    fn test_reducer_lifecycle_and_accumulate_stock() {
        let mut projections = InMemoryProjections::new();

        // 1. Create product
        let e1 = Envelope {
            event_id: "01J7Z000000000000000000001".to_string(),
            aggregate: "product:p1".to_string(),
            hlc: "00000191fa000000:0000:dev1".to_string(),
            device_id: "dev1".to_string(),
            schema_v: 1,
            event: DomainEvent::ProductCreated {
                id: "p1".to_string(),
                name: "Coque Silicone iPhone 14".to_string(),
                price_cents: 120000,
                sku: Some("COQ-IP14".to_string()),
            },
        };
        projections.reduce(&e1);
        let p = projections.products.get("p1").expect("Product must exist");
        assert_eq!(p.name, "Coque Silicone iPhone 14");
        assert_eq!(p.price_cents, 120000);
        assert_eq!(p.stock, 0);

        // 2. Receive stock (+10)
        let e2 = Envelope {
            event_id: "01J7Z000000000000000000002".to_string(),
            aggregate: "product:p1".to_string(),
            hlc: "00000191fa000000:0001:dev1".to_string(),
            device_id: "dev1".to_string(),
            schema_v: 1,
            event: DomainEvent::StockReceived {
                product_id: "p1".to_string(),
                qty: 10,
                supplier: Some("Grossiste Tech".to_string()),
            },
        };
        projections.reduce(&e2);
        assert_eq!(projections.products.get("p1").unwrap().stock, 10);

        // 3. Sell stock (-3) via StockSold
        let e3 = Envelope {
            event_id: "01J7Z000000000000000000003".to_string(),
            aggregate: "product:p1".to_string(),
            hlc: "00000191fa000000:0002:dev1".to_string(),
            device_id: "dev1".to_string(),
            schema_v: 1,
            event: DomainEvent::StockSold {
                product_id: "p1".to_string(),
                qty: 3,
                transaction_id: "tx-100".to_string(),
            },
        };
        projections.reduce(&e3);
        assert_eq!(projections.products.get("p1").unwrap().stock, 7);

        // 4. Checkout completed
        let e4 = Envelope {
            event_id: "01J7Z000000000000000000004".to_string(),
            aggregate: "tx:tx-100".to_string(),
            hlc: "00000191fa000000:0003:dev1".to_string(),
            device_id: "dev1".to_string(),
            schema_v: 1,
            event: DomainEvent::CheckoutCompleted {
                transaction_id: "tx-100".to_string(),
                lines: vec![CheckoutLine {
                    product_id: "p1".to_string(),
                    qty: 3,
                    unit_cents: 120000,
                }],
                total_cents: 360000,
                payment: PaymentInfo {
                    method: "cash".to_string(),
                    tendered_cents: 400000,
                    change_cents: 40000,
                },
            },
        };
        projections.reduce(&e4);
        let tx = projections.transactions.get("tx-100").expect("Tx must exist");
        assert_eq!(tx.total_cents, 360000);

        // 5. Stale rename with earlier HLC is ignored
        let stale_rename = Envelope {
            event_id: "01J7Z000000000000000000000".to_string(),
            aggregate: "product:p1".to_string(),
            hlc: "00000191f0000000:0000:dev1".to_string(),
            device_id: "dev1".to_string(),
            schema_v: 1,
            event: DomainEvent::ProductRenamed {
                id: "p1".to_string(),
                new_name: "Stale Name".to_string(),
            },
        };
        projections.reduce(&stale_rename);
        assert_eq!(
            projections.products.get("p1").unwrap().name,
            "Coque Silicone iPhone 14",
            "Stale HLC rename must not overwrite newer state"
        );
    }
}

