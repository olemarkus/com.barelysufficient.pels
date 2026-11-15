/**
 * The hard-cap shortfall log: each time PELS had eased off everything it could
 * and the home still went past the hard cap (`CapacityGuard` opening an
 * incident), when it happened, the hard cap it happened under and what the
 * devices PELS does not control drew then. Kept for a week, like the phase
 * peaks log, so the settings UI can tell a home that meets its cap now and then
 * from one that cannot meet it at all. Runtime-owned; Main home only.
 */
export type HardCapShortfallEntry = {
  atMs: number;
  /** The configured hard cap when the incident opened; a changed cap starts a new record. */
  hardCapKw: number;
  /** What devices PELS does not control drew when the incident opened. */
  uncontrolledW: number;
};

export type HardCapShortfallStore = { get(): unknown; set(entries: readonly HardCapShortfallEntry[]): void };

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 100;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isEntry = (value: unknown): value is HardCapShortfallEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return isFiniteNumber(entry.atMs) && isFiniteNumber(entry.hardCapKw) && entry.hardCapKw > 0
    && isFiniteNumber(entry.uncontrolledW) && entry.uncontrolledW >= 0;
};

/** Stored entries that still read as entries; the rest are dropped. */
export const parseHardCapShortfalls = (raw: unknown): HardCapShortfallEntry[] => (
  Array.isArray(raw) ? raw.filter(isEntry) : []
);

export class HardCapShortfallLog {
  private entries: HardCapShortfallEntry[] = [];

  private store: HardCapShortfallStore | null = null;

  private readHardCapKw: () => number = () => 0;

  /** Until bound, nothing is recorded: only Main keeps the log. */
  bindStore(store: HardCapShortfallStore, readHardCapKw: () => number): void {
    this.store = store;
    this.readHardCapKw = readHardCapKw;
    this.entries = parseHardCapShortfalls(store.get());
  }

  recent(nowMs: number): readonly HardCapShortfallEntry[] {
    return this.entries.filter((entry) => nowMs - entry.atMs <= RETENTION_MS);
  }

  /** An incident opened. Written at once: incidents are minutes apart at the closest. */
  record(atMs: number, uncontrolledW: number): void {
    if (this.store === null) return;
    const hardCapKw = this.readHardCapKw();
    if (!isFiniteNumber(hardCapKw) || hardCapKw <= 0) return;
    this.entries = [...this.recent(atMs), { atMs, hardCapKw, uncontrolledW: Math.max(0, Math.round(uncontrolledW)) }]
      .slice(-MAX_ENTRIES);
    this.store.set(this.entries);
  }
}
