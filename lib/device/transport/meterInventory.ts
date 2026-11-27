import { isUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';
import type { MeterInventoryDevice } from '../../utils/types';
import { readRawDeviceInventory } from './managerHomeyApi';

export type MeterInventoryPublisher = (rows: MeterInventoryDevice[] | undefined) => void;

export function projectMeterDevice(raw: unknown): MeterInventoryDevice {
  const entry = isUnknownRecord(raw) ? raw : {};
  const rawCaps: unknown = entry.capabilities;
  const capabilities: string[] = Array.isArray(rawCaps)
    ? rawCaps.filter((cap): cap is string => typeof cap === 'string') : [];
  return {
    id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null,
    capabilities,
    capabilitiesReadable: Array.isArray(rawCaps) && capabilities.length === rawCaps.length,
  };
}

// Bounds weather's wait even if a streaming response keeps the SDK socket alive indefinitely.
const WAIT_LIMIT_MS = 120_000;
// Without a registry subscription Homey cannot invalidate metadata between full snapshots.
const DISCONNECTED_FRESHNESS_MS = 30_000;
async function* metadataEntries(rows: MeterInventoryDevice[]): AsyncGenerator<MeterInventoryDevice> { yield* rows; }

function sameCapabilities(device: MeterInventoryDevice | undefined, right: readonly string[]): boolean {
  return device?.capabilitiesReadable === true && device.capabilities.length === right.length
    && right.every((cap, index) => cap === device.capabilities[index]);
}

/** Device discovery metadata shared by weather backfills. Live control reads always use the device API. */
export class MeterInventory {
  private cached?: { rows: MeterInventoryDevice[]; byId: Map<string | null, MeterInventoryDevice>; receivedAt: number };
  private pending?: Promise<MeterInventoryDevice[]>;
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
        if (!sameCapabilities(byId.get(id), caps)) {
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
    if (this.cached && !sameCapabilities(this.cached.byId.get(id), caps)) this.invalidate();
    this.observed?.set(id, caps);
  }

  start(): void { this.stopped = false; }

  stop(): void {
    this.stopped = true;
    this.invalidate();
    this.finishBootstrap();
  }

  async read<T>(collect: (entries: AsyncIterable<MeterInventoryDevice>) => Promise<T>): Promise<T> {
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

  private async readOnce(): Promise<{ rows: MeterInventoryDevice[]; revision: number }> {
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

  private async load(): Promise<MeterInventoryDevice[]> {
    const publish = this.publisher();
    let keyed = false;
    const rows = await readRawDeviceInventory(async (entries) => {
      const result: MeterInventoryDevice[] = [];
      for await (const entry of entries) result.push(projectMeterDevice(entry));
      return result;
    }, 'keyed', (value) => { keyed = value; });
    if (keyed) publish(rows);
    return rows;
  }
}
