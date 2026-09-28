const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const gitDir = path.join(process.cwd(), '.git', 'objects');
const hashes = [];
for (const sub of fs.readdirSync(gitDir)) {
  if (sub.length === 2) {
    const subDir = path.join(gitDir, sub);
    for (const f of fs.readdirSync(subDir)) {
      hashes.push(sub + f);
    }
  }
}
console.log('Total loose objects:', hashes.length);
const res = spawnSync('git', ['cat-file', '--batch-check'], { input: hashes.join('\n') });
const lines = res.stdout.toString().split('\n');
const largeBlobs = [];
for (const line of lines) {
  const [hash, type, size] = line.trim().split(/\s+/);
  if (type === 'blob' && Number(size) > 100000) {
    largeBlobs.push({ hash, size: Number(size) });
  }
}
console.log('Large blobs > 100KB:', largeBlobs);
for (const b of largeBlobs) {
  const content = spawnSync('git', ['cat-file', '-p', b.hash]).stdout.toString('utf8');
  if (content.includes('getAllocationCogsForSale')) {
    console.log('FOUND MATCHING BLOB IN GIT:', b.hash, 'size:', b.size, 'lines:', content.split(/\r?\n/).length);
    fs.writeFileSync('src/db/sqlPluginAdapter.ts', content, 'utf8');
    console.log('SUCCESSFULLY RESTORED src/db/sqlPluginAdapter.ts!');
  }
}
