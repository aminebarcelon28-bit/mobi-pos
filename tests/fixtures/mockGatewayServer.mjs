/**
 * Loopback gateway fixture (MOBI-GATEWAY-SYNC-VERIFIER). Imported by
 * integration harnesses — NOT production code.
 *
 * Wraps `proxy/gateway.mjs` with an ephemeral port, a fixed test device
 * keypair, and fault-injection controls. The gateway mints SERVERTIME_V1
 * with the DEBUG test seed (`09…`), which the native client verifies in
 * debug builds via the reanchor test-key fallback and REFUSES in release —
 * exactly the production key discipline, so a passing loopback proves the
 * wire shape, not a bypass.
 */
import { createGatewayServer, publicKeyHexFromSeedHex } from '../../proxy/gateway.mjs';
import { sign, createPrivateKey } from 'node:crypto';

const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';
export const FIXTURE_GATEWAY_SEED = '09'.repeat(32);
export const FIXTURE_DEVICE_SEED = '11'.repeat(32);

export function deviceKeypair(seedHex = FIXTURE_DEVICE_SEED) {
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, 'hex'), Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  return { privateKey: priv, publicKeyHex: publicKeyHexFromSeedHex(seedHex) };
}

export function signEnvelope(privateKey, envelope) {
  return sign(null, Buffer.from(envelope, 'utf8'), privateKey).toString('hex');
}

/** Positional envelope v3 — the bytes the native command signs. */
export const envelopeFor = (ticketId, refundId, net, deviceId, seq, verifiedMs = 0) =>
  `${ticketId}|${refundId}|${net}|${deviceId}|${seq}|${verifiedMs}`;

export async function bootMockGateway({ deviceId = 'dev-A', deviceSeed = FIXTURE_DEVICE_SEED } = {}) {
  process.env.ALLOW_TEST_KEY = '1';
  const gw = createGatewayServer({});
  const { publicKeyHex } = { publicKeyHex: publicKeyHexFromSeedHex(deviceSeed) };
  gw.registerDevice(deviceId, publicKeyHex);
  const addr = await gw.listen(0);
  const port = typeof addr === 'object' ? addr.port : addr;
  return {
    gw,
    baseUrl: `http://127.0.0.1:${port}`,
    deviceId,
    deviceSeed,
    deviceKeys: deviceKeypair(deviceSeed),
    async post(path, body, init = {}) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        body: JSON.stringify(body),
        signal: init.signal,
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    /** Fault injection: kill the next N connections mid-flight (backoff path). */
    dropNextConnection(n = 1) {
      gw.simulateDrop(n);
    },
    /**
     * Gap/corruption faults are CLIENT-driven in this harness (a tampered
     * envelope or a skipped seq is a client send, not a server state):
     * craft the mutation with `signEnvelope`/`envelopeFor` and POST it —
     * see E2/E3/E4 in drain-e2e.mts.
     */
    async close() {
      await gw.close();
      // Let the winning listen socket fully release before the next boot
      // (Windows TIME_WAIT flake guard for back-to-back scenarios).
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
