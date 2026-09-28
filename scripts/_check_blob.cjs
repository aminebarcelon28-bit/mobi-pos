const { execSync } = require('child_process');
const content = execSync('git cat-file -p 5dfed6deb03f37c29403a3658deae4ecec36e3ac').toString('utf8');
const lines = content.split(/\r?\n/);
const startIdx = lines.findIndex(l => l.includes("const orderSync = "));
const endMarker = lines.findIndex(l => l.includes("// 6. Enqueue inventory ledger deltas"));
console.log("startIdx:", startIdx);
console.log("endMarker:", endMarker);
console.log("total lines:", lines.length);
