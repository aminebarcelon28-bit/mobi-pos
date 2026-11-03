#!/usr/bin/env node
/**
 * Virtual ESC/POS capture sink (dev/test only).
 *
 * Listens on a TCP port exactly like a network receipt printer (raw port 9100 by
 * default), accepts jobs, and writes each one to disk so a test (or a human with
 * a printer) can inspect the real byte stream. No dependencies, loopback only.
 *
 *   node scripts/escpos_sink.mjs --port 9100            # until Ctrl+C
 *   node scripts/escpos_sink.mjs --port 0 --once        # ephemeral, one job
 *   node scripts/escpos_sink.mjs --out tests/results/escpos --port 0 --once --json
 *
 * Files per job: `<stamp>.bin` (verbatim bytes) and `<stamp>.json`
 * ({ bytes, sha256, peer, firstByteAt, lastByteAt, idleMs }) — the metadata is
 * what proves a job was one continuous write rather than dribbling bytes.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

export function createCaptureSink({ outDir, once = false, idleMs = 400, onJob } = {}) {
  const dir = outDir ?? path.join(process.cwd(), 'tests', 'results', 'escpos');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [];
  const server = net.createServer((socket) => {
    const chunks = [];
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    let firstByteAt = 0;
    let lastByteAt = 0;
    let timer = null;

    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!chunks.length) return;
      const buf = Buffer.concat(chunks);
      chunks.length = 0;
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bin = path.join(dir, `${stamp}.bin`);
      const meta = path.join(dir, `${stamp}.json`);
      fs.writeFileSync(bin, buf);
      const record = {
        bytes: buf.length,
        sha256,
        peer,
        firstByteAt: new Date(firstByteAt).toISOString(),
        lastByteAt: new Date(lastByteAt).toISOString(),
        idleMs: Math.max(0, lastByteAt - firstByteAt),
        file: bin,
      };
      fs.writeFileSync(meta, JSON.stringify(record, null, 2));
      jobs.push({ ...record, data: buf });
      onJob?.(record, buf);
      if (once) server.close();
    };

    socket.on('data', (c) => {
      if (!firstByteAt) firstByteAt = Date.now();
      lastByteAt = Date.now();
      chunks.push(c);
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, idleMs);
    });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });

  return {
    server,
    dir,
    jobs,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const port = Number(arg('port', 9100));
  const outDir = arg('out', path.join(process.cwd(), 'tests', 'results', 'escpos'));
  const once = Boolean(arg('once', false));
  const sink = createCaptureSink({
    outDir,
    once,
    idleMs: Number(arg('idle', 400)),
    onJob: (record) => {
      console.log(`[escpos-sink] job ${record.bytes} bytes sha256=${record.sha256.slice(0, 16)} file=${record.file}`);
    },
  });
  const actual = await sink.listen(port);
  console.log(`[escpos-sink] listening on 127.0.0.1:${actual} dir=${outDir}${once ? ' (one job)' : ''}`);
  if (arg('json', false)) console.log(JSON.stringify({ port: actual, dir: outDir }));
  if (!once) {
    process.on('SIGINT', async () => {
      await sink.close();
      process.exit(0);
    });
  } else {
    sink.server.on('close', () => process.exit(0));
  }
}
