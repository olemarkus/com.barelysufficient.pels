import type CapacityGuard from '../../power/capacityGuard';
import type { PowerTrackerState } from '../../power/tracker';
import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PlanContext } from '../planContext';
import type { PlanEngineState } from '../planState';
import type { PlanInputDevice, ShedAction } from '../planTypes';
import type { PendingBinaryCommandStore } from '../../observer/pendingBinaryCommands';
import type { ShedCandidateSkipSummary } from './candidateSkipLog';

export type SheddingPlan = {
  shedSet: Set<string>;
  shedReasons: Map<string, DeviceReason>;
  sheddingActive: boolean;
  guardInShortfall: boolean;
  updates: {
    lastInstabilityMs?: number;
    lastRecoveryMs?: number;
    lastShedPlanMeasurementTs?: number;
    lastShedPlanPowerW?: number;
    lastShedPlanShedIds?: Set<string>;
    lastShedPlanAtMs?: number;
    lastShedPlanNeededKw?: number;
    lastOvershootEscalationMs?: number;
    lastOvershootMitigationMs?: number;
  };
  overshootStats: OvershootStats | null;
};

/**
 * The two overshoot questions `resolveSoftOvershootDecision` keeps apart
 * (`lib/plan/planOvershoot.ts`), threaded in together because `buildSheddingPlan`
 * consumes them on DIFFERENT paths:
 *
 * - `shedActionable` gates SELECTION — may this cycle choose devices to limit.
 * - `actionable` gates the shedding-active LATCH — is the house in an overshoot
 *   at all.
 *
 * Wiring the latch to `shedActionable` is what caused the 2026-08-16 restore-all
 * regression. Every restore-side lane stands down while `activeOvershoot` holds
 * — `resolveOffDeviceReason` and `resolveCapacityRestoreBlockReason` both defer
 * to "the caller's own reason stands" — and `applyRestorePlan` reaches its
 * stay-off marking through `sheddingActive`. So a graced cycle that also cleared
 * the latch left NOTHING holding a device that was already limited: it
 * materialized as `keep` and the executor turned it back on. The grace defers a
 * NEW shed; it must never release the ones already in force.
 */
export type SheddingOvershootInput = {
  actionable: boolean;
  shedActionable: boolean;
};

export type OvershootStats = {
  needed: number;
  eligibleCandidateCount: number;
  blockedCandidateCount: number;
  reducibleControlledKw: number;
  blockedReducibleControlledKw: number;
  allShedCandidatesExhausted: boolean;
  controlRecoverable: boolean;
  skippedCandidateCount: number;
  skippedCandidateReasons: ShedCandidateSkipSummary['skippedCandidateReasons'];
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
