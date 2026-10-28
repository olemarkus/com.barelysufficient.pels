import type { InverterDecision } from '../planContract/inverterDecision';
import type {
  InverterControlBinding, InverterControlSurface, InverterObservation,
} from '../../packages/contracts/src/inverterControl';
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
  heldDeviceIds(): readonly string[];
  ready(deviceId: string): boolean;
  ownership(deviceId: string): InverterControllableInput['ownership'];
  notBeforeMs(deviceId: string): number;
};

/** Durable hand-back target, saved before the first production-cap write. */
export type InverterClaim = {
  previousLimitW: number;
  previousMode: InverterObservation['mode'];
  claimedAtMs: number;
  restoration: { kind: 'native'; binding: InverterControlBinding };
};

/** Device, settings and executor facts resolved at the planner-input boundary. */
export type InverterControllableInput = {
  kind: 'controllable';
  deviceId: string;
  surface: InverterControlSurface;
  observation: InverterObservation;
  enabled: boolean;
  notBeforeMs: number;
  ownership: { kind: 'free' } | { kind: 'held'; claim: InverterClaim; recovering: boolean };
};

/** A held inverter remains a release candidate even without usable controls. */
export type InverterPlanInput = InverterControllableInput | { kind: 'hand_back'; deviceId: string };

/** Channel-blind maximum production, or return to the pre-PELS posture. */
export type InverterReleaseTarget = { kind: 'watts_only'; limitW: number } | {
  kind: 'watts_and_mode'; limitW: number; binding: InverterControlBinding;
  mode: Exclude<InverterObservation['mode'], { kind: 'direct' }>;
};

export type InverterCommand = {
  kind: 'production_limit'; deviceId: string; limitW: number;
} | {
  kind: 'production_release'; deviceId: string; target: InverterReleaseTarget;
};

export type InverterPlanner = {
  decide(netImportW: number, nowMs: number): InverterDecision[];
  releaseAll(): InverterDecision[];
};

export type InverterExecution = {
  releaseRecoveryReady(): boolean;
  hasWork(decisions: readonly InverterDecision[]): boolean;
  apply(decisions: readonly InverterDecision[]): Promise<{
    commandRequestCount: number; failureCount: number; pendingInverterReleaseCount: number;
  }>;
};

export const NO_INVERTER_PLANNER: InverterPlanner = {
  decide: () => [], releaseAll: () => [],
};
export const NO_INVERTER_EXECUTION: InverterExecution = {
  releaseRecoveryReady: () => true,
  hasWork: () => false,
  apply: async () => ({ commandRequestCount: 0, failureCount: 0, pendingInverterReleaseCount: 0 }),
};
