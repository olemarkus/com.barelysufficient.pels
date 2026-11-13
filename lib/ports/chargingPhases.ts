import type {
  ChargingPhaseCount, ChargingPhaseRead,
} from '../../packages/contracts/src/chargingPhases';
import type {
  ChargingPhaseCandidate, ChargingPhaseEnvelope, ChargingPhasePoint, ChargingPhaseReservation,
} from '../../packages/planner-types/src/chargingPhases';
import type { ChargingPhaseDecision } from '../planContract/chargingPhaseDecision';
export type { ChargingPhaseDecision } from '../planContract/chargingPhaseDecision';

/** Independently dated physical power on each charger phase, before house-phase mapping. */
export type ChargingPhasePower = { watts: number; observedAtMs: number };
/** Shared noise band for admitted independent charging-phase power evidence. */
export const CHARGING_PHASE_POWER_NOISE_W = 100;

/** An admitted device read. Capability publication acknowledges a setting, never physical convergence. */
export type ChargingPhaseDevice = {
  deviceId: string;
  available: boolean;
  connected: boolean;
  managed: boolean;
  controlEnabled: boolean;
  forceSinglePhase: boolean;
  forceSinglePhaseObservedAtMs: number;
  currentLimitA: number;
  minimumCurrentA: number;
  maximumCurrentA: number;
  configuredPhases: ChargingPhaseCount;
  /** Producer-resolved effective geometry, shared with the live charging ladder. */
  planningPhases: ChargingPhaseCount;
  /** Latest coherent nonrevoked drawing; idle has no current drawing mode. */
  drawingPhases: ChargingPhaseCount | undefined;
  powers: readonly [ChargingPhasePower, ChargingPhasePower, ChargingPhasePower];
  totalPower: ChargingPhasePower;
};

/** A coherent owner read consumed by planner-input production and execution. */
export type ChargingPhasePlanningRead = {
  candidates: readonly ChargingPhaseCandidate[];
  reservations: readonly ChargingPhaseReservation[];
  releases: readonly ChargingPhaseDecision[];
  observations: readonly (ChargingPhasePoint & { deviceId: string })[];
  permittedEnvelopes: ReadonlyMap<string, readonly ChargingPhaseEnvelope[]>;
  continuations: readonly Extract<ChargingPhaseDecision, { kind: 'switch' }>[];
};

/** Channel-blind commands. Firmware owns the physical phase transition. */
export type ChargingPhaseCommandAuthority = { isCurrent(): boolean };

/** Notifications describe the nested binary pause independently of the later phase write. */
export type ChargingPhasePauseLifecycle = {
  onStarting(atMs: number): void;
  onAccepted(): void;
  onFailed(error: unknown): void;
};

export type ChargingPhasePauseRecording = {
  forDevice(deviceId: string): ChargingPhasePauseLifecycle;
};

export type ChargingPhaseCommand = (
  | { kind: 'charging_phase'; deviceId: string; phases: ChargingPhaseCount; currentA: number }
  | { kind: 'charging_phase_prepare'; deviceId: string; currentA: number }
  | { kind: 'charging_phase_release'; deviceId: string; forceSinglePhase: boolean;
      pauseLifecycle: ChargingPhasePauseLifecycle }
) & { authority: ChargingPhaseCommandAuthority };

export type ChargingPhaseActuation = {
  apply(command: ChargingPhaseCommand): Promise<{ requested: boolean }>;
};

export type ChargingPhaseSource = {
  readDevices(): readonly ChargingPhaseDevice[];
  /** Resolved by the phase-footprint owner using the single installation mapping. */
  envelopes(device: ChargingPhaseDevice): readonly ChargingPhaseEnvelope[];
  observedPoint(device: ChargingPhaseDevice, phases: ChargingPhaseCount): ChargingPhasePoint;
  releasePlanningEnvelope(deviceId: string, forceSinglePhase: boolean): void;
  isSimulation(): boolean;
};

export type ChargingPhaseOwner = {
  readPlanning(nowMs: number): ChargingPhasePlanningRead;
  readPermittedEnvelopes(): ReadonlyMap<string, readonly ChargingPhaseEnvelope[]>;
  read(deviceId: string): ChargingPhaseRead;
  apply(decision: ChargingPhaseDecision, nowMs: number): Promise<{ requested: boolean }>;
  /** Step-ups and starts cannot race a pending physical transition. Reductions remain available. */
  blocksIncrease(deviceId: string): boolean;
  cancelForSafety(deviceId: string): void;
  reconcilePlan(decisions: readonly ChargingPhaseDecision[], nowMs: number): void;
  getDesiredForceSingle(deviceId: string): boolean | null;
  runDeviceCommand<T>(deviceId: string, operation: () => Promise<T>): Promise<T>;
};

/** Shared across homes only to serialize and fence ordinary device execution. */
export type ChargingPhaseExecutionGate = Pick<ChargingPhaseOwner,
  'read' | 'blocksIncrease' | 'cancelForSafety' | 'runDeviceCommand'>;

export const EMPTY_CHARGING_PHASE_READ: ChargingPhasePlanningRead = {
  candidates: [], reservations: [], releases: [], observations: [], permittedEnvelopes: new Map(), continuations: [],
};

/** Meter areas and fixtures without a phase-control owner have no physical phase work. */
export const NO_CHARGING_PHASE_OWNER: ChargingPhaseOwner = {
  readPlanning: () => EMPTY_CHARGING_PHASE_READ,
  readPermittedEnvelopes: () => EMPTY_CHARGING_PHASE_READ.permittedEnvelopes,
  read: () => ({ kind: 'unsupported' }),
  apply: async () => ({ requested: false }),
  blocksIncrease: () => false,
  cancelForSafety: () => {},
  reconcilePlan: () => {},
  getDesiredForceSingle: () => null,
  runDeviceCommand: async (_deviceId, operation) => operation(),
};

