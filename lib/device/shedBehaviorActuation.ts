import { getLogger } from '../logging/logger';
import type {
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type {
  SteppedLoadStepRequestResult,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import {
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';

const logger = getLogger('device/shed-behavior-actuation');

/**
 * Thin, set-and-forget device-layer shed actuator. A smart-task **terminal**
 * disable (task ended on a cap-off device) issues the device's configured shed
 * command **once** — it does NOT need the executor's continuous reconciliation
 * (retry/backoff, in-flight gates, drift detection). That machinery exists for
 * the plan-driven idle/capacity path, which stays in `lib/executor`.
 *
 * This module deliberately depends only on a narrow transport interface (no
 * `ExecutablePlan` types), so it is callable directly from an app-wired
 * smart-task callback without dragging in the executor's plan-shaped surface.
 *
 * Idempotency is observed-state, trusted-evidence only (mirrors the executor's
 * shed-release guards): act only on a binary device observed `on`, or a target
 * observed away from the shed setpoint. `unknown` / missing observation is
 * treated as "no trusted evidence yet — wait", so a defaulted state after a
 * Homey restart cannot fire a spurious write.
 */
// NB: deliberately NOT the same union as `ShedActionIntent`
// (`deviceActionProjection.ts`) or `ShedAction` (`lib/plan/planTypes`). Those
// model the *unresolved* configured behavior (`turn_off | set_temperature |
// set_step`); this is the *post-resolution* flat transport command after EV /
// binary-handle collapse (the app callback's `resolveTerminalShedCommand` folds
// `turn_off`/`set_step`/EV into `binary_off`, and unsupported cases into `skip`).
// Reusing those would force a `lib/device → lib/plan` edge that
// `no-device-to-peer-except-power` forbids — keep this parallel type local.
export type ShedActuationCommand =
  // `flowBacked` devices are controlled via a Homey Flow trigger, NOT a direct
  // capability write (a `setCapability` would silently no-op and leave the load
  // on) — the producer resolves which from the snapshot's flowBackedCapabilityIds.
  | { kind: 'binary_off'; capabilityId: 'onoff' | 'evcharger_charging'; flowBacked: boolean }
  | { kind: 'set_temperature'; targetValue: number }
  | {
    kind: 'set_step';
    profile: SteppedLoadProfile;
    targetStepId: string;
    planningCurrentA: number;
    previousStepId?: string;
    stepCommandPending?: boolean;
    nextStepCommandRetryAtMs?: number;
  }
  | { kind: 'skip'; reasonCode: string };

export type ShedActuationObservedState = {
  /** Trusted binary observation; `'unknown'` blocks the write (no evidence yet). */
  binaryState?: 'on' | 'off' | 'unknown';
  /** Last observed thermostat target, for the set_temperature idempotency check. */
  targetValue?: number | null;
  /** Trusted stepped-load observation, sourced from reported/native step state. */
  stepId?: string;
};

export type ShedActuationTransport = {
  setCapability: (deviceId: string, capabilityId: string, value: unknown) => Promise<unknown>;
  applyDeviceTargets: (targets: Record<string, number>, contextInfo?: string) => Promise<void>;
  // Fire the device's flow-backed binary control request (a Homey Flow trigger),
  // used instead of `setCapability` when the binary capability is flow-backed.
  triggerFlowBackedBinaryControl: (
    deviceId: string,
    capabilityId: 'onoff' | 'evcharger_charging',
    desired: boolean,
  ) => Promise<void>;
  requestSteppedLoadStep?: (params: {
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    actuationMode?: 'plan' | 'reconcile';
    previousStepId?: string;
  }) => Promise<SteppedLoadStepRequestResult>;
  markSteppedLoadDesiredStepIssued?: (params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    issuedAtMs?: number;
  }) => void;
};

/**
 * Apply a resolved shed command to a device, once, idempotently. Returns `true`
 * when a transport write was issued, `false` when skipped (already in shed
 * posture, no trusted evidence, or an unsupported command). The app callback
 * resolves the command (EV → binary_off on `evcharger_charging`; otherwise the
 * device's configured `getShedBehavior`) and reads `observed` from the live
 * snapshot before calling.
 */
export const applyShedBehavior = async (params: {
  deviceId: string;
  name: string;
  command: ShedActuationCommand;
  observed: ShedActuationObservedState;
  transport: ShedActuationTransport;
}): Promise<boolean> => {
  const { deviceId, name, command, observed, transport } = params;
  switch (command.kind) {
    case 'skip':
      logSkippedTerminalShed(deviceId, name, command.reasonCode);
      return false;
    case 'set_temperature':
      return applySetTemperatureShed(deviceId, command, observed, transport);
    case 'set_step':
      return applySetStepShed(deviceId, command, observed, transport);
    case 'binary_off':
      return applyBinaryOffShed(deviceId, command, observed, transport);
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
};

const logSkippedTerminalShed = (deviceId: string, name: string, reasonCode: string): void => {
  logger.debug({
    event: 'terminal_shed_skipped',
    reasonCode,
    deviceId,
    deviceName: name,
  });
};

const applySetTemperatureShed = async (
  deviceId: string,
  command: Extract<ShedActuationCommand, { kind: 'set_temperature' }>,
  observed: ShedActuationObservedState,
  transport: ShedActuationTransport,
): Promise<boolean> => {
  // Idempotent: only write when the observed target differs from the shed
  // setpoint. A missing observed target means no trusted evidence — skip.
  if (typeof observed.targetValue !== 'number') return false;
  if (observed.targetValue === command.targetValue) return false;
  await transport.applyDeviceTargets({ [deviceId]: command.targetValue }, 'smart-task-terminal-release');
  return true;
};

const applySetStepShed = async (
  deviceId: string,
  command: Extract<ShedActuationCommand, { kind: 'set_step' }>,
  observed: ShedActuationObservedState,
  transport: ShedActuationTransport,
): Promise<boolean> => {
  if (command.stepCommandPending === true) return false;
  if (typeof command.nextStepCommandRetryAtMs === 'number' && command.nextStepCommandRetryAtMs > Date.now()) {
    return false;
  }
  const requestStep = transport.requestSteppedLoadStep;
  if (!requestStep) return false;
  const targetStep = getSteppedLoadStep(command.profile, command.targetStepId);
  const observedStepId = observed.stepId;
  if (!targetStep || !observedStepId) return false;
  if (observedStepId === targetStep.id) return false;
  const observedStep = getSteppedLoadStep(command.profile, observedStepId);
  if (!observedStep) return false;
  // Terminal release must never step a load up. If the device is already at
  // or below the configured shed target, it is in an acceptable posture.
  if (observedStep.planningPowerW <= targetStep.planningPowerW) return false;
  const result = await requestStep({
    deviceId,
    profile: command.profile,
    desiredStepId: targetStep.id,
    planningPowerW: targetStep.planningPowerW,
    planningCurrentA: command.planningCurrentA,
    actuationMode: 'plan',
    previousStepId: command.previousStepId ?? observedStepId,
  });
  if (!result.requested) return false;
  transport.markSteppedLoadDesiredStepIssued?.({
    deviceId,
    desiredStepId: targetStep.id,
    previousStepId: command.previousStepId ?? observedStepId,
    issuedAtMs: Date.now(),
  });
  return true;
};

const applyBinaryOffShed = async (
  deviceId: string,
  command: Extract<ShedActuationCommand, { kind: 'binary_off' }>,
  observed: ShedActuationObservedState,
  transport: ShedActuationTransport,
): Promise<boolean> => {
  // turn_off / EV pause / set_step on a binary-capable device.
  // Trusted-evidence gate: only fire when the device is observed `on`. Treat
  // `off` as already-shed and `unknown`/missing as "wait for real evidence".
  if (observed.binaryState !== 'on') return false;
  if (command.flowBacked) {
    // Flow-backed device: a direct setCapability would no-op. Fire the device's
    // flow-backed control request (Homey Flow trigger) instead.
    await transport.triggerFlowBackedBinaryControl(deviceId, command.capabilityId, false);
  } else {
    await transport.setCapability(deviceId, command.capabilityId, false);
  }
  return true;
};
