const { execSync, spawnSync } = require('child_process');
const output = execSync('git rev-list --objects --all').toString();
const hashes = output.split('\n').map(l => l.split(' ')[0]).filter(Boolean);
console.log('Total objects in rev-list:', hashes.length);

const res = spawnSync('git', ['cat-file', '--batch-check'], { input: hashes.join('\n') });
const lines = res.stdout.toString().split('\n');
const largeBlobs = [];
for (const line of lines) {
  const [hash, type, size] = line.trim().split(/\s+/);
  if (type === 'blob' && Number(size) > 100000) {
    largeBlobs.push({ hash, size: Number(size) });
  }
}
console.log('Large blobs > 100KB in packs/revs:', largeBlobs.length);
for (const b of largeBlobs) {
  const content = spawnSync('git', ['cat-file', '-p', b.hash]).stdout.toString('utf8');
  if (content.includes('getAllocationCogsForSale')) {
    console.log('FOUND MATCHING BLOB IN PACK:', b.hash, 'size:', b.size, 'lines:', content.split(/\r?\n/).length);
  }
}
