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
  ExecutableObservedDeviceState,
  ExecutableObservedState,
  ExecutableObservedSteppedLoadState,
  ExecutableObservedTargetState,
  ExecutablePlan,
} from './executablePlan';
import { buildExecutableSteppedLoadIntent } from './executableSteppedLoadProjection';
import { buildExecutableTargetIntent } from './executableTargetProjection';

type PlanDevice = DevicePlan['devices'][number];

export function buildExecutablePlan(plan: DevicePlan): ExecutablePlan {
  return {
    devices: plan.devices.map(buildExecutableDeviceIntentSafe),
  };
}

export function buildExecutableDeviceIntent(planDevice: PlanDevice): ExecutableDeviceIntent {
  return {
    id: planDevice.id,
    name: planDevice.name,
    controllable: planDevice.controllable !== false,
    target: buildExecutableTargetIntent(planDevice),
    binary: buildExecutableBinaryIntent(planDevice),
    steppedLoad: buildExecutableSteppedLoadIntent(planDevice),
  };
}

function buildExecutableDeviceIntentSafe(planDevice: PlanDevice): ExecutableDeviceIntent {
  try {
    return buildExecutableDeviceIntent(planDevice);
  } catch (error) {
    return {
      id: planDevice.id,
      name: planDevice.name,
      controllable: planDevice.controllable !== false,
      target: null,
      binary: null,
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
