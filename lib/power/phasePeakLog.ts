/**
 * The phase peaks log (`notes/main-fuse.md`): each episode of a phase past its
 * share of the main fuse, how long it lasted and what was drawing at the top of
 * it. Kept for a week, like the device activity log. Runtime-owned.
 */
export type PhasePeakEntry = {
  phase: 'L1' | 'L2' | 'L3';
  direction: 'import' | 'export';
  startedAtMs: number;
  durationS: number;
  peakKw: number;
  devices: readonly string[];
};

export type PhasePeakStore = { get(): unknown; set(entries: readonly PhasePeakEntry[]): void };

type PhasePeakSamplePhase = {
  phase: PhasePeakEntry['phase'];
  drawKw: number;
  breached: boolean;
  exportBreached: boolean;
};

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_DEVICES = 4;

const isPhase = (value: unknown): value is PhasePeakEntry['phase'] => (
  value === 'L1' || value === 'L2' || value === 'L3'
);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isEntry = (value: unknown): value is PhasePeakEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return isPhase(entry.phase) && (entry.direction === 'import' || entry.direction === 'export')
    && isFiniteNumber(entry.startedAtMs) && isFiniteNumber(entry.durationS) && isFiniteNumber(entry.peakKw)
    && Array.isArray(entry.devices) && entry.devices.every((name) => typeof name === 'string');
};

/** Stored entries that still read as entries; the rest are dropped. */
export const parsePhasePeaks = (raw: unknown): PhasePeakEntry[] => (Array.isArray(raw) ? raw.filter(isEntry) : []);

type OpenEpisode = PhasePeakEntry & { lastBreachAtMs: number };

/** A phase back under its target this long has really cleared; a dip in between is the same peak. */
const CLEAR_MS = 60_000;
/** Shorter than this is a blip, not a peak worth listing. */
const MIN_EPISODE_S = 30;
/** No sample for this long: the episode cannot be said to have run across the gap. */
const SAMPLE_GAP_MS = 180_000;
const WRITE_INTERVAL_MS = 60_000;

export class PhasePeakLog {
  private entries: PhasePeakEntry[] = [];

  private readonly open = new Map<string, OpenEpisode>();

  private store: PhasePeakStore | null = null;

  private lastSampleAtMs: number | null = null;

  private lastWriteAtMs = Number.NEGATIVE_INFINITY;

  private dirty = false;

  bindStore(store: PhasePeakStore): void {
    this.store = store;
    this.entries = parsePhasePeaks(store.get());
  }

  recent(nowMs: number): readonly PhasePeakEntry[] {
    return this.entries.filter((entry) => nowMs - entry.startedAtMs <= RETENTION_MS);
  }

  /** One sample: extend or open each breached phase's episode, and close the ones that have ended. */
  observe(atMs: number, phases: readonly PhasePeakSamplePhase[], drawingDevices: readonly string[]): void {
    if (this.lastSampleAtMs !== null && atMs - this.lastSampleAtMs > SAMPLE_GAP_MS) {
      const openKeys = Array.from(this.open.keys());
      for (const key of openKeys) this.close(key, atMs);
    }
    this.lastSampleAtMs = atMs;
    for (const phase of phases) {
      if (!phase.breached && !phase.exportBreached) continue;
      const identity = { phase: phase.phase, direction: phase.breached ? 'import' : 'export' } as const;
      this.extend(`${phase.phase}:${identity.direction}`, identity, atMs, Math.abs(phase.drawKw), drawingDevices);
    }
    const ended = Array.from(this.open.entries()).filter(([, episode]) => atMs - episode.lastBreachAtMs >= CLEAR_MS);
    for (const [key] of ended) this.close(key, atMs);
    this.flush(atMs);
  }

  private extend(
    key: string,
    identity: Pick<PhasePeakEntry, 'phase' | 'direction'>,
    atMs: number,
    magnitudeKw: number,
    drawingDevices: readonly string[],
  ): void {
    const episode = this.open.get(key);
    const devices = drawingDevices.slice(0, MAX_DEVICES);
    if (episode === undefined) {
      this.open.set(key, {
        ...identity, startedAtMs: atMs, lastBreachAtMs: atMs, durationS: 0, peakKw: magnitudeKw, devices,
      });
      return;
    }
    const risen = magnitudeKw > episode.peakKw;
    this.open.set(key, {
      ...episode,
      lastBreachAtMs: atMs,
      durationS: Math.round((atMs - episode.startedAtMs) / 1000),
      peakKw: risen ? magnitudeKw : episode.peakKw,
      devices: risen ? devices : episode.devices,
    });
  }

  private close(key: string, atMs: number): void {
    const episode = this.open.get(key);
    if (episode === undefined) return;
    this.open.delete(key);
    if (episode.durationS < MIN_EPISODE_S) return;
    const { lastBreachAtMs: _lastBreachAtMs, ...entry } = episode;
    this.entries = [...this.entries, entry]
      .filter((kept) => atMs - kept.startedAtMs <= RETENTION_MS)
      .slice(-MAX_ENTRIES);
    this.dirty = true;
  }

  private flush(atMs: number): void {
    if (!this.dirty || atMs - this.lastWriteAtMs < WRITE_INTERVAL_MS) return;
    this.dirty = false;
    this.lastWriteAtMs = atMs;
    this.store?.set(this.entries);
  }
}
