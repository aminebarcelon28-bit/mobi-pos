use pos_core::SaleTransaction;

pub const ESC_INIT: &[u8] = &[0x1B, 0x40];
pub const DRAWER_KICK_PULSE: &[u8] = &[0x1B, 0x70, 0x00, 0x19, 0xFA];
pub const PAPER_PARTIAL_CUT: &[u8] = &[0x1D, 0x56, 0x42, 0x00];
pub const ALIGN_CENTER: &[u8] = &[0x1B, 0x61, 0x01];
pub const ALIGN_LEFT: &[u8] = &[0x1B, 0x61, 0x00];
pub const BOLD_ON: &[u8] = &[0x1B, 0x45, 0x01];
pub const BOLD_OFF: &[u8] = &[0x1B, 0x45, 0x00];

/// Encodes a sale receipt into standard ESC/POS thermal printer bytes
pub fn build_escpos_receipt(sale: &SaleTransaction, store_name: &str) -> Vec<u8> {
    let mut stream = Vec::with_capacity(512);

    // Initialize printer
    stream.extend_from_slice(ESC_INIT);

    // Center header
    stream.extend_from_slice(ALIGN_CENTER);
    stream.extend_from_slice(BOLD_ON);
    stream.extend_from_slice(store_name.as_bytes());
    stream.extend_from_slice(b"\n");
    stream.extend_from_slice(BOLD_OFF);

    stream.extend_from_slice(format!("Ticket #{}\n", sale.receipt_number).as_bytes());
    stream.extend_from_slice(format!("Date: {}\n\n", sale.timestamp).as_bytes());

    // Left body
    stream.extend_from_slice(ALIGN_LEFT);
    stream.extend_from_slice(b"--------------------------------\n");
    for item in &sale.items {
        stream.extend_from_slice(
            format!(
                "Item: {} x{} = {} DA\n",
                item.product_id, item.quantity, item.applied_price * item.quantity
            )
            .as_bytes(),
        );
    }
    stream.extend_from_slice(b"--------------------------------\n");

    // Total
    stream.extend_from_slice(BOLD_ON);
    stream.extend_from_slice(format!("TOTAL: {} DA\n\n", sale.total).as_bytes());
    stream.extend_from_slice(BOLD_OFF);

    // Feed lines (5 lines for 30mm physical cutter clearance) & cut
    stream.extend_from_slice(b"\n\n\n\n\n");
    stream.extend_from_slice(PAPER_PARTIAL_CUT);

    stream
}

/// Generates drawer kick command
pub fn build_cash_drawer_pulse() -> Vec<u8> {
    DRAWER_KICK_PULSE.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pos_core::CartItem;

    #[test]
    fn test_escpos_receipt_formatting() {
        let sale = SaleTransaction {
            id: "tx-test-1".into(),
            receipt_number: "2026-0001".into(),
            subtotal: 3500,
            discount_total: 0,
            total: 3500,
            items: vec![CartItem {
                product_id: "prod-apple".into(),
                quantity: 1,
                applied_price: 3500,
                discount: 0,
                cost_price: 2000,
                imei: None,
            }],
            idempotency_key: "key-1".into(),
            timestamp: "2026-09-14 10:00:00".into(),
        };

        let bytes = build_escpos_receipt(&sale, "MobiPOS Store");
        assert!(bytes.starts_with(ESC_INIT));
        assert!(bytes.ends_with(PAPER_PARTIAL_CUT));
    }
}
