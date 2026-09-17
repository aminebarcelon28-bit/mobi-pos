// TypeScript Bindings & Contracts Mirroring src-tauri/src/contract.rs and hlc.rs
// Implements Authority ③ §4.2, Authority ② §5.2, and AGENTS.md Contract C6.

export interface CheckoutLine {
  product_id: string;
  qty: number;
  unit_cents: number;
}

export interface PaymentInfo {
  method: string;
  tendered_cents: number;
  change_cents: number;
}

export type DomainEvent =
  | { type: 'product_created'; data: { id: string; name: string; price_cents: number; sku?: string | null } }
  | { type: 'product_renamed'; data: { id: string; new_name: string } }
  | { type: 'price_changed'; data: { id: string; old_cents: number; new_cents: number } }
  | { type: 'stock_sold'; data: { product_id: string; qty: number; transaction_id: string } }
  | { type: 'stock_received'; data: { product_id: string; qty: number; supplier?: string | null } }
  | { type: 'stock_adjusted'; data: { product_id: string; delta: number; reason: string } }
  | { type: 'product_deleted'; data: { id: string } }
  | {
      type: 'checkout_completed';
      data: {
        transaction_id: string;
        lines: CheckoutLine[];
        total_cents: number;
        payment: PaymentInfo;
      };
    }
  | { type: 'device_paired'; data: { device_id: string; label: string; platform: string } }
  | { type: 'device_revoked'; data: { device_id: string } };

export interface Envelope {
  event_id: string;   // ULID
  aggregate: string;  // e.g. "product:123", "tx:456"
  hlc: string;        // canonical format "{physical_hex:016x}:{logical_hex:04x}:{device_id}"
  device_id: string;
  schema_v: number;
  event: DomainEvent;
}

export interface Committed {
  tables: string[];
}

export type SyncPhase = 'offline' | 'idle' | 'pushing' | 'pulling' | 'degraded' | 'attention';

// ============================================================================
// Hybrid Logical Clock (HLC) Utilities
// ============================================================================

export interface HlcParsed {
  physical: number; // unix timestamp in ms
  logical: number;  // 16-bit sequence counter
  device: string;   // device identifier
}

export function formatHlc(hlc: HlcParsed): string {
  const p = Math.floor(hlc.physical).toString(16).padStart(16, '0');
  const l = (hlc.logical & 0xffff).toString(16).padStart(4, '0');
  return `${p}:${l}:${hlc.device}`;
}

export function parseHlc(s: string): HlcParsed | null {
  const parts = s.split(':');
  if (parts.length < 3) return null;
  const physicalHex = parts[0];
  const logicalHex = parts[1];
  const device = parts.slice(2).join(':');
  if (!physicalHex || !logicalHex || !device) return null;
  const physical = parseInt(physicalHex, 16);
  const logical = parseInt(logicalHex, 16);
  if (isNaN(physical) || isNaN(logical)) return null;
  return { physical, logical, device };
}

export function compareHlc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class ClientHlcClock {
  private deviceId: string;
  private physical: number = 0;
  private logical: number = 0;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  public now(): string {
    const phys = Date.now();
    if (phys > this.physical) {
      this.physical = phys;
      this.logical = 0;
    } else {
      this.logical = (this.logical + 1) & 0xffff;
    }
    return formatHlc({
      physical: this.physical,
      logical: this.logical,
      device: this.deviceId,
    });
  }

  public observe(remoteHlc: string | HlcParsed): void {
    const remote = typeof remoteHlc === 'string' ? parseHlc(remoteHlc) : remoteHlc;
    if (!remote) return;

    const phys = Date.now();
    if (phys > remote.physical && phys > this.physical) {
      this.physical = phys;
      this.logical = 0;
    } else if (remote.physical > this.physical) {
      this.physical = remote.physical;
      this.logical = (remote.logical + 1) & 0xffff;
    } else if (this.physical > remote.physical) {
      this.logical = (this.logical + 1) & 0xffff;
    } else {
      this.logical = (Math.max(this.logical, remote.logical) + 1) & 0xffff;
    }
  }
}

