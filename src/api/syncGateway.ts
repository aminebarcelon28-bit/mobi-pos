import { invokeCommand } from '../platform/invoke';

export interface GatewayMutation {
  seqNo: number;
  ticketId: string;
  payload: string;
  deviceSignature: string;
  /**
   * Verbatim signed bytes (`ticket|refund|net|device|seq|verified`, v112
   * envelope column). The gateway verifies `deviceSignature` over EXACTLY
   * this string — never a reconstruction — so field-mapping drift cannot
   * silently invalidate proofs.
   */
  envelope: string;
}

export interface SyncGatewayRequest {
  deviceId: string;
  mutations: GatewayMutation[];
}

/**
 * Gateway ACK surface. `serverTimeToken` is the OPAQUE `SERVERTIME_V1`
 * envelope string (`prefix.payload.sig`) — never a re-encoded object:
 * re-serialization would alter the exact bytes the signature covers. The
 * worker forwards it verbatim to `ingest_signed_server_time`.
 */
export interface SyncGatewayResponse {
  ackSeqNos: number[];
  serverTimeToken?: string;
  rejectedSeqNos?: Array<{ seqNo: number; reason: string }>;
}

export type GatewayFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

const INGEST_PATH = '/api/v1/sync/ingest';
const POST_TIMEOUT_MS = 30_000;

/** Configured merchant gateway base URL (`app_settings sync.gateway_url`), or null. */
export async function getGatewayBaseUrl(): Promise<string | null> {
  try {
    const { getLocalDb } = await import('../db/sqlPluginAdapter');
    const db = await getLocalDb();
    const rows = (await db
      .select("SELECT value_json FROM app_settings WHERE key = 'sync.gateway_url'")
      .catch(() => [])) as Array<{ value_json?: string | null }>;
    const raw = rows?.[0]?.value_json;
    if (!raw) return null;
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      // Bare (unquoted) URL string — accept as-is.
    }
    const url = String(parsed ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) return null;
    return url;
  } catch {
    return null;
  }
}

function parseGatewayResponse(raw: unknown): SyncGatewayResponse {
  const r = raw as Record<string, unknown>;
  if (!r || !Array.isArray(r.ackSeqNos) || !r.ackSeqNos.every((n) => Number.isInteger(n))) {
    throw new Error('GATEWAY_UNAVAILABLE:malformed_ack');
  }
  const out: SyncGatewayResponse = { ackSeqNos: [...(r.ackSeqNos as number[])] };
  if (r.serverTimeToken !== undefined) {
    if (typeof r.serverTimeToken !== 'string' || r.serverTimeToken.split('.').length !== 3) {
      throw new Error('GATEWAY_UNAVAILABLE:malformed_time_token');
    }
    out.serverTimeToken = r.serverTimeToken;
  }
  if (r.rejectedSeqNos !== undefined) {
    if (
      !Array.isArray(r.rejectedSeqNos) ||
      !r.rejectedSeqNos.every(
        (e) => e && typeof (e as { seqNo?: unknown }).seqNo === 'number' && typeof (e as { reason?: unknown }).reason === 'string'
      )
    ) {
      throw new Error('GATEWAY_UNAVAILABLE:malformed_rejections');
    }
    out.rejectedSeqNos = (r.rejectedSeqNos as Array<{ seqNo: number; reason: string }>).map((e) => ({
      seqNo: e.seqNo,
      reason: e.reason,
    }));
  }
  return out;
}

/**
 * POST one signed batch. Throws `GATEWAY_UNAVAILABLE:*` on transport failure
 * and `SEQUENCE_GAP_DETECTED:*` when the gateway reports a hole — the drain
 * worker maps both to reset + backoff, never to silent drops.
 */
export async function postMutations(
  baseUrl: string,
  req: SyncGatewayRequest,
  fetchFn: GatewayFetch = fetch as unknown as GatewayFetch
): Promise<SyncGatewayResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${baseUrl}${INGEST_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // Native cursor shape (expected_X_received_Y) when the server sends
      // it; the worker keys off the prefix, ops read the detail.
      const detail =
        typeof body.reason === 'string'
          ? body.reason
          : body.expectedSeq !== undefined
            ? `expected_${String(body.expectedSeq)}_received_${String((body as { receivedSeq?: unknown }).receivedSeq)}`
            : 'conflict';
      throw new Error(`SEQUENCE_GAP_DETECTED:${detail}`);
    }
    if (res.status < 200 || res.status >= 300) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const reason = typeof body.error === 'string' ? `:${body.error}` : '';
      throw new Error(`GATEWAY_UNAVAILABLE:http_${res.status}${reason}`);
    }
    return parseGatewayResponse(await res.json());
  } catch (e) {
    if (e instanceof Error && /^(SEQUENCE_GAP_DETECTED|GATEWAY_UNAVAILABLE)/.test(e.message)) throw e;
    throw new Error(`GATEWAY_UNAVAILABLE:${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Time piggyback: forward the gateway token VERBATIM into the native
 * ingestion path. A bad/expired token warns (telemetry) and never throws —
 * batch ACKs already processed must not be unwound over a clock opinion.
 */
export async function ingestGatewayTimeToken(token: string): Promise<boolean> {
  try {
    await invokeCommand('ingest_signed_server_time', { assertion: token }, 'INTERNAL_ERROR');
    return true;
  } catch (e) {
    console.warn('[sync-gateway] Server time token refused (batch unaffected):', e);
    return false;
  }
}
