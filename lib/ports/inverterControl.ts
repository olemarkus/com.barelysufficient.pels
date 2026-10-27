import type { InverterDecision } from '../planContract/inverterDecision';
import type { InverterControlSurface, InverterObservation } from '../../packages/contracts/src/inverterControl';
import type { InverterCurtailmentDevices } from '../../packages/shared-domain/src/settings/inverterCurtailment';

export type InverterControlPolicy = {
  read(): InverterCurtailmentDevices;
  isEnabled(deviceId: string): boolean;
  disable(deviceId: string): void;
};

export type InverterActuation = {
  apply(command: InverterCommand): Promise<{ requested: boolean }>;
};

export type InverterExecutionRead = {
  ready(deviceId: string): boolean;
  ownership(deviceId: string): InverterPlanInput['ownership'];
  notBeforeMs(deviceId: string): number;
};

/** Durable hand-back target, saved before the first production-cap write. */
export type InverterClaim = {
  previousLimitW: number;
  previousMode: InverterObservation['mode'];
  claimedAtMs: number;
};

/** Device, settings and executor facts resolved at the planner-input boundary. */
export type InverterPlanInput = {
  deviceId: string;
  surface: InverterControlSurface;
  observation: InverterObservation;
  enabled: boolean;
  notBeforeMs: number;
  ownership: { kind: 'free' } | { kind: 'held'; claim: InverterClaim; recovering: boolean };
};

/** Channel-blind maximum production, or return to the pre-PELS posture. */
export type InverterCommand = {
  kind: 'production_limit'; deviceId: string; limitW: number;
} | {
  kind: 'production_release'; deviceId: string; claim: InverterClaim;
};

export type InverterPlanner = {
  decide(netImportW: number, nowMs: number): InverterDecision[];
  releaseAll(): InverterDecision[];
};

export type InverterExecution = {
  hasWork(decisions: readonly InverterDecision[]): boolean;
  apply(decisions: readonly InverterDecision[]): Promise<{ commandRequestCount: number; failureCount: number }>;
};

export const NO_INVERTER_PLANNER: InverterPlanner = {
  decide: () => [], releaseAll: () => [],
};
export const NO_INVERTER_EXECUTION: InverterExecution = {
  hasWork: () => false,
  apply: async () => ({ commandRequestCount: 0, failureCount: 0 }),
};
