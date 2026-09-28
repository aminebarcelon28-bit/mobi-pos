use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvariantReport {
    pub is_balanced: bool,
    pub calculated_subtotal: f64,
    pub calculated_grand_total: f64,
    pub reported_grand_total: f64,
    pub delta: f64,
    pub faulty_row_indices: Vec<usize>,
}

pub fn evaluate_invoice_invariants(
    lines: &[(f64, f64, f64)], // (quantity, unit_cost, line_total)
    reported_tax: f64,
    reported_freight: f64,
    reported_grand_total: f64,
) -> InvariantReport {
    let mut calculated_subtotal: f64 = 0.0;
    let mut faulty_row_indices: Vec<usize> = Vec::new();

    for (index, &(qty, cost, total)) in lines.iter().enumerate() {
        let expected_line = (qty * cost * 100.0).round() / 100.0;
        let actual_line = (total * 100.0).round() / 100.0;

        // Verify individual row multiplication
        if (expected_line - actual_line).abs() > 0.01 {
            faulty_row_indices.push(index);
        }
        calculated_subtotal += actual_line;
    }

    let calculated_grand_total =
        ((calculated_subtotal + reported_tax + reported_freight) * 100.0).round() / 100.0;
    let reported_grand_total = (reported_grand_total * 100.0).round() / 100.0;
    let delta = ((calculated_grand_total - reported_grand_total) * 100.0).round() / 100.0;

    let is_balanced = delta.abs() <= 0.01 && faulty_row_indices.is_empty();

    InvariantReport {
        is_balanced,
        calculated_subtotal,
        calculated_grand_total,
        reported_grand_total,
        delta,
        faulty_row_indices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_balanced_invoice() {
        let lines = vec![(2.0, 10.00, 20.00), (1.0, 5.50, 5.50)];
        let r = evaluate_invoice_invariants(&lines, 2.55, 0.0, 28.05);
        assert!(r.is_balanced);
        assert!((r.delta).abs() <= 0.01);
        assert!(r.faulty_row_indices.is_empty());
    }

    #[test]
    fn test_faulty_row_and_delta() {
        let lines = vec![(2.0, 10.00, 21.00)];
        let r = evaluate_invoice_invariants(&lines, 0.0, 0.0, 20.00);
        assert!(!r.is_balanced);
        assert_eq!(r.faulty_row_indices, vec![0]);
        assert!((r.delta - 1.0).abs() <= 0.01);
    }
}
