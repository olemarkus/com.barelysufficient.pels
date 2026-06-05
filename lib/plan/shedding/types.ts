import type CapacityGuard from '../../power/capacityGuard';
import type { PowerTrackerState } from '../../power/tracker';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from '../planContext';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice, ShedAction } from '../planTypes';
import type { PendingBinaryCommandStore } from '../../observer/pendingBinaryCommands';

export type SheddingPlan = {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  sheddingActive: boolean;
  guardInShortfall: boolean;
  updates: {
    lastInstabilityMs?: number;
    lastRecoveryMs?: number;
    lastShedPlanMeasurementTs?: number;
    lastOvershootEscalationMs?: number;
    lastOvershootMitigationMs?: number;
  };
  overshootStats: OvershootStats | null;
};

export type OvershootStats = {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
  allShedCandidatesExhausted: boolean;
  controlRecoverable: boolean;
};

export type SheddingDeps = {
  capacityGuard: CapacityGuard | undefined;
  powerTracker: PowerTrackerState;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null; stepId: string | null };
  getPriorityForDevice: (deviceId: string) => number;
  // Observer-owned pending-binary-command store; candidate builders read
  // unconfirmed-relief state through `peek(id)` (raw read) instead of
  // touching `state.pendingBinaryCommands[id]` directly.
  pendingBinaryCommandStore: PendingBinaryCommandStore;
  log: (...args: unknown[]) => void;
  debugStructured?: import('../../logging/logger').StructuredDebugEmitter;
  structuredLog?: import('../../logging/logger').Logger;
};

export type PlanSheddingResult = {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  updates: SheddingPlan['updates'];
  overshootStats: SheddingPlan['overshootStats'];
};

export type ShedCandidateParams = {
  devices: PlanInputDevice[];
  needed: number;
  limitSource: PlanContext['softLimitSource'];
  total: number | null;
  capacitySoftLimit: number;
  state: PlanEngineState;
  deps: SheddingDeps;
};

export type BaseShedCandidate = PlanInputDevice & {
  priority: number;
  effectivePower: number;
  recentlyRestored: boolean;
  unconfirmedRelief: boolean;
};

export type BinaryShedCandidate = BaseShedCandidate & { kind: 'binary' };

export type SteppedShedCandidate = BaseShedCandidate & {
  kind: 'stepped';
  fromStepId: string;
  toStepId: string;
  preemptiveStepDown: boolean;
};

export type TemperatureShedCandidate = BaseShedCandidate & {
  kind: 'temperature';
  targetCapabilityId: string;
  shedTemperature: number;
};

export type ShedCandidate = BinaryShedCandidate | SteppedShedCandidate | TemperatureShedCandidate;
