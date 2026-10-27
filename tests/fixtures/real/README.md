# Real Fixtures Directory for Smart Import Calibration

This directory holds real, anonymized merchant export files used to calibrate column synonyms, entity sniffers, and confidence thresholds.

## Safety Rules
1. **Never commit raw customer data.** Every file committed here must be pre-processed with `python scripts/anonymize_export.py <input> <output>`.
2. Raw files with names matching `*.raw.*`, `raw_*`, `*.private.*`, etc., are ignored by `.gitignore`.
3. Each test fixture `sample.csv` or `sample.xlsx` should have a corresponding `sample.labels.json` detailing the ground-truth entity type (`Products`, `OpeningStock`, `Customers`, `Suppliers`, `CustomerDebts`, `ActiveRepairs`, `SerializedImeis`) and expected column mappings.
4. The evaluation harness `eval_harness.rs` runs against labeled files in this directory. If fewer than 10 labeled real files are present, the production calibration gate fails closed.

