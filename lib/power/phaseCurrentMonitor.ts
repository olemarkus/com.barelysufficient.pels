import { directionalPhaseAmps, type PhaseDirection, type PhaseLoad, type PhaseReading } from './phaseReading';
import { POWER_SAMPLE_STALE_THRESHOLD_MS } from './sampleFreshness';

type PhaseName = PhaseLoad['phase'];
type HealthyPhases = Extract<PhaseReading, { kind: 'healthy' }>;

export type PhaseCurrentLimit = {
  readonly phase: PhaseName | 'any';
  readonly direction: PhaseDirection;
  readonly limitA: number;
};

export type PhaseCurrentWatch = PhaseCurrentLimit & { readonly holdSeconds: number };

type CrossingEdge = 'above' | 'back_below';

export type PhaseCurrentCrossing = {
  readonly edge: CrossingEdge;
  readonly watch: PhaseCurrentWatch;
  readonly load: PhaseLoad;
  readonly elapsedSeconds: number;
};

type Episode =
  | { state: 'idle' }
  | { state: 'waiting'; sinceMs: number }
  | { state: 'above'; sinceMs: number; phase: PhaseName };

type WatchEntry = { watch: PhaseCurrentWatch; episode: Episode };

const CLEAR_MARGIN_A = 1;
const PHASE_INDEX: Record<PhaseName, 0 | 1 | 2> = { L1: 0, L2: 1, L3: 2 };

export const phaseCurrentWatchKey = (watch: PhaseCurrentWatch): string => (
  `${watch.phase}:${watch.direction}:${watch.limitA}:${watch.holdSeconds}`
);

function highestCurrentPhase(reading: HealthyPhases, limit: PhaseCurrentLimit): PhaseLoad {
  const { phases } = reading;
  if (limit.phase !== 'any') return phases[PHASE_INDEX[limit.phase]];
  const amps = (load: PhaseLoad) => directionalPhaseAmps(load, limit.direction);
  let highest = phases[0];
  for (const load of phases) {
    if (amps(load) > amps(highest)) highest = load;
  }
  return highest;
}

export function isPhaseCurrentAbove(reading: PhaseReading, limit: PhaseCurrentLimit, nowMs: number): boolean {
  if (reading.kind !== 'healthy' || reading.basis !== 'active_power'
    || nowMs - reading.acceptedAtMs > POWER_SAMPLE_STALE_THRESHOLD_MS) {
    throw new Error('PELS needs a fresh phase meter reading with import and export direction.');
  }
  return directionalPhaseAmps(highestCurrentPhase(reading, limit), limit.direction) > limit.limitA;
}

/** One episode per saved filter. "Any" follows the highest load across all three phases. */
export class PhaseCurrentMonitor {
  private readonly watches: Record<CrossingEdge, Map<string, PhaseCurrentWatch>> = {
    above: new Map(), back_below: new Map(),
  };

  private readonly refreshSequence = { above: 0, back_below: 0 };

  private readonly entries = new Map<string, WatchEntry>();

  private lastAcceptedAtMs = -Infinity;

  constructor(private readonly onCrossing: (crossing: PhaseCurrentCrossing) => void) {}

  async refresh(edge: CrossingEdge, read: () => Promise<readonly PhaseCurrentWatch[] | null>): Promise<void> {
    const sequence = ++this.refreshSequence[edge];
    const watches = await read();
    if (watches === null || sequence !== this.refreshSequence[edge]) return;
    this.watches[edge] = new Map(watches.map((watch) => [phaseCurrentWatchKey(watch), watch]));
    this.reconcileWatches();
  }

  private reconcileWatches(): void {
    const merged = new Map([...this.watches.above, ...this.watches.back_below]);
    for (const key of this.entries.keys()) {
      if (!merged.has(key)) this.entries.delete(key);
    }
    for (const [key, watch] of merged) {
      if (!this.entries.has(key)) this.entries.set(key, { watch, episode: { state: 'idle' } });
    }
  }

  reset(): void {
    this.lastAcceptedAtMs = -Infinity;
    for (const entry of this.entries.values()) entry.episode = { state: 'idle' };
  }

  observe(reading: PhaseReading): void {
    if (reading.kind !== 'healthy' || reading.basis !== 'active_power') {
      this.cancelPendingHolds();
      return;
    }
    if (reading.acceptedAtMs - this.lastAcceptedAtMs > POWER_SAMPLE_STALE_THRESHOLD_MS) {
      this.cancelPendingHolds();
    }
    this.lastAcceptedAtMs = reading.acceptedAtMs;
    for (const entry of this.entries.values()) entry.episode = this.observeWatch(entry, reading);
  }

  private cancelPendingHolds(): void {
    for (const entry of this.entries.values()) {
      if (entry.episode.state === 'waiting') entry.episode = { state: 'idle' };
    }
  }

  private observeWatch(entry: WatchEntry, reading: HealthyPhases): Episode {
    const { watch, episode } = entry;
    const load = highestCurrentPhase(reading, watch);
    const currentA = directionalPhaseAmps(load, watch.direction);
    if (episode.state === 'above') {
      if (currentA <= watch.limitA - CLEAR_MARGIN_A) {
        const lastLeadingPhase = reading.phases[PHASE_INDEX[episode.phase]];
        this.emit('back_below', watch, lastLeadingPhase, reading.acceptedAtMs - episode.sinceMs);
        return { state: 'idle' };
      }
      return { ...episode, phase: load.phase };
    }
    if (currentA <= watch.limitA) return { state: 'idle' };
    const sinceMs = episode.state === 'waiting' ? episode.sinceMs : reading.acceptedAtMs;
    const elapsedMs = reading.acceptedAtMs - sinceMs;
    if (elapsedMs < watch.holdSeconds * 1000) return { state: 'waiting', sinceMs };
    this.emit('above', watch, load, elapsedMs);
    return { state: 'above', sinceMs, phase: load.phase };
  }

  private emit(edge: CrossingEdge, watch: PhaseCurrentWatch, load: PhaseLoad, elapsedMs: number): void {
    if (!this.watches[edge].has(phaseCurrentWatchKey(watch))) return;
    this.onCrossing({ edge, watch, load, elapsedSeconds: Math.floor(elapsedMs / 1000) });
  }
}
