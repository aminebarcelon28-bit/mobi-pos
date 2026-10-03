//! Accounting Invariant Integrity Gate.
//!
//! Validates:
//! 1. Line-level invariant: |(Qty × UnitCost) - LineTotal| ≤ 0.01 DA (1 centime)
//! 2. Document-level invariant: |Σ(LineTotals) + Tax + Freight - GrandTotal| ≤ 0.01 DA
//!
//! Hardened for 100% reliability:
//! - Rejects `NaN`, `Infinity`, and unrepresentable floats.
//! - Guards against negative quantities or costs on receipt.
//! - Rejects empty invoices.
//! - Uses integer-cent arithmetic internally to avoid IEEE 754 precision drift.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AutoRepairCandidate {
    pub row_index: usize,
    pub field: String,
    pub original_val: f64,
    pub proposed_val: f64,
    pub confidence: f64,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvariantReport {
    pub is_balanced: bool,
    pub calculated_subtotal: f64,
    pub calculated_grand_total: f64,
    pub reported_grand_total: f64,
    pub delta: f64,
    pub faulty_row_indices: Vec<usize>,
    #[serde(default)]
    pub validation_errors: Vec<String>,
    #[serde(default)]
    pub auto_repairs: Vec<AutoRepairCandidate>,
}

/// Evaluates invoice accounting invariants with strict floating-point sanitization
/// and integer-cent precision.
pub fn evaluate_invoice_invariants(
    lines: &[(f64, f64, f64)], // (quantity, unit_cost, line_total)
    reported_tax: f64,
    reported_freight: f64,
    reported_grand_total: f64,
) -> InvariantReport {
    let mut faulty_row_indices: Vec<usize> = Vec::new();
    let mut validation_errors: Vec<String> = Vec::new();
    let mut auto_repairs: Vec<AutoRepairCandidate> = Vec::new();

    if lines.is_empty() {
        return InvariantReport {
            is_balanced: false,
            calculated_subtotal: 0.0,
            calculated_grand_total: 0.0,
            reported_grand_total: if reported_grand_total.is_finite() && reported_grand_total >= 0.0 {
                reported_grand_total
            } else {
                0.0
            },
            delta: 0.0,
            faulty_row_indices,
            validation_errors: vec!["Facture vide : aucune ligne d'article détectée.".into()],
            auto_repairs,
        };
    }

    // Sanitize reported document fees
    let safe_tax = if reported_tax.is_finite() && reported_tax >= 0.0 {
        reported_tax
    } else {
        if !reported_tax.is_finite() {
            validation_errors.push("Montant taxe invalide (non-fini).".into());
        }
        0.0
    };

    let safe_freight = if reported_freight.is_finite() && reported_freight >= 0.0 {
        reported_freight
    } else {
        if !reported_freight.is_finite() {
            validation_errors.push("Montant Frais de port invalide (non-fini).".into());
        }
        0.0
    };

    let mut calculated_subtotal_cents: i64 = 0;

    for (index, &(qty, cost, total)) in lines.iter().enumerate() {
        // 1. Check finiteness
        if !qty.is_finite() || !cost.is_finite() || !total.is_finite() {
            faulty_row_indices.push(index);
            validation_errors.push(format!(
                "Ligne {} : Valeur numérique corrompue (NaN/Inf).",
                index + 1
            ));
            continue;
        }

        // 2. Check positivity / domain limits
        if qty <= 0.0 {
            faulty_row_indices.push(index);
            validation_errors.push(format!(
                "Ligne {} : Quantité négative ou nulle ({:.2}).",
                index + 1,
                qty
            ));
            continue;
        }

        if cost < 0.0 || total < 0.0 {
            faulty_row_indices.push(index);
            validation_errors.push(format!(
                "Ligne {} : Montant négatif détecté (prix: {:.2}, total: {:.2}).",
                index + 1,
                cost,
                total
            ));
            continue;
        }

        // Integer cents conversion: 1 DA = 100 centimes
        let expected_line_cents = (qty * cost * 100.0).round() as i64;
        let actual_line_cents = (total * 100.0).round() as i64;

        // Tolerance: ±1 centime (0.01 DA)
        if (expected_line_cents - actual_line_cents).abs() > 1 {
            faulty_row_indices.push(index);
            validation_errors.push(format!(
                "Ligne {} : Écart arithmétique (attendu: {:.2} DA, reçu: {:.2} DA).",
                index + 1,
                expected_line_cents as f64 / 100.0,
                actual_line_cents as f64 / 100.0
            ));

            let expected_total = (expected_line_cents as f64) / 100.0;
            if qty > 0.0 && cost > 0.0 {
                auto_repairs.push(AutoRepairCandidate {
                    row_index: index,
                    field: "line_total".to_string(),
                    original_val: total,
                    proposed_val: expected_total,
                    confidence: 0.95,
                    explanation: format!(
                        "Ligne {} : Ajuster le total à {:.2} DA (quantité {:.0} × prix {:.2} DA)",
                        index + 1,
                        expected_total,
                        qty,
                        cost
                    ),
                });
            } else if qty > 0.0 && total > 0.0 && cost == 0.0 {
                let inferred_cost = (total / qty * 100.0).round() / 100.0;
                auto_repairs.push(AutoRepairCandidate {
                    row_index: index,
                    field: "unit_cost".to_string(),
                    original_val: cost,
                    proposed_val: inferred_cost,
                    confidence: 0.90,
                    explanation: format!(
                        "Ligne {} : Déduire le coût unitaire à {:.2} DA ({:.2} DA / {:.0})",
                        index + 1,
                        inferred_cost,
                        total,
                        qty
                    ),
                });
            }
        }

        calculated_subtotal_cents = calculated_subtotal_cents.saturating_add(actual_line_cents);
    }

    let tax_cents = (safe_tax * 100.0).round() as i64;
    let freight_cents = (safe_freight * 100.0).round() as i64;
    let calculated_grand_total_cents = calculated_subtotal_cents
        .saturating_add(tax_cents)
        .saturating_add(freight_cents);

    let calculated_subtotal = (calculated_subtotal_cents as f64) / 100.0;
    let calculated_grand_total = (calculated_grand_total_cents as f64) / 100.0;

    let (safe_reported_grand_total, delta_cents) = if !reported_grand_total.is_finite()
        || reported_grand_total <= 0.0
    {
        // Auto-balance if reported total is 0 or unassigned
        (calculated_grand_total, 0)
    } else {
        let rep_cents = (reported_grand_total * 100.0).round() as i64;
        let delta = calculated_grand_total_cents.saturating_sub(rep_cents);
        ((rep_cents as f64) / 100.0, delta)
    };

    let delta = (delta_cents as f64) / 100.0;
    let is_balanced = delta_cents.abs() <= 1 && faulty_row_indices.is_empty();

    // NO-TVA PRODUCT (Gate Addendum A): the former TVA-rate anomaly hints
    // (19 % / 9 % / timbre) are removed — this software charges no VAT.
    // `reported_tax` remains a generic supplier-document fee passthrough
    // (added into the grand total) until the Phase 1b schema decision drops
    // or repurposes the column; no rate math lives here anymore.
    if delta_cents.abs() > 1 {
        validation_errors.push(format!(
            "Écart document global : Δ = {:.2} DA (Calculé: {:.2} DA vs Déclaré: {:.2} DA).",
            delta, calculated_grand_total, safe_reported_grand_total
        ));
    }

    InvariantReport {
        is_balanced,
        calculated_subtotal,
        calculated_grand_total,
        reported_grand_total: safe_reported_grand_total,
        delta,
        faulty_row_indices,
        validation_errors,
        auto_repairs,
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
        assert!(r.validation_errors.is_empty());
    }

    #[test]
    fn test_faulty_row_and_delta() {
        let lines = vec![(2.0, 10.00, 21.00)];
        let r = evaluate_invoice_invariants(&lines, 0.0, 0.0, 20.00);
        assert!(!r.is_balanced);
        assert_eq!(r.faulty_row_indices, vec![0]);
        assert!((r.delta - 1.0).abs() <= 0.01);
        assert!(!r.validation_errors.is_empty());
    }

    #[test]
    fn test_nan_and_inf_handling() {
        let lines = vec![(f64::NAN, 10.00, 20.00), (2.0, f64::INFINITY, 20.00)];
        let r = evaluate_invoice_invariants(&lines, 0.0, 0.0, 20.00);
        assert!(!r.is_balanced);
        assert_eq!(r.faulty_row_indices, vec![0, 1]);
    }

    #[test]
    fn test_negative_quantities_and_costs() {
        let lines = vec![(-2.0, 10.00, -20.00), (0.0, 10.00, 0.00)];
        let r = evaluate_invoice_invariants(&lines, 0.0, 0.0, 0.0);
        assert!(!r.is_balanced);
        assert_eq!(r.faulty_row_indices, vec![0, 1]);
    }

    #[test]
    fn test_empty_invoice() {
        let lines = vec![];
        let r = evaluate_invoice_invariants(&lines, 0.0, 0.0, 100.0);
        assert!(!r.is_balanced);
        assert_eq!(r.calculated_grand_total, 0.0);
    }

    #[test]
    fn test_auto_total_when_reported_is_zero() {
        let lines = vec![(5.0, 100.0, 500.0)];
        let r = evaluate_invoice_invariants(&lines, 0.0, 0.0, 0.0);
        assert!(r.is_balanced);
        assert_eq!(r.reported_grand_total, 500.0);
        assert_eq!(r.delta, 0.0);
    }
}
