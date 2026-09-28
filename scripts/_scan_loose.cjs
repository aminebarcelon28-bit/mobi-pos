const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const gitDir = path.join(process.cwd(), '.git', 'objects');
for (const sub of fs.readdirSync(gitDir)) {
  if (sub.length === 2) {
    const subDir = path.join(gitDir, sub);
    for (const f of fs.readdirSync(subDir)) {
      const hash = sub + f;
      try {
        const type = execSync('git cat-file -t ' + hash).toString().trim();
        if (type === 'blob') {
          const size = Number(execSync('git cat-file -s ' + hash).toString().trim());
          if (size > 50000 && size < 300000) {
            // Check if it has getAllocationCogsForSale
            const preview = execSync('git cat-file -p ' + hash).toString('utf8');
            if (preview.includes('getAllocationCogsForSale')) {
              console.log('FOUND MATCHING BLOB IN GIT:', hash, 'size:', size, 'lines:', preview.split(/\r?\n/).length);
            }
          }
        }
      } catch {}
    }
  }
}
console.log('Done scanning all loose blobs');
