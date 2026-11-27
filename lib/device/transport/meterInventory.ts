import { isUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';
import { readRawDeviceInventory } from './managerHomeyApi';

type MeterDevice = { id: string | null; capabilities: (string | null)[] | null };
export type MeterInventoryPublisher = (rows: MeterDevice[] | undefined) => void;

export function projectMeterDevice(raw: unknown): MeterDevice {
  const entry = isUnknownRecord(raw) ? raw : {};
  const caps: unknown = entry.capabilities;
  return {
    id: typeof entry.id === 'string' ? entry.id : null,
    capabilities: Array.isArray(caps) ? caps.map((cap) => (typeof cap === 'string' ? cap : null)) : null,
  };
}

// Bounds weather's wait even if a streaming response keeps the SDK socket alive indefinitely.
const WAIT_LIMIT_MS = 120_000;
// Without a registry subscription Homey cannot invalidate metadata between full snapshots.
const DISCONNECTED_FRESHNESS_MS = 30_000;
async function* metadataEntries(rows: MeterDevice[]): AsyncGenerator<MeterDevice> { yield* rows; }

function sameCapabilities(left: MeterDevice['capabilities'] | undefined, right: readonly string[]): boolean {
  return left != null && left.length === right.length && right.every((cap, index) => cap === left[index]);
}

/** Device discovery metadata shared by weather backfills. Live control reads always use the device API. */
export class MeterInventory {
  private cached?: { rows: MeterDevice[]; byId: Map<string | null, MeterDevice>; receivedAt: number };
  private pending?: Promise<MeterDevice[]>;
  private bootstrap?: Promise<void>;
  private release?: () => void;
  private revision = 0;
  private observed?: Map<string, string[]>;
  private stopped = false;

  constructor(private readonly isSubscribed: () => boolean) {}

  expectBootstrap(): void {
    this.finishBootstrap();
    this.bootstrap = new Promise((resolve) => { this.release = resolve; });
  }

  finishBootstrap(): void {
    this.release?.();
    this.release = undefined;
    this.bootstrap = undefined;
  }

  private async waitForBootstrap(): Promise<void> {
    if (!this.bootstrap) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.bootstrap, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Device inventory snapshot still pending')), WAIT_LIMIT_MS);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Snapshot parsing and the metadata projection commit only after the entire response succeeds. */
  async withSnapshot<T>(read: (publish: MeterInventoryPublisher) => Promise<T>): Promise<T> {
    if (!this.bootstrap) this.expectBootstrap();
    this.pending = undefined;
    const publish = this.publisher();
    const revision = this.revision;
    const waiting = this.bootstrap;
    try {
      return await read(publish);
    } finally {
      if (this.bootstrap === waiting) this.finishBootstrap();
      if (revision === this.revision) this.observed = undefined;
    }
  }

  private publisher(): MeterInventoryPublisher {
    const revision = ++this.revision;
    this.observed = new Map();
    return (rows) => {
      if (revision !== this.revision || this.stopped) return;
      if (!rows) { this.invalidate(); return; }
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const [id, caps] of this.observed ?? []) {
        if (!sameCapabilities(byId.get(id)?.capabilities, caps)) {
          this.invalidate();
          return;
        }
      }
      this.cached = { rows, byId, receivedAt: Date.now() };
      this.observed = undefined;
    };
  }

  invalidate(): void {
    this.revision += 1;
    this.cached = undefined;
    this.pending = undefined;
    this.observed = undefined;
  }

  observeDevice(id: string, caps: string[]): void {
    if (this.cached && !sameCapabilities(this.cached.byId.get(id)?.capabilities, caps)) this.invalidate();
    this.observed?.set(id, caps);
  }

  start(): void { this.stopped = false; }

  stop(): void {
    this.stopped = true;
    this.invalidate();
    this.finishBootstrap();
  }

  async read<T>(collect: (entries: AsyncIterable<unknown>) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.waitForBootstrap();
      if (this.stopped) throw new Error('Device inventory unavailable after shutdown');
      if (this.cached && !this.isSubscribed() && Date.now() - this.cached.receivedAt >= DISCONNECTED_FRESHNESS_MS) {
        this.invalidate();
      }
      const lease = this.cached ? { rows: this.cached.rows, revision: this.revision } : await this.readOnce();
      if (lease.revision !== this.revision || this.stopped) continue;
      const result = await collect(metadataEntries(lease.rows));
      if (lease.revision === this.revision) return result;
    }
    throw new Error('Device inventory changed during discovery');
  }

  private async readOnce(): Promise<{ rows: MeterDevice[]; revision: number }> {
    this.pending ??= this.load();
    const pending = this.pending;
    const revision = this.revision;
    try {
      const rows = await pending;
      return { rows, revision };
    } finally {
      if (pending === this.pending) {
        this.pending = undefined;
        if (revision === this.revision) this.observed = undefined;
      }
    }
  }

  private async load(): Promise<MeterDevice[]> {
    const publish = this.publisher();
    let keyed = false;
    const rows = await readRawDeviceInventory(async (entries) => {
      const result: MeterDevice[] = [];
      for await (const entry of entries) result.push(projectMeterDevice(entry));
      return result;
    }, 'keyed', (value) => { keyed = value; });
    if (keyed) publish(rows);
    return rows;
  }
}
