const fs = require('fs');
const content = fs.readFileSync('src/db/sqlPluginAdapter.ts', 'utf8');
const lines = content.split(/\r?\n/);
const startIdx = lines.findIndex(l => l.includes("const orderSync = "));
const endMarker = lines.findIndex(l => l.includes("// 6. Enqueue inventory ledger deltas"));
console.log("startIdx:", startIdx);
console.log("endMarker:", endMarker);
