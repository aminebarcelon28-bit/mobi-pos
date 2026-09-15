use crate::models::CartItem;

/// Calculates line item net total: (price * quantity) - discount
pub fn calculate_line_item_total(item: &CartItem) -> i64 {
    let gross = item.applied_price.saturating_mul(item.quantity);
    gross.saturating_sub(item.discount).max(0)
}

/// Calculates entire cart totals: (subtotal, total_discount, net_total)
pub fn calculate_cart_totals(items: &[CartItem]) -> (i64, i64, i64) {
    let mut subtotal: i64 = 0;
    let mut total_discount: i64 = 0;

    for item in items {
        let line_gross = item.applied_price.saturating_mul(item.quantity);
        subtotal = subtotal.saturating_add(line_gross);
        total_discount = total_discount.saturating_add(item.discount);
    }

    let net_total = subtotal.saturating_sub(total_discount).max(0);
    (subtotal, total_discount, net_total)
}

/// Computes expected profit: net_total - total_cost
pub fn calculate_gross_profit(items: &[CartItem]) -> i64 {
    let (_, _, net_total) = calculate_cart_totals(items);
    let total_cost: i64 = items
        .iter()
        .map(|it| it.cost_price.saturating_mul(it.quantity))
        .sum();
    net_total.saturating_sub(total_cost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cart_totals_and_profit() {
        let items = vec![
            CartItem {
                product_id: "prod-1".into(),
                quantity: 2,
                applied_price: 2500, // 2 * 2500 = 5000
                discount: 500,       // net = 4500
                cost_price: 1500,    // cost = 3000
                imei: None,
            },
            CartItem {
                product_id: "prod-2".into(),
                quantity: 1,
                applied_price: 1200,
                discount: 0,
                cost_price: 800,
                imei: None,
            },
        ];

        let (subtotal, discount, net) = calculate_cart_totals(&items);
        assert_eq!(subtotal, 6200);
        assert_eq!(discount, 500);
        assert_eq!(net, 5700);

        let profit = calculate_gross_profit(&items);
        assert_eq!(profit, 5700 - (3000 + 800)); // 1900
    }
}
