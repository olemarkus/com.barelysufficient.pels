import type CapacityGuard from '../../core/capacityGuard';
import type { PowerTrackerState } from '../../core/powerTracker';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from '../planContext';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice, ShedAction } from '../planTypes';

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
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
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
