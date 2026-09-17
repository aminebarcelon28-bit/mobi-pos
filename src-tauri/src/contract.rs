// Canonical Domain Contract & Event Definitions
// Implements Authority ③ §4.2, Authority ② §5.2, and AGENTS.md §1/§7.
//
// Single source of truth for domain events, envelopes, and IPC notifications.
// All events are append-only, replayable, and serialized with serde tag="type".

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct CheckoutLine {
    pub product_id: String,
    pub qty: i64,
    pub unit_cents: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PaymentInfo {
    pub method: String,
    pub tendered_cents: i64,
    pub change_cents: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum DomainEvent {
    ProductCreated {
        id: String,
        name: String,
        price_cents: i64,
        sku: Option<String>,
    },
    ProductRenamed {
        id: String,
        new_name: String,
    },
    PriceChanged {
        id: String,
        old_cents: i64,
        new_cents: i64,
    },
    StockSold {
        product_id: String,
        qty: i64,
        transaction_id: String,
    },
    StockReceived {
        product_id: String,
        qty: i64,
        supplier: Option<String>,
    },
    StockAdjusted {
        product_id: String,
        delta: i64,
        reason: String,
    },
    ProductDeleted {
        id: String,
    },
    CheckoutCompleted {
        transaction_id: String,
        lines: Vec<CheckoutLine>,
        total_cents: i64,
        payment: PaymentInfo,
    },
    DevicePaired {
        device_id: String,
        label: String,
        platform: String,
    },
    DeviceRevoked {
        device_id: String,
    },
}

/// The universal synchronization envelope.
/// This is the ONLY thing that ever synchronizes across devices and cloud.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub event_id: String,   // ULID — globally unique and lexicographically time-sortable
    pub aggregate: String,  // routing key for projections (e.g. "product:123", "tx:456")
    pub hlc: String,        // hybrid logical clock text ("{:016x}:{:04x}:{}")
    pub device_id: String,  // authoring device ID
    pub schema_v: u16,      // event schema version
    pub event: DomainEvent, // domain event payload
}

/// Notification emitted when one or more projections change during an event commit.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Committed {
    pub tables: Vec<String>,
}

/// Sync engine status rendered in UI.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhase {
    Offline,
    Idle,
    Pushing,
    Pulling,
    Degraded,
    Attention,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_domain_event_serde_json() {
        let event = DomainEvent::ProductCreated {
            id: "prod-100".to_string(),
            name: "Écran OLED iPhone 15".to_string(),
            price_cents: 1500000, // 15,000.00 DZD in minor units
            sku: Some("SCR-IP15-OLED".to_string()),
        };

        let json = serde_json::to_string(&event).expect("Serialize event");
        assert!(json.contains(r#""type":"product_created""#));

        let deserialized: DomainEvent = serde_json::from_str(&json).expect("Deserialize event");
        assert_eq!(event, deserialized);
    }

    #[test]
    fn test_envelope_serde_roundtrip() {
        let envelope = Envelope {
            event_id: "01J7Z800000000000000000000".to_string(),
            aggregate: "product:prod-100".to_string(),
            hlc: "00000191fa4f9a00:0000:desktop-1".to_string(),
            device_id: "desktop-1".to_string(),
            schema_v: 1,
            event: DomainEvent::StockAdjusted {
                product_id: "prod-100".to_string(),
                delta: 5,
                reason: "Livraison fournisseur".to_string(),
            },
        };

        let json = serde_json::to_string(&envelope).expect("Serialize envelope");
        let parsed: Envelope = serde_json::from_str(&json).expect("Deserialize envelope");
        assert_eq!(envelope, parsed);
    }
}

