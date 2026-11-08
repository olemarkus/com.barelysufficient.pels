import type { PhaseFootprint, PhaseName } from '../../packages/planner-types/src/phaseFootprint';

/**
 * Learns which phases a device loads from PELS's own confirmed steps against
 * the meter's per-phase reading (`notes/main-fuse.md`). A leaf: the samples are
 * fed in by setup and it reads nothing itself.
 */

export type LearnedVote = PhaseName | 'all_three';

export type PhaseLearningDeviceSample = {
  deviceId: string;
  drawKw: number;
  isEvCharger: boolean;
  /** An EV charger with a car connected. Ignored for every other device. */
  evSessionActive: boolean;
  /** PELS's own last command to this device, if it has issued one. */
  lastCommandAtMs: number | undefined;
};

export type PhaseLearningSample = {
  atMs: number;
  phasesKw: readonly [number, number, number];
  devices: readonly PhaseLearningDeviceSample[];
};

type LearnedDevice = { votes: readonly LearnedVote[]; settled: LearnedVote | null };
export type PersistedPhaseLearning = Readonly<Record<string, LearnedDevice>>;

/** Where the learning is kept; setup binds it to the app's settings. */
export type PhaseLearningStore = { get(): unknown; set(learning: PersistedPhaseLearning): void };

const HISTORY_MS = 180_000;
const WINDOW_BEFORE_MS = 40_000;
const LAG_BEFORE_MS = 5_000;
const LAG_AFTER_MS = 20_000;
const WINDOW_AFTER_MS = 30_000;
const MIN_WINDOW_SAMPLES = 2;
const STABLE_SPREAD_KW = 0.3;
const MIN_STEP_KW = 0.5;
const NEAR_IDLE_KW = 0.15;
const OTHER_DEVICE_CHANGE_KW = 0.2;
const SINGLE_PHASE_SHARE = 0.7;
const LITTLE_SHARE = 0.15;
const ALL_THREE_MIN_SHARE = 0.2;
const ALL_THREE_MAX_SHARE = 0.47;
const MAX_VOTES = 10;
const SETTLE_VOTES = 5;
const SETTLE_MAJORITY = 0.8;
const DISSENTING_VOTES = 3;

const PHASE_NAMES: readonly PhaseName[] = ['L1', 'L2', 'L3'];
const VOTES: readonly LearnedVote[] = [...PHASE_NAMES, 'all_three'];

const isVote = (value: unknown): value is LearnedVote => VOTES.includes(value as LearnedVote);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const parseEntry = (value: unknown): LearnedDevice | null => {
  if (!isRecord(value) || !Array.isArray(value.votes) || !value.votes.every(isVote)) return null;
  if (value.settled !== null && !isVote(value.settled)) return null;
  return { votes: value.votes.slice(-MAX_VOTES), settled: value.settled };
};

/** The stored learning, validated entry by entry: a bad entry is forgotten, its neighbours are not. */
export function parsePhaseLearning(raw: unknown): PersistedPhaseLearning {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([deviceId, value]) => {
    const entry = parseEntry(value);
    return entry === null ? [] : [[deviceId, entry] as const];
  }));
}

const average = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

const toFootprint = (vote: LearnedVote): PhaseFootprint => (
  vote === 'all_three' ? { kind: 'all_three' } : { kind: 'single', phase: vote }
);

/** The vote a step's per-phase changes make, or null when they say neither one phase nor all three. */
export function classifyStep(
  deviceDeltaKw: number,
  phaseDeltasKw: readonly [number, number, number],
): LearnedVote | null {
  const magnitude = Math.abs(deviceDeltaKw);
  const shares = phaseDeltasKw.map((delta) => (Math.sign(deviceDeltaKw) * delta) / magnitude);
  const largest = Math.max(...shares);
  const index = shares.indexOf(largest);
  const othersLittle = shares.every((share, position) => position === index || Math.abs(share) <= LITTLE_SHARE);
  if (largest >= SINGLE_PHASE_SHARE && othersLittle) return PHASE_NAMES[index] ?? null;
  return shares.every((share) => share >= ALL_THREE_MIN_SHARE && share <= ALL_THREE_MAX_SHARE) ? 'all_three' : null;
}

const settleVotes = (votes: readonly LearnedVote[]): LearnedVote | null => {
  if (votes.length < SETTLE_VOTES) return null;
  const leader = VOTES
    .map((vote) => ({ vote, count: votes.filter((entry) => entry === vote).length }))
    .sort((a, b) => b.count - a.count)[0];
  return leader !== undefined && leader.count / votes.length >= SETTLE_MAJORITY ? leader.vote : null;
};

/** One vote applied: a contradicted settled answer is dropped and the dissent starts over. */
const withVote = (device: LearnedDevice, vote: LearnedVote): LearnedDevice => {
  const votes = [...device.votes, vote].slice(-MAX_VOTES);
  if (device.settled !== null) {
    const recent = votes.slice(-DISSENTING_VOTES);
    const contradicted = recent.length === DISSENTING_VOTES && recent.every((entry) => entry !== device.settled);
    return contradicted ? { votes: recent, settled: null } : { votes, settled: device.settled };
  }
  return { votes, settled: settleVotes(votes) };
};

type PendingStep = { deviceId: string; commandAtMs: number };

export class PhaseFootprintLearner {
  private samples: PhaseLearningSample[] = [];

  private pending: PendingStep[] = [];

  private readonly lastCommand = new Map<string, number>();

  private readonly knownDevices = new Set<string>();

  private persisted: Record<string, LearnedDevice> = {};

  /** EV charger votes live only for the session they were taken in, and are never stored. */
  private readonly sessions = new Map<string, LearnedDevice>();

  private store: PhaseLearningStore | null = null;

  /** Adopt what the store holds; later votes are written to it. */
  bindStore(store: PhaseLearningStore): void {
    this.store = store;
    this.persisted = { ...parsePhaseLearning(store.get()) };
  }

  /** What has been settled for this device: a stored fact, or this EV session's. */
  learnedFootprint(deviceId: string): PhaseFootprint | undefined {
    const settled = (this.sessions.get(deviceId) ?? this.persisted[deviceId])?.settled;
    return settled === null || settled === undefined ? undefined : toFootprint(settled);
  }

  /** One accepted meter sample: remember it, note new commands, and vote on any step whose windows are complete. */
  observe(sample: PhaseLearningSample): void {
    this.samples = [...this.samples, sample].filter((entry) => sample.atMs - entry.atMs <= HISTORY_MS);
    for (const device of sample.devices) this.noteDevice(device);
    const due = this.pending.filter((step) => sample.atMs >= step.commandAtMs + LAG_AFTER_MS + WINDOW_AFTER_MS);
    if (due.length === 0) return;
    this.pending = this.pending.filter((step) => !due.includes(step));
    for (const step of due) this.judgeStep(step, sample);
  }

  private noteDevice(device: PhaseLearningDeviceSample): void {
    if (device.isEvCharger && !device.evSessionActive) this.sessions.delete(device.deviceId);
    const { deviceId, lastCommandAtMs } = device;
    // A device's first sample only sets the baseline: its stamp may be from before this run.
    const firstSeen = !this.knownDevices.has(deviceId);
    this.knownDevices.add(deviceId);
    if (lastCommandAtMs === undefined) return;
    const seen = this.lastCommand.get(deviceId);
    this.lastCommand.set(deviceId, lastCommandAtMs);
    if (!firstSeen && (seen === undefined || lastCommandAtMs > seen)) {
      this.pending.push({ deviceId, commandAtMs: lastCommandAtMs });
    }
  }

  private windowsFor(step: PendingStep): { before: PhaseLearningSample[]; after: PhaseLearningSample[] } | null {
    const { commandAtMs } = step;
    const before = this.samples.filter((entry) => (
      entry.atMs >= commandAtMs - WINDOW_BEFORE_MS && entry.atMs < commandAtMs - LAG_BEFORE_MS
    ));
    const after = this.samples.filter((entry) => (
      entry.atMs >= commandAtMs + LAG_AFTER_MS && entry.atMs <= commandAtMs + LAG_AFTER_MS + WINDOW_AFTER_MS
    ));
    return before.length < MIN_WINDOW_SAMPLES || after.length < MIN_WINDOW_SAMPLES ? null : { before, after };
  }

  private judgeStep(step: PendingStep, latest: PhaseLearningSample): void {
    const windows = this.windowsFor(step);
    if (windows === null) return;
    const { before, after } = windows;
    const deviceDraw = (entries: readonly PhaseLearningSample[]): number[] => entries.flatMap((entry) => (
      entry.devices.filter((device) => device.deviceId === step.deviceId).map((device) => device.drawKw)
    ));
    const drawBefore = deviceDraw(before);
    const drawAfter = deviceDraw(after);
    if (drawBefore.length === 0 || drawAfter.length === 0) return;
    if (!isStable(drawBefore) || !isStable(drawAfter) || !phasesStable(before) || !phasesStable(after)) return;
    const deviceDeltaKw = average(drawAfter) - average(drawBefore);
    // Only a whole on or off says where the device sits: one rung of a device with
    // an element per phase moves a single phase and would settle it there.
    const wholeTransition = Math.min(average(drawBefore), average(drawAfter)) <= NEAR_IDLE_KW;
    if (!wholeTransition || Math.abs(deviceDeltaKw) < MIN_STEP_KW || this.isContaminated(step, before, after)) return;
    const phaseDeltasKw = [0, 1, 2].map((index) => (
      average(after.map((entry) => entry.phasesKw[index] ?? 0))
        - average(before.map((entry) => entry.phasesKw[index] ?? 0))
    )) as unknown as readonly [number, number, number];
    const vote = classifyStep(deviceDeltaKw, phaseDeltasKw);
    const device = latest.devices.find((entry) => entry.deviceId === step.deviceId);
    if (vote !== null && device !== undefined) this.applyVote(device, vote);
  }

  /** Another command, or another managed device moving, in the span means the phases cannot be read as this step. */
  private isContaminated(
    step: PendingStep,
    before: readonly PhaseLearningSample[],
    after: readonly PhaseLearningSample[],
  ): boolean {
    const startMs = before[0]?.atMs ?? step.commandAtMs;
    const endMs = after[after.length - 1]?.atMs ?? step.commandAtMs;
    const otherCommanded = [...this.lastCommand].some(([deviceId, atMs]) => (
      deviceId !== step.deviceId && atMs >= startMs && atMs <= endMs
    ));
    if (otherCommanded) return true;
    const span = [...before, ...after];
    const deviceIds = new Set(span.flatMap((entry) => entry.devices.map((device) => device.deviceId)));
    deviceIds.delete(step.deviceId);
    return [...deviceIds].some((deviceId) => {
      const draws = span.flatMap((entry) => (
        entry.devices.filter((device) => device.deviceId === deviceId).map((device) => device.drawKw)
      ));
      return draws.length > 0 && spread(draws) >= OTHER_DEVICE_CHANGE_KW;
    });
  }

  private applyVote(device: PhaseLearningDeviceSample, vote: LearnedVote): void {
    const { deviceId } = device;
    if (device.isEvCharger) {
      if (device.evSessionActive) {
        this.sessions.set(deviceId, withVote(this.sessions.get(deviceId) ?? { votes: [], settled: null }, vote));
      }
      return;
    }
    this.persisted = {
      ...this.persisted,
      [deviceId]: withVote(this.persisted[deviceId] ?? { votes: [], settled: null }, vote),
    };
    this.store?.set(this.persisted);
  }
}

function isStable(values: readonly number[]): boolean {
  return spread(values) <= STABLE_SPREAD_KW;
}

function phasesStable(entries: readonly PhaseLearningSample[]): boolean {
  return [0, 1, 2].every((index) => isStable(entries.map((entry) => entry.phasesKw[index] ?? 0)));
}
