import {
  formatDeviceReason,
  PLAN_REASON_CODES,
} from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import { isRestoreAdmissionHoldReason } from '../planContract/planDecisionSemantics';
import type { TargetDeviceSnapshot } from '../utils/types';
import type {
  ExecutableBinaryIntent,
  ExecutableDeviceIntent,
  ExecutableEvIntent,
  ExecutableObservedDeviceState,
  ExecutableObservedState,
  ExecutableObservedSteppedLoadState,
  ExecutableObservedTargetState,
  ExecutablePlan,
} from './executablePlan';
import { buildExecutableSteppedLoadIntent } from './executableSteppedLoadProjection';
import { buildExecutableTargetIntent } from './executableTargetProjection';

type PlanDevice = DevicePlan['devices'][number];
type PlanMeta = DevicePlan['meta'];

export function buildExecutablePlan(plan: DevicePlan): ExecutablePlan {
  return {
    devices: plan.devices.map((device) => buildExecutableDeviceIntentSafe(device, plan.meta)),
  };
}

export function buildExecutableDeviceIntent(planDevice: PlanDevice, planMeta?: PlanMeta): ExecutableDeviceIntent {
  return {
    id: planDevice.id,
    name: planDevice.name,
    controllable: planDevice.controllable !== false,
    target: buildExecutableTargetIntent(planDevice),
    binary: buildExecutableBinaryIntent(planDevice),
    ev: buildExecutableEvIntent(planDevice, planMeta),
    steppedLoad: buildExecutableSteppedLoadIntent(planDevice),
  };
}

function buildExecutableDeviceIntentSafe(planDevice: PlanDevice, planMeta?: PlanMeta): ExecutableDeviceIntent {
  try {
    return buildExecutableDeviceIntent(planDevice, planMeta);
  } catch (error) {
    return {
      id: planDevice.id,
      name: planDevice.name,
      controllable: planDevice.controllable !== false,
      target: null,
      binary: null,
      ev: null,
      steppedLoad: null,
      projectionError: error,
    };
  }
}

export function buildExecutableObservedState(
  snapshots: TargetDeviceSnapshot[],
): ExecutableObservedState {
  return {
    devices: snapshots.map(buildExecutableObservedDeviceState),
  };
}

export function buildExecutableObservedDeviceState(
  snapshot: TargetDeviceSnapshot,
): ExecutableObservedDeviceState {
  return {
    id: snapshot.id,
    name: snapshot.name,
    snapshot,
    available: typeof snapshot.available === 'boolean' ? snapshot.available : null,
    currentOn: snapshot.currentOn,
    target: buildObservedTargetState(snapshot),
    steppedLoad: buildObservedSteppedLoadState(snapshot),
  };
}

const buildObservedTargetState = (snapshot: TargetDeviceSnapshot): ExecutableObservedTargetState | null => {
  const primaryTarget = snapshot.targets?.[0];
  return primaryTarget
    ? {
      targetCap: primaryTarget.id,
      observedValue: primaryTarget.value,
    }
    : null;
};

const buildObservedSteppedLoadState = (
  snapshot: TargetDeviceSnapshot,
): ExecutableObservedSteppedLoadState | null => {
  if (snapshot.controlModel !== 'stepped_load') return null;
  return {
    on: snapshot.currentOn,
    stepId: snapshot.selectedStepId,
    reportedStepId: snapshot.reportedStepId,
    actualStepId: snapshot.actualStepId,
    actualStepSource: snapshot.actualStepSource,
    assumedStepId: snapshot.assumedStepId,
    measuredPowerKw: snapshot.measuredPowerKw,
  };
};

const buildExecutableBinaryIntent = (dev: PlanDevice): ExecutableBinaryIntent | null => {
  if (dev.controlModel === 'stepped_load') return null;
  if (dev.hasBinaryControl === false) return null;
  if (dev.controllable === false) {
    return dev.plannedState === 'keep'
      ? { kind: 'restore', deviceId: dev.id, name: dev.name, source: 'uncontrolled' }
      : null;
  }
  if (dev.plannedState === 'shed') {
    return buildExecutableBinaryShedIntent(dev);
  }
  if (dev.plannedState !== 'keep') return null;
  if (isSwapTargetPendingReason(dev)) return null;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return null;
  return { kind: 'restore', deviceId: dev.id, name: dev.name, source: 'controlled' };
};

const buildExecutableBinaryShedIntent = (dev: PlanDevice): ExecutableBinaryIntent | null => {
  if (isSwapTargetPendingReason(dev)) return null;
  if (dev.reason && isRestoreAdmissionHoldReason(dev.reason)) return null;
  if ((dev.shedAction ?? 'turn_off') === 'set_temperature') return null;
  const isSwap = dev.reason?.code === PLAN_REASON_CODES.swappedOut;
  return {
    kind: 'shed',
    deviceId: dev.id,
    name: dev.name,
    reason: isSwap && dev.reason ? formatDeviceReason(dev.reason) : undefined,
  };
};

const isSwapTargetPendingReason = (dev: PlanDevice): boolean => (
  dev.reason?.code === PLAN_REASON_CODES.swapPending && dev.reason.targetName === null
);

const buildExecutableEvIntent = (dev: PlanDevice, planMeta?: PlanMeta): ExecutableEvIntent | null => {
  const kind = dev.deferredEvCommandIntent;
  if (!kind) return null;
  if (dev.deviceClass !== 'evcharger' && dev.controlCapabilityId !== 'evcharger_charging') return null;
  if (kind === 'ev_pause') return { kind, deviceId: dev.id, name: dev.name };
  if (planMeta?.powerFreshnessState && planMeta.powerFreshnessState !== 'fresh') return null;
  if (dev.plannedState !== 'keep') return null;
  if (isSwapTargetPendingReason(dev)) return null;
  if (dev.reason && isEvResumeBlockedReason(dev.reason)) return null;
  return { kind, deviceId: dev.id, name: dev.name };
};

const EV_RESUME_BLOCK_REASON_CODES = new Set<string>([
  PLAN_REASON_CODES.activationBackoff,
  PLAN_REASON_CODES.capacity,
  PLAN_REASON_CODES.cooldownRestore,
  PLAN_REASON_CODES.cooldownShedding,
  PLAN_REASON_CODES.headroomCooldown,
  PLAN_REASON_CODES.insufficientHeadroom,
  PLAN_REASON_CODES.meterSettling,
  PLAN_REASON_CODES.restorePending,
  PLAN_REASON_CODES.restoreThrottled,
  PLAN_REASON_CODES.shedInvariant,
  PLAN_REASON_CODES.startupStabilization,
  PLAN_REASON_CODES.waitingForOtherDevices,
]);

const isEvResumeBlockedReason = (reason: NonNullable<PlanDevice['reason']>): boolean => (
  EV_RESUME_BLOCK_REASON_CODES.has(reason.code)
);
