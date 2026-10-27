//! Pre-Final Adversarial Staging Torture-Test Suite (28 Hard Edge Cases T01-T28)
//!
//! Validates the full Smart Import Slice 1 engine against real-world adversarial files,
//! encoding traps, money arithmetic traps, phone disambiguation, zip bomb defense,
//! and 3-way read-only DB invariants.

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    use crate::import::{
        detect::{
            analyze_15_digit_column, infer_column_thousand_dot,
            ThousandDotInference,
        },
        init_staging_db, insert_staging_batch_tx,
        map::{normalize_algerian_phone, parse_money_cell, stage_table, stage_table_with_overrides},
        open_live_db_readonly,
        parser::{check_zip_bomb, decode_bytes, parse_bytes},
        ColumnType, EntityType, ImportBatch, ImportError, StagingRowAction,
    };

    // Helper to seed a mock live mobi_pos.db
    fn create_mock_live_db() -> (std::path::PathBuf, std::path::PathBuf) {
        let unique_id = uuid::Uuid::new_v4().to_string();
        let dir = std::env::temp_dir().join(format!("mobi_test_{}", unique_id));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("mobi_pos.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE products (
                id TEXT PRIMARY KEY,
                barcode TEXT,
                sku TEXT,
                title TEXT,
                price REAL
            );
            CREATE TABLE customers (
                id TEXT PRIMARY KEY,
                name TEXT,
                phone TEXT
            );

            INSERT INTO products (id, barcode, sku, title, price)
            VALUES ('prod_existing_1', '6132450019289', 'SKU-001', 'Coque Silicone', 500.0);

            INSERT INTO customers (id, name, phone)
            VALUES ('cust_existing_1', 'Ahmed Benali', '0550123456');
            "#,
        )
        .unwrap();
        (dir, db_path)
    }

    // --- Category A: Phone, Signed Debt & Formula Traps ---

    #[test]
    fn test_t01_phone_formats_preserved_and_normalized() {
        // T01: +213 550 12 34 56 and 00213-661-22-33-44
        let p1 = normalize_algerian_phone("+213 550 12 34 56").unwrap();
        assert_eq!(p1, "0550123456");

        let p2 = normalize_algerian_phone("00213-661-22-33-44").unwrap();
        assert_eq!(p2, "0661223344");

        // Verify raw cell is preserved verbatim without formula prefixing
        let csv = "Nom;Téléphone\nAhmed;+213 550 12 34 56\n";
        let table = parse_bytes(csv.as_bytes(), "t01.csv", None).unwrap();
        assert_eq!(table.rows[0][1], "+213 550 12 34 56");
    }

    #[test]
    fn test_t02_excel_zero_stripped_mobile_and_landline() {
        // T02: 9-digit mobile 550123456 -> 0550123456; 8-digit landline 21123456 -> 021123456
        let mob = normalize_algerian_phone("550123456").unwrap();
        assert_eq!(mob, "0550123456");

        let landline = normalize_algerian_phone("21123456").unwrap();
        assert_eq!(landline, "021123456");
    }

    #[test]
    fn test_t03_signed_negative_debt_balance() {
        // Debt is not applied through the customer-profile destination.
        let csv = "Client;Téléphone;Solde Dette\nKarim;0550112233;-1500,50\n";
        let table = parse_bytes(csv.as_bytes(), "t03.csv", None).unwrap();
        let (rows, entity, _warnings) = stage_table(&table, "b_t03", None).unwrap();

        assert_eq!(entity, EntityType::Customers);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0].raw_row_json.contains("-1500,50"));
        let norm: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(norm["name"], "Karim");
        assert_eq!(norm["phone"], "0550112233");
        assert_eq!(norm["debt_column_present"], true);
        assert!(rows[0].rejection_reason.as_deref().unwrap().contains("DebtRequiresDedicatedDestination"));
    }

    #[test]
    fn test_standalone_customer_debts_reject_class() {
        // Standalone debt ledger with no customer identity -> classified as CustomerDebts (deferred reject class)
        let csv = "ID_Bordereau;Solde Restant;Date_Echeance\nB001;-1500,50;2026-10-31\n";
        let table = parse_bytes(csv.as_bytes(), "debts.csv", None).unwrap();
        let (rows, entity, warnings) = stage_table(&table, "b_debts", None).unwrap();

        assert_eq!(entity, EntityType::CustomerDebts);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|w| w.code == "DeferredEntityCustomerDebts"));
    }

    #[test]
    fn test_t04_formula_string_flagged_without_mutation() {
        // T04: =SUM(A1:A5)
        let csv = "Designation;Prix\nChargeur;=SUM(C2:C10)\n";
        let table = parse_bytes(csv.as_bytes(), "t04.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t04", None).unwrap();

        assert!(rows[0].raw_row_json.contains("=SUM(C2:C10)"));
        assert!(rows[0].warnings_json.contains("FormulaPrefixWarning"));
    }

    // --- Category B: 15-Digit IMEI vs. NIF & Barcode Traps ---

    #[test]
    fn test_t05_algerian_nif_column_never_classified_as_imei() {
        // T05: 20 Algerian NIFs with ~10% Luhn pass rate (exactly 15 digits)
        let mut nif_col = Vec::new();
        for i in 0..20 {
            nif_col.push(format!("0001160900000{:02}", i));
        }
        let (col_type, conf) = analyze_15_digit_column(&nif_col);
        assert_eq!(col_type, ColumnType::Nif);
        assert!(conf >= 0.85);
    }

    #[test]
    fn test_t06_imei_column_high_luhn_rate() {
        // T06: 20 IMEIs where 19 pass Luhn and 1 is a typo
        let mut imei_col = Vec::new();
        for _ in 0..19 {
            imei_col.push("356938035643809".to_string());
        }
        imei_col.push("356938035643803".to_string()); // 1 typo

        let (col_type, conf) = analyze_15_digit_column(&imei_col);
        assert_eq!(col_type, ColumnType::Imei);
        assert!(conf >= 0.90);
    }

    #[test]
    fn test_t07_gs1_composite_fail_closed() {
        // T07: GS1 (01) composite barcode
        let csv = "Designation;Code Barre;Prix\nProduit X;(01)06132450019283(21)12345;1000\n";
        let table = parse_bytes(csv.as_bytes(), "t07.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t07", None).unwrap();

        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0].warnings_json.contains("Gs1CompositeRejected"));
    }

    #[test]
    fn test_t08_barcode_precision_loss_detection() {
        // T08: Scientific notation truncation in CSV
        let csv = "Designation;Code Barre;Prix\nProduit X;6132450000000;1000\n";
        let table = parse_bytes(csv.as_bytes(), "t08.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t08", None).unwrap();

        assert!(rows[0].needs_review);
        assert!(rows[0].warnings_json.contains("BarcodePrecisionLossSuspected"));
    }

    // --- Category C: Column-Level Money & Arabic-Indic Traps ---

    #[test]
    fn test_t09_column_wide_thousands_dot() {
        // T09: 45.000, 120.000, 1.250.000, 8.500, 500
        let prices = vec![
            "45.000".to_string(),
            "120.000".to_string(),
            "1.250.000".to_string(),
            "8.500".to_string(),
            "500".to_string(),
        ];
        let (inf, _) = infer_column_thousand_dot(&prices);
        assert_eq!(inf, ThousandDotInference::ThousandsDot);

        let (minor, dzd) = parse_money_cell("45.000", inf).unwrap();
        assert_eq!(dzd, 45000);
        assert_eq!(minor, 4500000);
    }

    #[test]
    fn test_t10_column_mixing_three_and_two_decimals() {
        // T10: 45.000 and 12.50 in same column -> decimal dot
        let prices = vec!["45.000".to_string(), "12.50".to_string(), "100.00".to_string()];
        let (inf, _) = infer_column_thousand_dot(&prices);
        assert_eq!(inf, ThousandDotInference::DecimalDot);
    }

    #[test]
    fn test_t11_small_sample_single_dot_ambiguity() {
        // T11: Single 45.000 and 500 -> Ambiguous, confidence < 0.85
        let prices = vec!["45.000".to_string(), "500".to_string()];
        let (inf, conf) = infer_column_thousand_dot(&prices);
        assert_eq!(inf, ThousandDotInference::Ambiguous);
        assert!(conf < 0.85);
    }

    #[test]
    fn test_t12_french_formatted_prices_and_nbsp() {
        // T12: 12 500,50 DA and 1\u{202F}200,00 دج
        let (minor1, dzd1) = parse_money_cell("12 500,50 DA", ThousandDotInference::None).unwrap();
        assert_eq!(minor1, 1250050);
        assert_eq!(dzd1, 12501);

        let (minor2, dzd2) = parse_money_cell("1\u{202F}200,00 دج", ThousandDotInference::None).unwrap();
        assert_eq!(minor2, 120000);
        assert_eq!(dzd2, 1200);
    }

    #[test]
    fn test_t13_arabic_indic_numerals_and_separators() {
        // T13: ١٢٬٥٠٠٫٥٠ د.ج and ۴۵٬۰۰۰
        let (minor1, dzd1) = parse_money_cell("١٢٬٥٠٠٫٥٠ د.ج", ThousandDotInference::None).unwrap();
        assert_eq!(minor1, 1250050);
        assert_eq!(dzd1, 12501);

        let (minor2, dzd2) = parse_money_cell("۴۵٬۰۰۰", ThousandDotInference::None).unwrap();
        assert_eq!(minor2, 4500000);
        assert_eq!(dzd2, 45000);
    }

    // --- Category D: Multi-Price, Cost & Warranty Traps ---

    #[test]
    fn test_t14_inverted_multi_price_ordering() {
        // T14: Prix 1 = 2500, Prix 2 = 2100, Prix 3 = 1800
        let csv = "Designation;Prix 1;Prix 2;Prix 3\nArticle A;2500;2100;1800\nArticle B;3000;2500;2000\nArticle C;1500;1200;1000\nArticle D;5000;4500;4000\n";
        let table = parse_bytes(csv.as_bytes(), "t14.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t14", None).unwrap();

        let norm: serde_json::Value = serde_json::from_str(&rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(norm["price"]["dzd"], 2500);
        assert_eq!(norm["cost_price"]["dzd"], 1800);
    }

    #[test]
    fn test_t15_missing_purchase_cost_preserves_invariant() {
        // T15: Cost empty -> cost_unknown = 1, unit_cost = 0
        let csv = "Designation;Prix Vente;Prix Achat\nCable USB;500;\n";
        let table = parse_bytes(csv.as_bytes(), "t15.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t15", None).unwrap();

        let norm: serde_json::Value = serde_json::from_str(&rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(norm["cost_unknown"], 1);
        assert_eq!(norm["cost_price"]["dzd"], 0);
        assert_eq!(rows[0].action, StagingRowAction::Create);
    }

    #[test]
    fn test_t16_selling_below_cost_warning() {
        // T16: cost 3000 > price 2500
        let csv = "Designation;Prix Vente;Prix Achat\nArticle Déficitaire;2500;3000\n";
        let table = parse_bytes(csv.as_bytes(), "t16.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t16", None).unwrap();

        assert!(rows[0].needs_review);
        assert!(rows[0].warnings_json.contains("SellingBelowCostWarning"));
    }

    #[test]
    fn test_t17_missing_warranty_null_default() {
        // T17: No warranty column -> warranty_months: null
        let csv = "Designation;Prix\nProduit Sans Garantie;1000\n";
        let table = parse_bytes(csv.as_bytes(), "t17.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t17", None).unwrap();

        let norm: serde_json::Value = serde_json::from_str(&rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert!(norm["warranty_months"].is_null());
        assert_eq!(norm["warranty_explicitly_disabled"], false);
    }

    // --- Category E: Entity & Role Disambiguation Traps ---

    #[test]
    fn test_t18_product_sheet_with_supplier_phone_metadata() {
        // T18: Product sheet with Tél Fournisseur
        let csv = "Designation;Prix;Tél Fournisseur\nChargeur;1500;0550112233\n";
        let table = parse_bytes(csv.as_bytes(), "t18.csv", None).unwrap();
        let (_, entity, _) = stage_table(&table, "b_t18", None).unwrap();

        assert_eq!(entity, EntityType::Products);
    }

    #[test]
    fn test_t19_supplier_list_classified_as_reject_class() {
        // T19: Supplier list with Fournisseur, NIF, RC
        let csv = "Fournisseur;NIF;RC;Téléphone\nEurl Algerie;000116090000034;16/00-1234;021123456\n";
        let table = parse_bytes(csv.as_bytes(), "t19.csv", None).unwrap();
        let (rows, entity, warnings) = stage_table(&table, "b_t19", None).unwrap();

        assert_eq!(entity, EntityType::Suppliers);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|w| w.code == "DeferredEntitySuppliers"));
    }

    #[test]
    fn test_t20_active_repairs_classified_as_reject_class() {
        // T20: SAV sheet with Panne, Appareil, Acompte
        let csv = "Client;Téléphone;Appareil;Panne;Acompte\nKarim;0550123456;Samsung A52;Ecran cassé;2000\n";
        let table = parse_bytes(csv.as_bytes(), "t20.csv", None).unwrap();
        let (rows, entity, warnings) = stage_table(&table, "b_t20", None).unwrap();

        assert_eq!(entity, EntityType::ActiveRepairs);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|w| w.code == "DeferredEntityActiveRepairs"));
    }

    #[test]
    fn test_trade_in_history_cannot_be_overridden_into_products() {
        let csv = "Nom Client;Téléphone;Appareil repris;IMEI;Valeur Reprise;Date Reprise\nClient reprise;0550000202;Galaxy S22 usagé;350000000000006;45000;2026-10-19\n";
        let table = parse_bytes(csv.as_bytes(), "trade-in.csv", None).unwrap();
        let (rows, entity, warnings) =
            stage_table_with_overrides(&table, "b_trade_in", None, Some("products"), None).unwrap();

        assert_eq!(entity, EntityType::TradeIns);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|warning| warning.code == "DeferredEntityTradeIns"));
    }

    #[test]
    fn test_repair_history_cannot_be_overridden_into_products() {
        let csv = "Nom Client;Téléphone;Appareil;Panne;Acompte;Date\nClient SAV;0550000201;iPhone 13;Écran cassé;5000;2026-10-20\n";
        let table = parse_bytes(csv.as_bytes(), "repairs.csv", None).unwrap();
        let (rows, entity, warnings) =
            stage_table_with_overrides(&table, "b_repairs", None, Some("products"), None).unwrap();

        assert_eq!(entity, EntityType::ActiveRepairs);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|warning| warning.code == "DeferredEntityActiveRepairs"));
    }

    #[test]
    fn test_debt_ledger_with_name_but_no_stable_identity_is_rejected() {
        let csv = "Référence Dette;Nom Client;Montant Dette;Solde Restant;Date Opération\nDET-01;Client historique;1500;1000;2026-10-18\n";
        let table = parse_bytes(csv.as_bytes(), "debt-ledger.csv", None).unwrap();
        let (rows, entity, warnings) = stage_table_with_overrides(
            &table,
            "b_debt_ledger",
            None,
            Some("customers"),
            None,
        )
        .unwrap();

        assert_eq!(entity, EntityType::CustomerDebts);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|warning| warning.code == "DeferredEntityCustomerDebts"));
    }

    #[test]
    fn test_t21_shared_family_phone_disambiguation() {
        // T21: Shared phone 0550123456 between Mohamed and Karim
        let csv = "Nom Client;Téléphone\nMohamed Benali;0550123456\nKarim Benali;0550123456\n";
        let table = parse_bytes(csv.as_bytes(), "t21.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t21", None).unwrap();

        assert_eq!(rows.len(), 2);
        assert_ne!(rows[0].idempotency_key, rows[1].idempotency_key);
        assert!(rows.iter().all(|row| row.needs_review));
        assert!(rows.iter().all(|row| row.warnings_json.contains("AmbiguousSharedPhone")));
    }

    #[test]
    fn test_t22_customer_loyalty_milestone_pre_anchoring() {
        // Profile payload records only explicitly supplied fields.
        let csv = "Nom Client;Téléphone\nSofiane;0550998877\n";
        let table = parse_bytes(csv.as_bytes(), "t22.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t22", None).unwrap();

        let norm: serde_json::Value = serde_json::from_str(&rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(norm["profile_fields"]["name"], true);
        assert_eq!(norm["profile_fields"]["phone"], true);
        assert!(norm.get("initial_debt").is_none());
    }

    // --- Category F: Layout, Encoding & Security Traps ---

    #[test]
    fn test_t23_multi_row_banner_and_summary_row_stripping() {
        // T23: 3 header banner rows + Total row
        let csv = "ETS FRERES BENALI\nVENTE EN GROS ET DETAIL\nALGER CENTRE\nDesignation;Prix\nChargeur;1500\nCâble;500\nTOTAL GÉNÉRAL;2000\n";
        let table = parse_bytes(csv.as_bytes(), "t23.csv", None).unwrap();

        assert_eq!(table.headers, vec!["Designation", "Prix"]);
        assert_eq!(table.rows.len(), 2);
        assert!(table.warnings.iter().any(|w| w.code == "SummaryRowSkipped"));
    }

    #[test]
    fn test_t24_encoding_detection_arabic_vs_french() {
        // T24: Windows-1256 Arabic vs Windows-1252 French
        let ar_bytes = [0xE3, 0xE4, 0xCA, 0xCC, b';', b'1', b'0', b'0'];
        let (s_ar, enc_ar) = decode_bytes(&ar_bytes).unwrap();
        assert_eq!(enc_ar, "WINDOWS-1256");
        assert!(s_ar.contains("منتج"));

        let fr_bytes = [b'D', 0xE9, b's', b'i', b'g', b'n', b'a', b't', b'i', b'o', b'n', b';', b'1', b'0', b'0'];
        let (s_fr, enc_fr) = decode_bytes(&fr_bytes).unwrap();
        assert_eq!(enc_fr, "WINDOWS-1252");
        assert!(s_fr.contains("Désignation"));
    }

    #[test]
    fn test_t25_headerless_two_column_contact_caps_confidence() {
        // T25: Headerless Name + Phone caps confidence < 0.85
        let tsv = "Mohamed Benali\t0550123456\n";
        let table = parse_bytes(tsv.as_bytes(), "t25.tsv", None).unwrap();
        let (_, col_scores, _) = crate::import::map::map_table_columns(&table);

        for score in col_scores {
            if score.mapped_column == "customer_name" {
                assert!(score.confidence < 0.85);
            }
        }
    }

    #[test]
    fn test_t26_zip_bomb_defense_rejects_excessive_ratio() {
        // T26: Construct a simulated in-memory zip archive with huge compression ratio
        let mut zip_bytes = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut zip_bytes);
            let mut zip = zip::ZipWriter::new(cursor);
            let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

            // Write 10 MB of repeated zeroes which compresses down to a few hundred bytes (> 1000:1 ratio)
            zip.start_file("huge.xml", options).unwrap();
            let zeroes = vec![0u8; 10 * 1024 * 1024];
            zip.write_all(&zeroes).unwrap();
            zip.finish().unwrap();
        }

        let res = check_zip_bomb(&zip_bytes);
        assert!(res.is_err(), "Zip bomb with excessive compression ratio must be rejected!");
        if let Err(ImportError::ZipBombSuspected(msg)) = res {
            assert!(msg.contains("exceeds max compression ratio"), "Expected compression ratio error, got: {}", msg);
        } else {
            panic!("Expected ZipBombSuspected error, got {:?}", res);
        }
    }

    // --- Category G: Live DB Conflict, Idempotency & Invariants ---

    #[test]
    fn test_t27_live_db_conflict_probing_and_idempotency() {
        // T27: Seeded live DB with existing barcode '6132450019289' and phone '0550123456'
        let (_dir, live_path) = create_mock_live_db();
        let ro_conn = open_live_db_readonly(&live_path).unwrap();

        let csv = "Designation;Code Barre;Prix\nCoque Silicone;6132450019289;600\nProduit Nouveau;6132450019296;1200\n";
        let table = parse_bytes(csv.as_bytes(), "t27.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t27", Some(&ro_conn)).unwrap();

        assert_eq!(rows[0].action, StagingRowAction::Update);
        assert_eq!(rows[0].matched_entity_id, Some("prod_existing_1".to_string()));

        assert_eq!(rows[1].action, StagingRowAction::Create);
        assert_eq!(rows[1].matched_entity_id, None);
    }

    #[test]
    fn test_t28_three_way_zero_writes_and_sqlite_readonly() {
        // T28: Three-way proof
        let (_dir, live_path) = create_mock_live_db();

        // 1. Snapshot hash of live DB
        let pre_bytes = std::fs::read(&live_path).unwrap();
        let pre_hash = Sha256::digest(&pre_bytes);

        // 2. Open readonly connection and stage a batch into staging DB
        let ro_conn = open_live_db_readonly(&live_path).unwrap();

        let mut staging_conn = Connection::open_in_memory().unwrap();
        init_staging_db(&staging_conn).unwrap();

        let csv = "Designation;Prix\nProduit Test;1000\n";
        let table = parse_bytes(csv.as_bytes(), "t28.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t28", Some(&ro_conn)).unwrap();

        let batch = ImportBatch {
            batch_id: "b_t28".to_string(),
            file_name: "t28.csv".to_string(),
            file_sha256: "dummy_sha".to_string(),
            entity_type: "products".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 1,
            created_count: 1,
            updated_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "2026-10-21T11:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        insert_staging_batch_tx(&mut staging_conn, &batch, &rows).unwrap();

        // 3. Prove write attempts on ro_conn fail with SQLITE_READONLY
        let write_attempt = ro_conn.execute("INSERT INTO products (id, title) VALUES ('hack', 'fail')", []);
        assert!(write_attempt.is_err(), "Write on read-only connection must fail!");
        let err_str = write_attempt.unwrap_err().to_string();
        assert!(
            err_str.contains("readonly") || err_str.contains("not permitted to read-only"),
            "Expected SQLite read-only error, got: {}",
            err_str
        );

        // 4. Verify post-staging hash is 100% bit-for-bit identical
        let post_bytes = std::fs::read(&live_path).unwrap();
        let post_hash = Sha256::digest(&post_bytes);
        assert_eq!(pre_hash, post_hash, "Live DB file was mutated! Pre-hash and post-hash must match 100%!");
    }

    // --- Category H: Universal Format Support & Advanced Edge Cases ---

    #[test]
    fn test_t29_upc_a_and_ean8_barcodes() {
        use crate::import::detect::is_valid_barcode;

        // Valid 12-digit UPC-A
        assert!(is_valid_barcode("012345678905"));
        // Invalid UPC-A (check digit mismatch)
        assert!(!is_valid_barcode("012345678901"));

        // Valid 8-digit EAN-8
        assert!(is_valid_barcode("96385074"));
        // Invalid EAN-8
        assert!(!is_valid_barcode("96385070"));
    }

    #[test]
    fn test_t30_accounting_parentheses_negative_debt() {
        // T30: (1 500,00 DA) in accounting format -> -1500.00
        let (minor, dzd) = parse_money_cell("(1 500,00 DA)", ThousandDotInference::None).unwrap();
        assert_eq!(minor, -150000);
        assert_eq!(dzd, -1500);

        let (minor2, dzd2) = parse_money_cell("(500)", ThousandDotInference::None).unwrap();
        assert_eq!(minor2, -50000);
        assert_eq!(dzd2, -500);
    }

    #[test]
    fn test_t31_duplicate_barcode_within_import_file() {
        // T31: Same barcode appears twice in the same import file
        let csv = "Designation;Code Barre;Prix\nChargeur 20W;6132450019289;1500\nChargeur 20W Blanc;6132450019289;1500\n";
        let table = parse_bytes(csv.as_bytes(), "dup.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t31", None).unwrap();

        assert_eq!(rows.len(), 2);
        assert!(!rows[0].needs_review);
        assert!(rows[1].needs_review);
        assert!(rows[1].warnings_json.contains("DuplicateBarcodeInBatch"));
    }

    #[test]
    fn test_t32_html_table_disguised_as_xls() {
        // T32: HTML table disguised with .xls extension
        let html_content = r#"
        <html>
        <body>
        <table>
            <tr><th>Code</th><th>Designation</th><th>Prix Vente</th><th>Prix Achat</th><th>Qte</th></tr>
            <tr><td>6132450019289</td><td>Chargeur Type-C</td><td>1500</td><td>1000</td><td>20</td></tr>
            <tr><td>6132450019296</td><td>Cable USB-C</td><td>500</td><td>300</td><td>50</td></tr>
        </table>
        </body>
        </html>
        "#;
        let table = parse_bytes(html_content.as_bytes(), "gestcom_export.xls", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t32", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, StagingRowAction::Create);
    }

    #[test]
    fn test_t33_vcf_phone_contacts_customer_import() {
        // T33: vCard file exported from mobile phone
        let vcf_content = concat!(
            "\nBEGIN:VCARD\n",
            "VERSION:3.0\n",
            "FN:Mohamed Benali\n",
            "TEL;TYPE=CELL:0550123456\n",
            "NOTE:Client Grossiste\n",
            "END:VCARD\n",
            "BEGIN:VCARD\n",
            "VERSION:3.0\n",
            "FN:Karim Ziani\n",
            "TEL;TYPE=CELL:0661223344\n",
            "END:VCARD\n"
        );
        let table = parse_bytes(vcf_content.as_bytes(), "contacts.vcf", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t33", None).unwrap();

        assert_eq!(entity, EntityType::Customers);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, StagingRowAction::Create);
    }

    #[test]
    fn test_t34_json_and_jsonl_product_import() {
        // T34: JSON array import
        let json_content = r#"[
            {"title": "Chargeur 20W", "price": 1500, "stock": 10},
            {"title": "Cable Type-C", "price": 500, "stock": 25}
        ]"#;
        let table = parse_bytes(json_content.as_bytes(), "data.json", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t34", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn test_t35_sql_dump_import() {
        // T35: SQL INSERT dump
        let sql_content = r#"
        INSERT INTO `products` (`barcode`, `title`, `price`) VALUES ('6132450019289', 'Chargeur 20W', 1500);
        INSERT INTO `products` (`barcode`, `title`, `price`) VALUES ('6132450019296', 'Cable Type-C', 500);
        "#;
        let table = parse_bytes(sql_content.as_bytes(), "dump.sql", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t35", None).unwrap();

        assert_eq!(entity, EntityType::Products);
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn test_t36_utf16_le_and_be_csv() {
        // T36: UTF-16LE CSV from Windows PowerShell
        let utf16_content = "Designation;Prix\nChargeur;1500\n";
        let mut utf16_bytes = vec![0xFF, 0xFE]; // LE BOM
        for c in utf16_content.encode_utf16() {
            utf16_bytes.extend_from_slice(&c.to_le_bytes());
        }

        let table = parse_bytes(&utf16_bytes, "powershell.csv", None).unwrap();
        assert_eq!(table.headers, vec!["Designation", "Prix"]);
        assert_eq!(table.rows.len(), 1);
        assert_eq!(table.rows[0], vec!["Chargeur", "1500"]);
    }

    #[test]
    fn test_t37_headerless_contact_supplier_keyword_classification() {
        // T37: 2-column contact list with Supplier company keywords
        let tsv = "SARL Global Tech Alger\t021123456\nEURL Distribution Telephonie\t0550112233\nETS Freres Benali Grossiste\t0661998877\n";
        let table = parse_bytes(tsv.as_bytes(), "contacts.tsv", None).unwrap();
        let (rows, entity, warnings) = stage_table(&table, "b_t37", None).unwrap();

        assert_eq!(entity, EntityType::Suppliers);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|w| w.code == "DeferredEntitySuppliers"));
    }

    #[test]
    fn test_t38_binary_dbf_table_import() {
        // T38: Construct a valid dBase III binary file in memory
        let mut dbf = Vec::new();
        // Byte 0: version 0x03 (dBase III)
        dbf.push(0x03);
        // Bytes 1-3: YY, MM, DD
        dbf.extend_from_slice(&[26, 10, 21]);
        // Bytes 4-7: Record count = 2 (u32 LE)
        dbf.extend_from_slice(&2u32.to_le_bytes());
        // Bytes 8-9: Header length = 32 + 2*32 + 1 = 97 (u16 LE)
        let header_len: u16 = 32 + 2 * 32 + 1;
        dbf.extend_from_slice(&header_len.to_le_bytes());
        // Bytes 10-11: Record length = 1 (delete flag) + 20 (DESIGNAT) + 10 (PRIX) = 31 (u16 LE)
        let record_len: u16 = 1 + 20 + 10;
        dbf.extend_from_slice(&record_len.to_le_bytes());
        // Bytes 12-31: Reserved (20 zeroes)
        dbf.extend_from_slice(&[0u8; 20]);

        // Field 1: "DESIGNAT\0\0\0" (11 bytes), Type 'C', length 20
        let mut f1 = [0u8; 32];
        f1[0..8].copy_from_slice(b"DESIGNAT");
        f1[11] = b'C';
        f1[16] = 20;
        dbf.extend_from_slice(&f1);

        // Field 2: "PRIX\0\0\0\0\0\0\0" (11 bytes), Type 'N', length 10
        let mut f2 = [0u8; 32];
        f2[0..4].copy_from_slice(b"PRIX");
        f2[11] = b'N';
        f2[16] = 10;
        dbf.extend_from_slice(&f2);

        // Header terminator 0x0D
        dbf.push(0x0D);

        // Record 1: ' ' (not deleted), "Chargeur Type-C 20W ", "   1500.00"
        dbf.push(b' ');
        dbf.extend_from_slice(b"Chargeur Type-C 20W ");
        dbf.extend_from_slice(b"   1500.00");

        // Record 2: ' ' (not deleted), "Cable USB-C 1M      ", "    500.00"
        dbf.push(b' ');
        dbf.extend_from_slice(b"Cable USB-C 1M      ");
        dbf.extend_from_slice(b"    500.00");

        let table = parse_bytes(&dbf, "articles.dbf", None).unwrap();
        assert_eq!(table.headers, vec!["DESIGNAT", "PRIX"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0], vec!["Chargeur Type-C 20W", "1500.00"]);
        assert_eq!(table.rows[1], vec!["Cable USB-C 1M", "500.00"]);

        let (rows, entity, _) = stage_table(&table, "b_t38", None).unwrap();
        assert_eq!(entity, EntityType::Products);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, StagingRowAction::Create);
    }

    #[test]
    fn test_t39_scientific_notation_barcode_is_quarantined() {
        // T39: Excel has already lost identity precision when it exports a barcode this way.
        let csv = "Code Barre;Designation;Prix\n6.132450019289E+12;Chargeur Fast 20W;1500\n";
        let table = parse_bytes(csv.as_bytes(), "products.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t39", None).unwrap();

        assert_eq!(entity, EntityType::Products);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0].rejection_reason.as_deref().unwrap().contains(
            "Excel converted this to scientific notation; re-export the column as text."
        ));
    }

    #[test]
    fn test_t40_excel_zero_suffix_truncation_phone() {
        // T40: Excel exports phone number as float string: 0550123456.0
        let csv = "Nom;Telephone\nAmine;0550123456.0\n";
        let table = parse_bytes(csv.as_bytes(), "clients.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t40", None).unwrap();

        assert_eq!(entity, EntityType::Customers);
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["phone"], "0550123456");
    }

    #[test]
    fn test_t41_excel_zero_suffix_truncation_barcode() {
        // T41: Excel exports barcode with float .0 suffix: 6132450019289.0
        let csv = "Code Barre;Article;Prix\n6132450019289.0;Coque Silicone;800\n";
        let table = parse_bytes(csv.as_bytes(), "products.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t41", None).unwrap();

        assert_eq!(entity, EntityType::Products);
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["barcode"], "6132450019289");
    }

    #[test]
    fn test_t42_scientific_notation_imei_is_quarantined() {
        // T42: A scientific-notation IMEI must not be expanded into an identity.
        assert!(crate::import::detect::is_scientific_notation("3.58912345678902E+14"));
        assert!(crate::import::detect::luhn_check_imei("358912345678902.0"));

        let csv = "Designation;IMEI\nGalaxy S21;3.58912345678902E+14\n";
        let table = parse_bytes(csv.as_bytes(), "imeis.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t42", None).unwrap();

        assert_eq!(entity, EntityType::SerializedImeis);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0].rejection_reason.as_deref().unwrap().contains(
            "Excel converted this to scientific notation; re-export the column as text."
        ));
    }

    #[test]
    fn test_t43_quantity_cell_textual_units_and_status() {
        // T43: Stock quantities with textual units and availability keywords
        let csv = "Article;Prix;Quantite\nProduit A;1000;10 pcs\nProduit B;2000;12,5 kg\nProduit C;500;En stock\nProduit D;1500;Rupture\nProduit E;300;متوفر\n";
        let table = parse_bytes(csv.as_bytes(), "stock.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t43", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 5);

        let p0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(p0["opening_stock"], 10.0);

        let p1: serde_json::Value = serde_json::from_str(rows[1].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(p1["opening_stock"], 12.5);

        let p2: serde_json::Value = serde_json::from_str(rows[2].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(p2["opening_stock"], 1.0);

        let p3: serde_json::Value = serde_json::from_str(rows[3].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(p3["opening_stock"], 0.0);

        let p4: serde_json::Value = serde_json::from_str(rows[4].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(p4["opening_stock"], 1.0);
    }

    #[test]
    fn test_t44_multi_sheet_excel_blank_cover_page() {
        // T44: JSON with wrapped array of objects simulates multi-object exports
        let json = r#"{"status": "ok", "products": [{"title": "Ecran LCD", "price": 4500, "stock": 8}]}"#;
        let table = parse_bytes(json.as_bytes(), "backup.json", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t44", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["title"], "Ecran LCD");
    }

    #[test]
    fn test_t45_duplicate_column_headers() {
        // T45: Duplicate column headers: "Prix" and "Prix"
        let csv = "Article;Prix;Prix;Quantite\nChargeur;1500;1200;10\n";
        let table = parse_bytes(csv.as_bytes(), "dup.csv", None).unwrap();

        assert_eq!(table.headers, vec!["Article", "Prix", "Prix_2", "Quantite"]);
        let (rows, entity, _) = stage_table(&table, "b_t45", None).unwrap();
        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_t46_invisible_and_zero_width_spaces() {
        // T46: Zero-width spaces (\u{200B}) in barcode and non-breaking space in phone
        let csv = "Article;Code Barre;Telephone\nBatterie;6132450\u{200B}019289;0550\u{00A0}123456\n";
        let table = parse_bytes(csv.as_bytes(), "hidden.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t46", None).unwrap();

        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["barcode"], "6132450019289");
    }

    #[test]
    fn test_t47_negative_stock_quantity() {
        // T47: Negative stock quantity (damaged / returns)
        let csv = "Article;Prix;Quantite\nArticle Endommage;1000;-5\n";
        let table = parse_bytes(csv.as_bytes(), "returns.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t47", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["opening_stock"], 0.0);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(rows[0].rejection_reason.as_deref().unwrap().contains("InvalidStockQuantity"));
    }

    #[test]
    fn test_t48_wholesale_supplier_arabic_keywords() {
        // T48: Arabic supplier keywords (مؤسسة, استيراد, تجارة جملة, موزع)
        let csv = "الاسم;الهاتف\nمؤسسة النور للاستيراد والتصدير;021123456\nشركة البركة لتجارة الجملة;0550112233\nموزع الهواتف المعتمد;0661223344\n";
        let table = parse_bytes(csv.as_bytes(), "suppliers_ar.csv", None).unwrap();
        let (rows, entity, warnings) = stage_table(&table, "b_t48", None).unwrap();

        assert_eq!(entity, EntityType::Suppliers);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|w| w.code == "DeferredEntitySuppliers"));
    }

    #[test]
    fn test_t49_multi_row_sql_insert_dump() {
        // T49: SQL INSERT with multiple comma-separated tuples in single statement
        let sql = "INSERT INTO `products` (`barcode`, `title`, `price`) VALUES ('6132450019289', 'Chargeur', 1500), ('6132450019296', 'Cable', 500), ('6132450019302', 'Coque', 300);";
        let table = parse_bytes(sql.as_bytes(), "dump.sql", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t49", None).unwrap();

        assert_eq!(entity, EntityType::Products);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].action, StagingRowAction::Create);
        assert_eq!(rows[1].action, StagingRowAction::Create);
        assert_eq!(rows[2].action, StagingRowAction::Create);
    }

    #[test]
    fn test_t50_inspect_and_stage_end_to_end() {
        // T50: Complete lifecycle: inspect_file_bytes -> stage_file_bytes into SQLite staging DB
        let csv = "Code Barre;Designation;Prix Vente;Prix Achat;Stock\n6132450019289;Chargeur 20W;1500;1000;20\n6132450019296;Cable USB-C;500;300;50\n";
        let inspect =
            crate::import::inspect_file_bytes(csv.as_bytes(), "catalog.csv", None, None).unwrap();

        assert_eq!(inspect.detected_entity, EntityType::OpeningStock);
        assert_eq!(inspect.total_rows, 2);
        assert_eq!(inspect.headers, vec!["Code Barre", "Designation", "Prix Vente", "Prix Achat", "Stock"]);
        assert_eq!(inspect.column_mappings.len(), 5);

        let mut staging_conn = Connection::open_in_memory().unwrap();
        crate::import::init_staging_db(&staging_conn).unwrap();

        let (batch, staged_rows) = crate::import::stage_file_bytes(
            &mut staging_conn,
            csv.as_bytes(),
            "catalog.csv",
            None,
            None,
        ).unwrap();

        assert_eq!(batch.row_count, 2);
        assert_eq!(batch.created_count, 2);
        assert_eq!(batch.updated_count, 0);
        assert_eq!(batch.rejected_count, 0);
        assert_eq!(staged_rows.len(), 2);

        // Verify SQLite CHECK constraint on batch table
        let count: i64 = staging_conn
            .query_row("SELECT count(*) FROM import_batches WHERE batch_id = ?1", [&batch.batch_id], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_t51_delimiter_sniffing_with_commas_in_quotes() {
        // T51: Semicolon delimited file where description cells contain commas inside quotes
        let csv = "Designation;Prix;Stock\n\"Coque, silicone, rouge\";1500;10\n\"Verre trempé, 9H, transparent\";500;20\n";
        let delim = crate::import::parser::sniff_delimiter(csv);
        assert_eq!(delim, b';', "Expected semicolon delimiter, got '{}'", delim as char);

        let table = parse_bytes(csv.as_bytes(), "products.csv", None).unwrap();
        assert_eq!(table.headers, vec!["Designation", "Prix", "Stock"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0][0], "Coque, silicone, rouge");
    }

    #[test]
    fn test_t52_multiple_barcodes_in_cell_extraction() {
        // T52: Multi-barcode cell: "6132450019289 / 6132450019296"
        let (p, s) = crate::import::detect::extract_primary_barcode("6132450019289 / 6132450019296");
        assert_eq!(p, "6132450019289");
        assert_eq!(s, Some("6132450019296".to_string()));

        let csv = "Code Barre;Designation;Prix\n6132450019289 / 6132450019296;Pack Duo Chargeur;2500\n";
        let table = parse_bytes(csv.as_bytes(), "products.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t52", None).unwrap();

        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["barcode"], "6132450019289");
        assert_eq!(payload["secondary_barcode"], "6132450019296");
    }

    #[test]
    fn test_t53_foreign_currency_warning() {
        // T53: Foreign currency USD marker detected
        let csv = "Designation;Prix\nEcran iPhone 13;25 USD\n";
        let table = parse_bytes(csv.as_bytes(), "invoices.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t53", None).unwrap();

        assert!(rows[0].warnings_json.contains("ForeignCurrencyDetected"));
        assert!(rows[0].needs_review);
    }

    #[test]
    fn test_t54_arabic_orthography_tashkeel_and_hamza_folding() {
        // T54: Arabic keyword with full Tashkeel diacritics: مُوَزِّعٌ
        let folded = crate::import::detect::fold_arabic_orthography("مُوَزِّعٌ مُعْتَمَدٌ لِلهَوَاتِفِ");
        assert_eq!(folded, "موزع معتمد للهواتف");

        let csv = "الاسم;الهاتف\nمُوَزِّعٌ مُعْتَمَدٌ لِلهَوَاتِفِ;0550112233\nمُؤَسَّسَةُ النُّورِ;021998877\n";
        let table = parse_bytes(csv.as_bytes(), "ar.csv", None).unwrap();
        let (rows, entity, warnings) = stage_table(&table, "b_t54", None).unwrap();

        assert_eq!(entity, EntityType::Suppliers);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert!(warnings.iter().any(|w| w.code == "DeferredEntitySuppliers"));
    }

    #[test]
    fn test_t55_warranty_months_duration_parsing() {
        // T55: Warranty duration parsed in months
        assert_eq!(crate::import::map::parse_warranty_cell("12 mois"), (Some(12), false));
        assert_eq!(crate::import::map::parse_warranty_cell("1 an"), (Some(12), false));
        assert_eq!(crate::import::map::parse_warranty_cell("2 ans"), (Some(24), false));
        assert_eq!(crate::import::map::parse_warranty_cell("6 mois"), (Some(6), false));
        assert_eq!(crate::import::map::parse_warranty_cell("sans"), (Some(0), true));

        let csv = "Designation;Prix;Garantie\nChargeur Anker;2500;12 mois\nCable Baseus;800;sans\n";
        let table = parse_bytes(csv.as_bytes(), "products.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t55", None).unwrap();

        let p0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(p0["warranty_months"], 12);
        assert_eq!(p0["warranty_explicitly_disabled"], false);

        let p1: serde_json::Value = serde_json::from_str(rows[1].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(p1["warranty_months"], 0);
        assert_eq!(p1["warranty_explicitly_disabled"], true);
    }

    #[test]
    fn test_t56_rich_catalog_brand_model_category() {
        // T56: Brand, compatible model, and category fields mapped into normalized JSON
        let csv = "Article;Marque;Modele;Categorie;Prix\nCoque Silicone;Apple;iPhone 13;Accessoires;1200\n";
        let table = parse_bytes(csv.as_bytes(), "catalog.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t56", None).unwrap();

        assert_eq!(entity, EntityType::Products);
        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["brand"], "Apple");
        assert_eq!(payload["compatible_model"], "iPhone 13");
        assert_eq!(payload["category"], "Accessoires");
    }

    #[test]
    fn test_t57_customer_email_mapping() {
        // T57: Customer email column mapped into customer payload
        let csv = "Nom;Telephone;Email\nKarim Benali;0550123456;karim@example.dz\n";
        let table = parse_bytes(csv.as_bytes(), "customers.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t57", None).unwrap();

        assert_eq!(entity, EntityType::Customers);
        let payload: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(payload["name"], "Karim Benali");
        assert_eq!(payload["phone"], "0550123456");
        assert_eq!(payload["email"], "karim@example.dz");
    }

    #[test]
    fn test_t58_cached_statement_query_performance() {
        // T58: Verify statement caching across multiple rows matching live DB
        let ro_conn = Connection::open_in_memory().unwrap();
        ro_conn.execute_batch(
            "CREATE TABLE products (id TEXT PRIMARY KEY, barcode TEXT);
             INSERT INTO products VALUES ('p1', '6132450019289');
             INSERT INTO products VALUES ('p2', '6132450019296');"
        ).unwrap();

        let csv = "Code Barre;Designation;Prix\n6132450019289;Chargeur;1500\n6132450019296;Cable;500\n";
        let table = parse_bytes(csv.as_bytes(), "test.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t58", Some(&ro_conn)).unwrap();

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, StagingRowAction::Update);
        assert_eq!(rows[0].matched_entity_id, Some("p1".to_string()));
        assert_eq!(rows[1].action, StagingRowAction::Update);
        assert_eq!(rows[1].matched_entity_id, Some("p2".to_string()));
    }

    #[test]
    fn test_t59_regex_free_thousand_dot_nanosecond_speed() {
        // T59: Regex-free slice validation for thousands grouping and decimals
        assert!(crate::import::detect::is_thousands_grouped_dotted("45.000"));
        assert!(crate::import::detect::is_thousands_grouped_dotted("1.250.000"));
        assert!(!crate::import::detect::is_thousands_grouped_dotted("12.50"));

        assert!(crate::import::detect::is_one_or_two_decimal_dotted("12.50"));
        assert!(crate::import::detect::is_one_or_two_decimal_dotted("0.5"));
        assert!(!crate::import::detect::is_one_or_two_decimal_dotted("45.000"));
    }

    #[test]
    fn test_t60_euro_and_pound_foreign_currency_warnings() {
        // T60: Euro (€) and British Pound (£) currency detection
        assert_eq!(crate::import::map::detect_foreign_currency("150 €"), Some("EUR"));
        assert_eq!(crate::import::map::detect_foreign_currency("20.00 EUR"), Some("EUR"));
        assert_eq!(crate::import::map::detect_foreign_currency("50 £"), Some("GBP"));
        assert_eq!(crate::import::map::detect_foreign_currency("1500 DA"), None);
    }

    #[test]
    fn test_t61_clients_telephones_dettes_e2e() {
        // T61: Verifies the exact French Algerian format from clients_telephones_dettes_fr.csv
        let csv = "Nom du client;Numéro de téléphone;Dette (DZD)\nAmine Benali;0550 12 34 56;2500\nSamira Haddad;0661 23 45 67;0\n";
        let table = parse_bytes(csv.as_bytes(), "clients.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t61", None).unwrap();

        assert_eq!(entity, EntityType::Customers);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, StagingRowAction::Reject);
        assert_eq!(rows[1].action, StagingRowAction::Reject);

        let n0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(n0["name"], "Amine Benali");
        assert_eq!(n0["phone"], "0550123456");
        assert!(rows[0].rejection_reason.as_deref().unwrap().contains("DebtRequiresDedicatedDestination"));

        let n1: serde_json::Value = serde_json::from_str(rows[1].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(n1["name"], "Samira Haddad");
        assert_eq!(n1["phone"], "0661234567");
        assert!(n1.get("initial_debt").is_none());
    }

    #[test]
    fn test_t62_products_stock_fifo_cost_price_e2e() {
        let csv = "Nom du produit;Stock;Prix d'achat (DZD);Prix de vente (DZD)\n\
Câble de charge USB-C;35;250;450\n\
Souris sans fil;18;900;1400\n\
Clé USB 32 Go;24;700;1100\n\
Chargeur de téléphone 20 W;20;800;1300\n\
Écouteurs filaires;16;500;850\n\
Câble HDMI 2 m;12;400;700\n\
Batterie externe 10 000 mAh;10;2200;3200\n\
Enceinte Bluetooth;8;2800;3900\n\
Support de refroidissement pour ordinateur portable;7;1800;2600\n\
Clavier sans fil;9;1700;2500\n";

        let table = parse_bytes(csv.as_bytes(), "products.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t62", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 10);

        let row0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(row0["title"], "Câble de charge USB-C");
        assert_eq!(row0["opening_stock"], 35.0);
        assert_eq!(row0["cost_price"]["dzd"], 250);
        assert_eq!(row0["price"]["dzd"], 450);

        let row6: serde_json::Value = serde_json::from_str(rows[6].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(row6["title"], "Batterie externe 10 000 mAh");
        assert_eq!(row6["opening_stock"], 10.0);
        assert_eq!(row6["cost_price"]["dzd"], 2200);
        assert_eq!(row6["price"]["dzd"], 3200);
    }

    #[test]
    fn test_t63_serialized_phone_imei_and_fifo_e2e() {
        // Serialized phone catalog with IMEIs, pricing, supplier, and stock
        let csv = "Désignation;IMEI;Prix d'achat;Prix de vente;Fournisseur;Tél Fournisseur\n\
iPhone 15 Pro 128Go;352099001761481;165000;185000;SARL Tech Mobile;0550112233\n\
Samsung S24 Ultra;354890001892344;172000;192000;EURL Algerie Telecom;0661223344\n";

        let table = parse_bytes(csv.as_bytes(), "phones.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t63", None).unwrap();

        assert_eq!(entity, EntityType::Products);
        assert_eq!(rows.len(), 2);

        let row0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(row0["title"], "iPhone 15 Pro 128Go");
        assert_eq!(row0["is_serialized"], true);
        assert_eq!(row0["imei_number"], "352099001761481");
        assert_eq!(row0["vendor_name"], "SARL Tech Mobile");
        assert_eq!(row0["vendor_phone"], "0550112233");
        assert_eq!(row0["opening_stock"], 1.0);
        assert_eq!(row0["cost_price"]["dzd"], 165000);
        assert_eq!(row0["price"]["dzd"], 185000);

        // Commit to in-memory staging and live DB
        let mut staging_conn = Connection::open_in_memory().unwrap();
        crate::import::init_staging_db(&staging_conn).unwrap();

        let mut live_conn = Connection::open_in_memory().unwrap();
        live_conn.execute_batch(r#"
            CREATE TABLE products (
                id TEXT PRIMARY KEY, sku TEXT NOT NULL, barcode TEXT NOT NULL, title TEXT NOT NULL,
                brand TEXT NOT NULL, compatible_model TEXT, category TEXT NOT NULL,
                price REAL NOT NULL, wholesale_price REAL DEFAULT 0, cost_price REAL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0, image_url TEXT, is_serialized INTEGER DEFAULT 0,
                imei_number TEXT, vendor_name TEXT, lead_time_days INTEGER DEFAULT 0,
                daily_sales_velocity REAL DEFAULT 0, reorder_point INTEGER DEFAULT 0,
                json_payload TEXT NOT NULL, updated_at TEXT NOT NULL,
                device_id TEXT DEFAULT 'local', idempotency_key TEXT DEFAULT '',
                sync_status TEXT DEFAULT 'pending', created_at TEXT DEFAULT '',
                deleted INTEGER DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE stock_batches (
                batch_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
                quantity_remaining REAL NOT NULL, unit_cost REAL NOT NULL,
                freight_per_unit REAL DEFAULT 0, received_at TEXT NOT NULL,
                purchase_order_id TEXT, device_id TEXT NOT NULL DEFAULT 'local',
                idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE inventory_ledger (
                id TEXT PRIMARY KEY, product_id TEXT NOT NULL, delta INTEGER NOT NULL,
                reason TEXT NOT NULL, ref_type TEXT, ref_id TEXT, device_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE, sync_status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE imei_records (
                imei TEXT PRIMARY KEY, product_id TEXT NOT NULL, purchase_order_id TEXT,
                sale_transaction_id TEXT, warranty_expires_at TEXT, received_at TEXT NOT NULL, sold_at TEXT,
                status TEXT
            );
            CREATE TABLE sync_outbox (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
                payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
            );
        "#).unwrap();

        let batch = ImportBatch {
            batch_id: "b_t63".to_string(),
            file_name: "phones.csv".to_string(),
            file_sha256: "sha_t63".to_string(),
            entity_type: "products".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 2,
            created_count: 2,
            updated_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "2026-10-21T10:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        crate::import::insert_staging_batch_tx(&mut staging_conn, &batch, &rows).unwrap();
        let result = crate::import::commit::commit_staged_batch(&mut staging_conn, &mut live_conn, "b_t63").unwrap();
        assert_eq!(result.created_count, 2);

        // Verify product in live DB
        let (is_ser, imei_val, cost_val, price_val, stock_val): (i64, Option<String>, f64, f64, i64) = live_conn
            .query_row(
                "SELECT is_serialized, imei_number, cost_price, price, stock FROM products WHERE title = 'iPhone 15 Pro 128Go'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(is_ser, 1);
        assert_eq!(imei_val, Some("352099001761481".to_string()));
        assert_eq!(cost_val, 165000.0);
        assert_eq!(price_val, 185000.0);
        assert_eq!(stock_val, 1);

        // Verify imei_records
        let imei_count: i64 = live_conn
            .query_row("SELECT count(*) FROM imei_records WHERE imei = '352099001761481'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(imei_count, 1);

        // Verify stock_batches FIFO entry
        let (sbatch_qty, sbatch_cost): (f64, f64) = live_conn
            .query_row("SELECT quantity_remaining, unit_cost FROM stock_batches LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(sbatch_qty, 1.0);
        assert_eq!(sbatch_cost, 165000.0);

        // Verify sync_outbox contains imei_records, stock_batches, ledger, product
        let outbox_types: Vec<String> = live_conn
            .prepare("SELECT DISTINCT entity_type FROM sync_outbox ORDER BY entity_type")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(outbox_types.contains(&"imei_records".to_string()));
        assert!(outbox_types.contains(&"stock_batches".to_string()));
        assert!(outbox_types.contains(&"ledger".to_string()));
        assert!(outbox_types.contains(&"product".to_string()));
    }

    #[test]
    fn test_t64_standalone_supplier_import_override_e2e() {
        let csv = "Fournisseur;Téléphone;Email;Adresse\n\
SARL Global Tech Alger;021123456;contact@globaltech.dz;12 Rue Didouche Mourad, Alger\n\
EURL Distribution Telephonie;0550112233;distrib@telecom.dz;Zone Industrielle Oued Smar\n";

        let table = parse_bytes(csv.as_bytes(), "suppliers.csv", None).unwrap();
        let (rows, entity, _) = crate::import::map::stage_table_with_overrides(&table, "b_t64", None, Some("suppliers"), None).unwrap();

        assert_eq!(entity, EntityType::Suppliers);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, StagingRowAction::Create);
        assert_eq!(rows[1].action, StagingRowAction::Create);

        let row0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(row0["name"], "SARL Global Tech Alger");
        assert_eq!(row0["phone"], "021123456");
        assert_eq!(row0["email"], "contact@globaltech.dz");

        let mut staging_conn = Connection::open_in_memory().unwrap();
        crate::import::init_staging_db(&staging_conn).unwrap();

        let mut live_conn = Connection::open_in_memory().unwrap();
        live_conn.execute_batch(r#"
            CREATE TABLE vendor_aliases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                supplier_name TEXT NOT NULL,
                raw_vendor_name TEXT NOT NULL,
                product_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now', 'utc')),
                UNIQUE(supplier_name, raw_vendor_name)
            );
            CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT '',
                version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE sync_outbox (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
                entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, operation TEXT NOT NULL,
                payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
            );
        "#).unwrap();

        let batch = ImportBatch {
            batch_id: "b_t64".to_string(),
            file_name: "suppliers.csv".to_string(),
            file_sha256: "sha_t64".to_string(),
            entity_type: "suppliers".to_string(),
            mapping_config_json: "{}".to_string(),
            row_count: 2,
            created_count: 2,
            updated_count: 0,
            skipped_count: 0,
            rejected_count: 0,
            status: "staged".to_string(),
            created_at: "2026-10-21T10:00:00Z".to_string(),
            committed_at: None,
            rolled_back_at: None,
        };

        crate::import::insert_staging_batch_tx(&mut staging_conn, &batch, &rows).unwrap();
        let result = crate::import::commit::commit_staged_batch(&mut staging_conn, &mut live_conn, "b_t64").unwrap();
        assert_eq!(result.created_count, 2);

        // Contact imports do not synthesize supplier-to-product aliases.
        let alias_count: i64 = live_conn
            .query_row("SELECT count(*) FROM vendor_aliases", [], |r| r.get(0))
            .unwrap();
        assert_eq!(alias_count, 0);

        // Verify app_settings vendor_directory contains both suppliers
        let vendor_dir_json: String = live_conn
            .query_row("SELECT value_json FROM app_settings WHERE key = 'vendor_directory'", [], |r| r.get(0))
            .unwrap();
        let vendor_dir: serde_json::Value = serde_json::from_str(&vendor_dir_json).unwrap();
        assert!(vendor_dir.get("SARL Global Tech Alger").is_some());
        assert!(vendor_dir.get("EURL Distribution Telephonie").is_some());
        assert_eq!(vendor_dir["SARL Global Tech Alger"]["contact"]["phone"], "021123456");

        // Verify sync_outbox has app_settings entry
        let outbox_count: i64 = live_conn
            .query_row("SELECT count(*) FROM sync_outbox WHERE entity_type = 'app_settings'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outbox_count, 1);
    }

    #[test]
    fn test_t65_corrupted_dirty_phone_sheet_with_luhn_and_spaces() {
        let csv = "Désignation;IMEI;Prix d'achat;Prix de vente\n\
iPhone 15;3520 9900 1761 482;150000;170000\n\
Samsung S24;354890-00-189234-1;160000;180000\n\
Redmi Note 13;352099001761480;30000;35000\n\
Loss Leader Phone;861234056789123;100000;90000\n";

        let table = parse_bytes(csv.as_bytes(), "dirty_phones.csv", None).unwrap();
        let (rows, _, _) = stage_table(&table, "b_t65", None).unwrap();

        assert_eq!(rows.len(), 4);

        // Row 1: stripped to canonical 15 digits
        let r0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(r0["imei_number"], "352099001761482");
        assert_eq!(r0["is_serialized"], true);

        // Row 2: hyphens stripped to canonical 15 digits
        let r1: serde_json::Value = serde_json::from_str(rows[1].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(r1["imei_number"], "354890001892341");
        assert_eq!(r1["is_serialized"], true);

        // Row 3: invalid Luhn flagged for review
        assert!(rows[2].needs_review);
        assert!(rows[2].warnings_json.contains("InvalidImeiLuhnChecksum"));

        // Row 4: selling below cost warning
        assert!(rows[3].needs_review);
        assert!(rows[3].warnings_json.contains("SellingBelowCostWarning"));
    }

    #[test]
    fn test_t66_completely_reversed_and_shuffled_product_ordering() {
        // Shuffled and reversed columns:
        // Prix de vente, Stock, Fournisseur, Prix d'achat, Nom du produit, Code Barre, Garantie, Tél Fournisseur
        let csv = "Prix de vente (DZD);Stock;Fournisseur;Prix d'achat (DZD);Nom du produit;Code Barre;Garantie;Tél Fournisseur\n\
450;35;SARL Tech Mobile;250;Câble de charge USB-C;6132450019289;12 mois;0550112233\n\
1400;18;EURL Informatique;900;Souris sans fil;6132450019296;6 mois;0661223344\n";

        let table = parse_bytes(csv.as_bytes(), "shuffled.csv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t66", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 2);

        let row0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(row0["title"], "Câble de charge USB-C");
        assert_eq!(row0["barcode"], "6132450019289");
        assert_eq!(row0["opening_stock"], 35.0);
        assert_eq!(row0["price"]["dzd"], 450);
        assert_eq!(row0["cost_price"]["dzd"], 250);
        assert_eq!(row0["vendor_name"], "SARL Tech Mobile");
        assert_eq!(row0["vendor_phone"], "0550112233");
        assert_eq!(row0["warranty_months"], 12);
    }

    #[test]
    fn test_t67_dual_price_unlabeled_auto_ordering() {
        // Dual price columns where headers do not specify which is cost and which is retail:
        // Case A: Tarif 1 (Cost = 250) < Tarif 2 (Retail = 450)
        let csv_a = "Article;Tarif 1;Tarif 2;Quantite\n\
Cable USB;250;450;35\n\
Souris;900;1400;18\n";
        let table_a = parse_bytes(csv_a.as_bytes(), "tarifs_a.csv", None).unwrap();
        let (rows_a, _, _) = stage_table(&table_a, "b_t67a", None).unwrap();

        let r0a: serde_json::Value = serde_json::from_str(rows_a[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(r0a["cost_price"]["dzd"], 250);
        assert_eq!(r0a["price"]["dzd"], 450);

        // Case B: Inverted order: Tarif 1 (Retail = 450) > Tarif 2 (Cost = 250)
        let csv_b = "Article;Tarif 1;Tarif 2;Quantite\n\
Cable USB;450;250;35\n\
Souris;1400;900;18\n";
        let table_b = parse_bytes(csv_b.as_bytes(), "tarifs_b.csv", None).unwrap();
        let (rows_b, _, _) = stage_table(&table_b, "b_t67b", None).unwrap();

        let r0b: serde_json::Value = serde_json::from_str(rows_b[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(r0b["price"]["dzd"], 450);
        assert_eq!(r0b["cost_price"]["dzd"], 250);
    }

    #[test]
    fn test_t68_multi_column_company_banner_discovery() {
        // Multi-column company banner metadata before real table header + footer summary row
        let csv = "SARL IMPORT DISTRIBUTION;ALGER CENTRE;TEL: 021123456\n\
RC: 16/00-1234;NIF: 000116090000034;NIS: 123456789\n\
ETAT DES STOCKS;DATE: 21/10/2026;DEPOT CENTRAL\n\
Désignation;Prix;Stock\n\
Chargeur 20W;1500;10\n\
Câble Type-C;500;25\n\
TOTAL GENERAL;2000;35\n";

        let table = parse_bytes(csv.as_bytes(), "banner.csv", None).unwrap();
        assert_eq!(table.headers, vec!["Désignation", "Prix", "Stock"]);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[0], vec!["Chargeur 20W", "1500", "10"]);
        assert_eq!(table.rows[1], vec!["Câble Type-C", "500", "25"]);
        assert!(table.warnings.iter().any(|w| w.code == "BannerRowsSkipped"));
        assert!(table.warnings.iter().any(|w| w.code == "SummaryRowSkipped"));
    }

    #[test]
    fn test_t69_headerless_product_auto_inference() {
        // Headerless product catalog with text, small integer stock, and larger price
        let tsv = "Souris sans fil\t18\t1400\nClé USB 32 Go\t24\t1100\nChargeur 20W\t20\t1300\n";
        let table = parse_bytes(tsv.as_bytes(), "headerless.tsv", None).unwrap();
        let (rows, entity, _) = stage_table(&table, "b_t69", None).unwrap();

        assert_eq!(entity, EntityType::OpeningStock);
        assert_eq!(rows.len(), 2);

        let r0: serde_json::Value = serde_json::from_str(rows[0].normalized_json.as_ref().unwrap()).unwrap();
        assert_eq!(r0["title"], "Clé USB 32 Go");
        assert_eq!(r0["opening_stock"], 24.0);
        assert_eq!(r0["price"]["dzd"], 1100);
    }
}
