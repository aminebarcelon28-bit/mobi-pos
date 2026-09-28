const fs = require('fs');
const content = fs.readFileSync('dist/assets/sync-engine-CoMkPQ3b.js', 'utf8');
const p = content.indexOf('function Ql(');
console.log(content.slice(p, p + 2500));
