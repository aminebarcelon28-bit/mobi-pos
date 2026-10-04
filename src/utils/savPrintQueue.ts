/**
 * savPrintQueue — idempotent, abortable SAV print orchestration.
 *
 * Why this exists: the intake flow used to fire three sequential
 * `setTimeout(350)`-spaced native prints. That pattern has three failure
 * modes, all of them money/legal-adjacent:
 *   1. A timer that fires after the operator changed the order prints STALE
 *      content (e.g. the pre-edit damage constat).
 *   2. Two overlapping triads can interleave bytes into the same 80mm spooler,
 *      producing a garbled ticket.
 *   3. Nothing could be cancelled — closing the modal left orphaned prints.
 *
 * This queue fixes all three:
 *   • One job per (orderId, kind) key at a time — a repeat click is a NO-OP,
 *     never a duplicate ticket.
 *   • Each job carries an AbortController; `cancel(orderId)` / `cancelAll()`
 *     stop queued work and let the caller observe the abort.
 *   • Jobs run strictly in FIFO order and each awaits the previous, so the
 *     spooler never sees interleaved bytes.
 */

export type SavPrintMedium = 'thermal80' | 'a4' | 'mobileSheet';

export interface SavPrintRequest {
  orderId: string;
  /** Logical document, part of the idempotency key. */
  kind: 'voucher' | 'workshop' | 'chassisTag' | 'restitution' | 'quote' | 'a4';
  medium: SavPrintMedium;
  title: string;
  /** Produces the bytes/text to print. Must be abort-aware. */
  produce: (signal: AbortSignal) => Promise<boolean>;
}

export interface SavPrintOutcome {
  orderId: string;
  kind: SavPrintRequest['kind'];
  status: 'printed' | 'aborted' | 'failed' | 'superseded';
  error?: string;
}

type Job = {
  request: SavPrintRequest;
  controller: AbortController;
  resolve: (o: SavPrintOutcome) => void;
};

const inflight = new Map<string, Promise<SavPrintOutcome>>();
const queue: Job[] = [];
/** The single job currently being produced (jobs are strictly serial). */
let activeJob: Job | null = null;
let draining = false;

function keyOf(r: Pick<SavPrintRequest, 'orderId' | 'kind'>): string {
  return `${r.orderId}::${r.kind}`;
}

function settle(job: Job, outcome: SavPrintOutcome): void {
  inflight.delete(keyOf(job.request));
  job.resolve(outcome);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      activeJob = job;
      if (job.controller.signal.aborted) {
        activeJob = null;
        settle(job, {
          orderId: job.request.orderId,
          kind: job.request.kind,
          status: 'aborted',
        });
        continue;
      }
      try {
        const ok = await job.request.produce(job.controller.signal);
        activeJob = null;
        // A cancel that landed mid-produce must win over the producer's own
        // verdict: the ticket may already be on the spooler, and reporting
        // "printed" after the operator walked away hides a partial print.
        if (job.controller.signal.aborted) {
          settle(job, {
            orderId: job.request.orderId,
            kind: job.request.kind,
            status: 'aborted',
          });
        } else {
          settle(job, {
            orderId: job.request.orderId,
            kind: job.request.kind,
            status: ok ? 'printed' : 'failed',
          });
        }
      } catch (err) {
        activeJob = null;
        settle(job, {
          orderId: job.request.orderId,
          kind: job.request.kind,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    activeJob = null;
    draining = false;
  }
}

/**
 * Enqueue a print job. Returns the SAME promise when an identical job is
 * already in flight (true idempotency: double-tap cannot double-print).
 */
export function enqueueSavPrint(request: SavPrintRequest): Promise<SavPrintOutcome> {
  const key = keyOf(request);
  const existing = inflight.get(key);
  if (existing) return existing;

  const controller = new AbortController();
  let resolve!: (o: SavPrintOutcome) => void;
  const promise = new Promise<SavPrintOutcome>((r) => {
    resolve = r;
  });
  inflight.set(key, promise);

  queue.push({ request, controller, resolve });
  void drain();

  // Release the key once settled, so a LATER legitimate reprint works.
  void promise.finally(() => inflight.delete(key));
  return promise;
}

/**
 * Cancel every queued/in-flight job for one order (modal closed, edit saved).
 *
 * A queued job is removed AND settled here — a splice without a resolve would
 * leave its caller awaiting a promise that can never fire, and the modal would
 * hang its own buttons on a print it just cancelled. The running job is NOT
 * spliced: `drain` owns it and will settle it as `aborted` once the producer
 * returns.
 */
export function cancelSavPrints(orderId: string): void {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const job = queue[i];
    if (job.request.orderId !== orderId) continue;
    queue.splice(i, 1);
    job.controller.abort();
    settle(job, {
      orderId: job.request.orderId,
      kind: job.request.kind,
      status: 'aborted',
    });
  }
  if (activeJob && activeJob.request.orderId === orderId) {
    activeJob.controller.abort();
  }
}

/** Cancel everything (route change, sign-out). */
export function cancelAllSavPrints(): void {
  for (const job of queue.splice(0)) {
    job.controller.abort();
    settle(job, {
      orderId: job.request.orderId,
      kind: job.request.kind,
      status: 'aborted',
    });
  }
  activeJob?.controller.abort();
}

/** Test/introspection seam. */
export function pendingSavPrintCount(): number {
  return queue.length;
}

export function isSavPrintInFlight(orderId: string, kind?: SavPrintRequest['kind']): boolean {
  for (const key of inflight.keys()) {
    if (kind ? key === `${orderId}::${kind}` : key.startsWith(`${orderId}::`)) return true;
  }
  return false;
}

/**
 * Abortable sleep — the fixed inter-job delay between two thermal sheets.
 * Kept abort-aware so a cancel mid-gap stops the next print immediately.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}