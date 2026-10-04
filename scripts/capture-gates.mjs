import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');
const CAPTURE_DIR = path.join(ARTIFACTS_DIR, 'capture');
const MANIFEST_FILE = path.join(ARTIFACTS_DIR, 'MANIFEST.jsonl');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function getNextSlotNumber() {
  ensureDir(CAPTURE_DIR);
  const existing = fs.readdirSync(CAPTURE_DIR);
  let max = 0;
  for (const item of existing) {
    const m = item.match(/^(\d{3})-/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

function getLastChainHash() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    return '0000000000000000000000000000000000000000000000000000000000000000';
  }
  const lines = fs.readFileSync(MANIFEST_FILE, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return '0000000000000000000000000000000000000000000000000000000000000000';
  }
  const lastLine = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(lastLine);
    return parsed.chain_hash || '0000000000000000000000000000000000000000000000000000000000000000';
  } catch {
    return '0000000000000000000000000000000000000000000000000000000000000000';
  }
}

function appendToManifest(entries) {
  let prevHash = getLastChainHash();
  const linesToAppend = [];

  for (const entry of entries) {
    const rawString = `${prevHash}:${entry.sha256}:${entry.relPath}`;
    const chainHash = crypto.createHash('sha256').update(rawString, 'utf8').digest('hex');

    const manifestEntry = {
      ts_local: entry.tsLocal,
      ts_utc: entry.tsUtc,
      path: `artifacts/${entry.relPath}`,
      sha256: entry.sha256,
      how_obtained: entry.howObtained,
      prev_hash: prevHash,
      chain_hash: chainHash,
    };

    linesToAppend.push(JSON.stringify(manifestEntry));
    prevHash = chainHash;
  }

  fs.appendFileSync(MANIFEST_FILE, linesToAppend.join('\n') + '\n', 'utf8');
}

function getDualTimestamps() {
  const now = new Date();
  const utc = now.toISOString();
  const tzOffset = -now.getTimezoneOffset();
  const sign = tzOffset >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offsetHours = pad(tzOffset / 60);
  const offsetMins = pad(tzOffset % 60);
  const offsetStr = `${sign}${offsetHours}:${offsetMins}`;

  const localYear = now.getFullYear();
  const localMonth = pad(now.getMonth() + 1);
  const localDate = pad(now.getDate());
  const localHours = pad(now.getHours());
  const localMinutes = pad(now.getMinutes());
  const localSeconds = pad(now.getSeconds());
  const localMs = String(now.getMilliseconds()).padStart(3, '0');
  const local = `${localYear}-${localMonth}-${localDate}T${localHours}:${localMinutes}:${localSeconds}.${localMs}${offsetStr}`;
  return { local, utc };
}

export async function runGate(gate) {
  const slotNum = String(getNextSlotNumber()).padStart(3, '0');
  const slug = gate.slug || gate.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slotDirName = `${slotNum}-${slug}`;
  const slotDir = path.join(CAPTURE_DIR, slotDirName);
  ensureDir(slotDir);

  const stdoutPath = path.join(slotDir, 'stdout.txt');
  const stderrPath = path.join(slotDir, 'stderr.txt');
  const metaPath = path.join(slotDir, 'meta.json');

  const stdoutStream = fs.createWriteStream(stdoutPath);
  const stderrStream = fs.createWriteStream(stderrPath);

  const startTs = getDualTimestamps();

  console.log(`[GATE ${slotNum}] Starting: ${gate.name} (${gate.command})`);

  const exitCode = await new Promise((resolve) => {
    // Direct cmd.exe execution with separate stdout/stderr files
    const cp = spawn('cmd.exe', ['/c', gate.command], {
      cwd: gate.cwd ? path.resolve(REPO_ROOT, gate.cwd) : REPO_ROOT,
      env: { ...process.env, PAGER: 'cat' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    cp.stdout.pipe(stdoutStream);
    cp.stderr.pipe(stderrStream);

    cp.on('close', (code) => {
      resolve(code ?? 1);
    });

    cp.on('error', (err) => {
      stderrStream.write(`Process spawn error: ${err.message}\n`);
      resolve(1);
    });
  });

  const endTs = getDualTimestamps();

  stdoutStream.end();
  stderrStream.end();

  // Await streams flush
  await new Promise((r) => setTimeout(r, 100));

  const stdoutSha = computeSha256(stdoutPath);
  const stderrSha = computeSha256(stderrPath);

  const expectedExit = gate.expectedExit ?? 0;
  const isPass = exitCode === expectedExit;

  const meta = {
    slot: slotDirName,
    name: gate.name,
    command: gate.command,
    cwd: gate.cwd || '.',
    expected_exit: expectedExit,
    exit_code: exitCode,
    status: isPass ? 'PASS' : 'FAIL',
    start_local: startTs.local,
    start_utc: startTs.utc,
    end_local: endTs.local,
    end_utc: endTs.utc,
    stdout_sha256: stdoutSha,
    stderr_sha256: stderrSha,
  };

  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  const metaSha = computeSha256(metaPath);

  console.log(`[GATE ${slotNum}] Finished: exit=${exitCode} (expected=${expectedExit}) => ${meta.status}`);

  // Append outputs to MANIFEST.jsonl
  appendToManifest([
    {
      tsLocal: endTs.local,
      tsUtc: endTs.utc,
      relPath: `capture/${slotDirName}/stdout.txt`,
      sha256: stdoutSha,
      howObtained: `gate_capture_stdout:${gate.name}`,
    },
    {
      tsLocal: endTs.local,
      tsUtc: endTs.utc,
      relPath: `capture/${slotDirName}/stderr.txt`,
      sha256: stderrSha,
      howObtained: `gate_capture_stderr:${gate.name}`,
    },
    {
      tsLocal: endTs.local,
      tsUtc: endTs.utc,
      relPath: `capture/${slotDirName}/meta.json`,
      sha256: metaSha,
      howObtained: `gate_capture_meta:${gate.name}`,
    },
  ]);

  return meta;
}

// Harmless Validation Gates Manifest
const VALIDATION_GATES = [
  {
    name: 'Validation: Node Version',
    slug: 'node-version',
    command: 'node --version',
    cwd: '.',
    expectedExit: 0,
  },
  {
    name: 'Validation: Git Log',
    slug: 'git-log-1',
    command: 'git log -1 --oneline',
    cwd: '.',
    expectedExit: 0,
  },
  {
    name: 'Validation: Dir Scripts',
    slug: 'dir-scripts',
    command: 'dir scripts',
    cwd: '.',
    expectedExit: 0,
  },
];

// Phase 5 Approved Gates Manifest
const PHASE5_GATES = [
  {
    order: 1,
    name: 'Gate 1: Cargo Test Workspace (Debug)',
    slug: 'cargo-test-workspace',
    command: 'cargo test --workspace',
    cwd: '.',
    expectedExit: 0,
  },
  {
    order: 2,
    name: 'Gate 2: Cargo Test Release Profile',
    slug: 'cargo-test-release',
    command: 'cargo test --release',
    cwd: '.',
    expectedExit: 0,
  },
  {
    order: 3,
    name: 'Gate 3: Cargo Clippy All Targets (Zero Warnings)',
    slug: 'cargo-clippy-workspace',
    command: 'cargo clippy --workspace --all-targets -- -D warnings',
    cwd: '.',
    expectedExit: 0,
  },
  {
    order: 4,
    name: 'Gate 4: TypeScript Project Build Typecheck',
    slug: 'tsc-build-typecheck',
    command: 'npx tsc -b',
    cwd: '.',
    expectedExit: 0,
  },
  {
    order: 5,
    name: 'Gate 5: Licensing & Crypto Unit Tests',
    slug: 'test-license',
    command: 'npm run test:license',
    cwd: '.',
    expectedExit: 0,
  },
  {
    order: 6,
    name: 'Gate 6: Architecture & Boundary Invariants',
    slug: 'test-boundaries',
    command: 'npm run test:boundaries',
    cwd: '.',
    expectedExit: 0,
  },
  {
    order: 7,
    name: 'Gate 7: Patched Tauri Plugin SQL Wrapper Tests',
    slug: 'test-plugin-sql-patch',
    command: 'cargo test -p tauri-plugin-sql',
    cwd: '.',
    expectedExit: 0,
  },
  {
    order: 8,
    name: 'Ancillary Gate 1: Frontend Production Build',
    slug: 'npm-run-build',
    command: 'npm run build',
    cwd: '.',
    expectedExit: 0,
  },
];

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--validate')) {
    console.log('--- RUNNING HARMLESS VALIDATION GATES ---');
    for (const g of VALIDATION_GATES) {
      await runGate(g);
    }
    console.log('--- VALIDATION COMPLETED ---');
  } else if (args.includes('--phase5')) {
    console.log('--- RUNNING PHASE 5 APPROVED GATES (COORDINATOR UNLOCKED) ---');
    const results = [];
    for (const g of PHASE5_GATES) {
      const res = await runGate(g);
      results.push(res);
      if (res.exit_code !== res.expected_exit) {
        console.error(`[FATAL] Gate failed: ${g.name} (exit ${res.exit_code}, expected ${res.expected_exit})`);
        break;
      }
    }
    console.log('--- PHASE 5 EXECUTION FINISHED ---');
  } else if (args.includes('--run-single')) {
    const singleIdx = args.indexOf('--run-single');
    const name = args[singleIdx + 1];
    const command = args[singleIdx + 2];
    const slug = args[singleIdx + 3] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    console.log(`--- RUNNING SINGLE GATE: ${name} ---`);
    await runGate({ name, command, slug, cwd: '.', expectedExit: 0 });
    console.log('--- SINGLE GATE EXECUTION FINISHED ---');
  } else {
    console.log('Usage: node scripts/capture-gates.mjs [--validate | --phase5 | --run-single <name> <command> <slug>]');
    console.log('Phase 5 execution requires explicit coordinator unlock.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal capture error:', err);
    process.exit(1);
  });
}
