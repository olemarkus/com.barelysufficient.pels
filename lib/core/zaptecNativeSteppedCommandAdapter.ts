import type { HomeyDeviceLike, Logger } from '../utils/types';
import type { DeviceCapabilityMap } from './deviceManagerControl';
import type { NativeSteppedLoadCommandAdapter } from './deviceManagerNativeSteppedCommand';
import {
  buildZaptecNativeSteppedStatus,
  getZaptecPowerMismatchSampleCount,
  getZaptecRequestedCurrentA,
  isZaptecPowerMismatch,
  resolveZaptecFlowActionId,
  resolveZaptecNativeSteppedLoadReportedStepId,
} from './zaptecNativeSteppedLoad';

const ZAPTEC_FLOW_URI = 'homey:app:com.zaptec';
const ZAPTEC_PENDING_REISSUE_MS = 45_000;
const ZAPTEC_OBSERVABLE_CAPABILITY_IDS = new Set([
  'available_installation_current',
  'measure_power',
  'evcharger_charging',
]);

type ZaptecBlockedReason = 'zaptec_stepped_blocked_shared_installation' | 'zaptec_stepped_blocked_power_mismatch';

type ZaptecAdapterState = {
  currentDevice: HomeyDeviceLike;
  capabilityObj: DeviceCapabilityMap;
  sharedInstallationBlocked: boolean;
  blockedReasonCode?: ZaptecBlockedReason;
  pendingStepId?: string;
  pendingIssuedAtMs?: number;
  lastConfirmedStepId?: string;
  mismatchSampleCount: number;
};

export function buildZaptecNativeSteppedLoadCommandAdapter(
  device: HomeyDeviceLike,
  initialSharedInstallationBlocked: boolean,
  getCapabilityObj: (device: HomeyDeviceLike) => DeviceCapabilityMap,
  logger?: Logger,
): NativeSteppedLoadCommandAdapter {
  const state: ZaptecAdapterState = {
    currentDevice: device,
    capabilityObj: getCapabilityObj(device),
    sharedInstallationBlocked: initialSharedInstallationBlocked,
    mismatchSampleCount: 0,
  };

  logZaptecProfileExposed(state, logger);
  refreshZaptecRuntimeState(state, logger);

  return {
    syncDevice({ device: nextDevice, sharedInstallationBlocked: nextSharedBlocked, logger: nextLogger }) {
      state.currentDevice = nextDevice;
      state.capabilityObj = getCapabilityObj(nextDevice);
      state.sharedInstallationBlocked = nextSharedBlocked;
      refreshZaptecRuntimeState(state, nextLogger);
    },
    async setStep({ desiredStepId, setCapability, runFlowCardAction, logger: nextLogger }) {
      return setZaptecDesiredStep(state, {
        desiredStepId,
        setCapability,
        runFlowCardAction,
        logger: nextLogger,
      });
    },
    observeCapabilityUpdate({ capabilityId, value, logger: nextLogger }) {
      return observeZaptecCapabilityUpdate(state, {
        capabilityId,
        value,
        logger: nextLogger,
      });
    },
    getReportedStepId() {
      const reportedStepId = refreshZaptecRuntimeState(state);
      return state.blockedReasonCode ? undefined : reportedStepId;
    },
    getStatus() {
      const reportedStepId = refreshZaptecRuntimeState(state);
      return buildZaptecNativeSteppedStatus({
        reportedStepId,
        blockedReasonCode: state.blockedReasonCode,
      });
    },
  };
}

function logZaptecProfileExposed(state: ZaptecAdapterState, logger?: Logger): void {
  logger?.structuredLog?.info({
    event: 'zaptec_stepped_profile_exposed',
    deviceId: state.currentDevice.id,
    deviceName: state.currentDevice.name,
    modelLabel: '1-phase',
  });
}

function refreshZaptecRuntimeState(state: ZaptecAdapterState, logger?: Logger): string | undefined {
  const reportedStepId = resolveZaptecNativeSteppedLoadReportedStepId({
    capabilityObj: state.capabilityObj,
  });
  syncZaptecSharedInstallationBlock(state, logger);
  if (isZaptecDisconnected(state)) {
    resetZaptecDisconnectedState(state, logger);
    return reportedStepId;
  }

  confirmPendingZaptecStep(state, reportedStepId, logger);
  trackReportedZaptecStep(state, reportedStepId);
  applyZaptecPowerMismatchGuard(state, reportedStepId, logger);
  expireZaptecPendingStep(state);
  return reportedStepId;
}

function syncZaptecSharedInstallationBlock(state: ZaptecAdapterState, logger?: Logger): void {
  const nextState = state;
  if (nextState.sharedInstallationBlocked) {
    if (nextState.blockedReasonCode !== 'zaptec_stepped_blocked_shared_installation') {
      nextState.blockedReasonCode = 'zaptec_stepped_blocked_shared_installation';
      logger?.structuredLog?.info({
        event: 'zaptec_stepped_session_blocked',
        deviceId: nextState.currentDevice.id,
        deviceName: nextState.currentDevice.name,
        reasonCode: nextState.blockedReasonCode,
      });
    }
    return;
  }
  if (nextState.blockedReasonCode === 'zaptec_stepped_blocked_shared_installation') {
    nextState.blockedReasonCode = undefined;
    logger?.structuredLog?.info({
      event: 'zaptec_stepped_session_unblocked',
      deviceId: nextState.currentDevice.id,
      deviceName: nextState.currentDevice.name,
      reasonCode: 'zaptec_stepped_blocked_shared_installation',
    });
  }
}

function isZaptecDisconnected(state: ZaptecAdapterState): boolean {
  return state.capabilityObj['alarm_generic.car_connected']?.value === false;
}

function resetZaptecDisconnectedState(state: ZaptecAdapterState, logger?: Logger): void {
  const nextState = state;
  nextState.pendingStepId = undefined;
  nextState.pendingIssuedAtMs = undefined;
  nextState.lastConfirmedStepId = undefined;
  nextState.mismatchSampleCount = 0;
  if (nextState.blockedReasonCode === 'zaptec_stepped_blocked_power_mismatch') {
    nextState.blockedReasonCode = undefined;
    logger?.structuredLog?.info({
      event: 'zaptec_stepped_session_unblocked',
      deviceId: nextState.currentDevice.id,
      deviceName: nextState.currentDevice.name,
      reasonCode: 'zaptec_stepped_blocked_power_mismatch',
    });
  }
}

function confirmPendingZaptecStep(
  state: ZaptecAdapterState,
  reportedStepId: string | undefined,
  logger?: Logger,
): void {
  const nextState = state;
  if (!nextState.pendingStepId || reportedStepId !== nextState.pendingStepId) return;
  nextState.lastConfirmedStepId = nextState.pendingStepId;
  nextState.pendingStepId = undefined;
  nextState.pendingIssuedAtMs = undefined;
  nextState.mismatchSampleCount = 0;
  logger?.structuredLog?.info({
    event: 'zaptec_stepped_command_confirmed',
    deviceId: nextState.currentDevice.id,
    deviceName: nextState.currentDevice.name,
    stepId: nextState.lastConfirmedStepId,
  });
}

function trackReportedZaptecStep(state: ZaptecAdapterState, reportedStepId: string | undefined): void {
  const nextState = state;
  if (nextState.pendingStepId || !reportedStepId || reportedStepId === 'off') return;
  if (reportedStepId === nextState.lastConfirmedStepId) return;
  nextState.lastConfirmedStepId = reportedStepId;
  nextState.mismatchSampleCount = 0;
}

function applyZaptecPowerMismatchGuard(
  state: ZaptecAdapterState,
  reportedStepId: string | undefined,
  logger?: Logger,
): void {
  const nextState = state;
  if (
    !nextState.lastConfirmedStepId
    || reportedStepId !== nextState.lastConfirmedStepId
    || nextState.lastConfirmedStepId === 'off'
  ) {
    if (nextState.blockedReasonCode !== 'zaptec_stepped_blocked_power_mismatch') {
      nextState.mismatchSampleCount = 0;
    }
    return;
  }
  if (!isZaptecPowerMismatch({
    expectedStepId: nextState.lastConfirmedStepId,
    measuredPowerW: nextState.capabilityObj.measure_power?.value,
  })) {
    if (nextState.blockedReasonCode !== 'zaptec_stepped_blocked_power_mismatch') {
      nextState.mismatchSampleCount = 0;
    }
    return;
  }

  nextState.mismatchSampleCount += 1;
  if (
    nextState.mismatchSampleCount < getZaptecPowerMismatchSampleCount()
    || nextState.blockedReasonCode === 'zaptec_stepped_blocked_power_mismatch'
  ) {
    return;
  }

  nextState.blockedReasonCode = 'zaptec_stepped_blocked_power_mismatch';
  logger?.structuredLog?.info({
    event: 'zaptec_stepped_power_validation_failed',
    deviceId: nextState.currentDevice.id,
    deviceName: nextState.currentDevice.name,
    stepId: nextState.lastConfirmedStepId,
    planningPowerW: getZaptecRequestedCurrentA(nextState.lastConfirmedStepId)! * 230,
    actualMeasuredPowerW: nextState.capabilityObj.measure_power?.value,
    reasonCode: nextState.blockedReasonCode,
  });
  logger?.structuredLog?.info({
    event: 'zaptec_stepped_session_blocked',
    deviceId: nextState.currentDevice.id,
    deviceName: nextState.currentDevice.name,
    reasonCode: nextState.blockedReasonCode,
  });
}

function expireZaptecPendingStep(state: ZaptecAdapterState): void {
  const nextState = state;
  if (
    !nextState.pendingIssuedAtMs
    || Date.now() - nextState.pendingIssuedAtMs <= ZAPTEC_PENDING_REISSUE_MS
  ) {
    return;
  }
  nextState.pendingStepId = undefined;
  nextState.pendingIssuedAtMs = undefined;
}

async function setZaptecDesiredStep(
  state: ZaptecAdapterState,
  params: {
    desiredStepId: string;
    setCapability: (capabilityId: string, value: unknown) => Promise<unknown>;
    runFlowCardAction: (params: {
      uri: string;
      id: string;
      args?: Record<string, unknown>;
    }) => Promise<unknown>;
    logger?: Logger;
  },
): Promise<boolean> {
  const nextState = state;
  const { desiredStepId, setCapability, runFlowCardAction, logger } = params;
  const reportedStepId = refreshZaptecRuntimeState(nextState, logger);
  if (nextState.blockedReasonCode) return false;

  const requestedCurrentA = getZaptecRequestedCurrentA(desiredStepId);
  if (requestedCurrentA === undefined) return false;
  if (desiredStepId === 'off') {
    return setZaptecOffStep(nextState, setCapability);
  }
  if (reportedStepId === desiredStepId) {
    return confirmZaptecDesiredStep(nextState, desiredStepId);
  }
  if (
    nextState.pendingStepId === desiredStepId
    && nextState.pendingIssuedAtMs
    && Date.now() - nextState.pendingIssuedAtMs < ZAPTEC_PENDING_REISSUE_MS
  ) {
    return true;
  }

  const actionId = resolveZaptecFlowActionId(nextState.currentDevice);
  if (!actionId) return false;
  logger?.structuredLog?.info({
    event: 'zaptec_stepped_command_requested',
    deviceId: nextState.currentDevice.id,
    deviceName: nextState.currentDevice.name,
    stepId: desiredStepId,
    planningPowerW: requestedCurrentA * 230,
    previousStepId: reportedStepId,
  });
  await runFlowCardAction({
    uri: ZAPTEC_FLOW_URI,
    id: actionId,
    args: {
      device: {
        id: nextState.currentDevice.id,
        name: nextState.currentDevice.name,
      },
      current1: requestedCurrentA,
      current2: 0,
      current3: 0,
    },
  });
  if (nextState.capabilityObj.charging_button?.value !== true) {
    await setCapability('evcharger_charging', true);
  }
  nextState.pendingStepId = desiredStepId;
  nextState.pendingIssuedAtMs = Date.now();
  nextState.mismatchSampleCount = 0;
  return true;
}

function confirmZaptecDesiredStep(state: ZaptecAdapterState, desiredStepId: string): true {
  const nextState = state;
  nextState.lastConfirmedStepId = desiredStepId;
  nextState.pendingStepId = undefined;
  nextState.pendingIssuedAtMs = undefined;
  nextState.mismatchSampleCount = 0;
  return true;
}

async function setZaptecOffStep(
  state: ZaptecAdapterState,
  setCapability: (capabilityId: string, value: unknown) => Promise<unknown>,
): Promise<true> {
  const nextState = state;
  nextState.pendingStepId = undefined;
  nextState.pendingIssuedAtMs = undefined;
  nextState.lastConfirmedStepId = 'off';
  nextState.mismatchSampleCount = 0;
  await setCapability('evcharger_charging', false);
  return true;
}

function observeZaptecCapabilityUpdate(
  state: ZaptecAdapterState,
  params: {
    capabilityId: string;
    value: unknown;
    logger?: Logger;
  },
): boolean {
  const nextState = state;
  const { capabilityId, value, logger } = params;
  if (!ZAPTEC_OBSERVABLE_CAPABILITY_IDS.has(capabilityId)) return false;
  if (capabilityId === 'evcharger_charging') {
    nextState.capabilityObj.charging_button = {
      ...nextState.capabilityObj.charging_button,
      value,
    };
  } else {
    nextState.capabilityObj[capabilityId] = {
      ...nextState.capabilityObj[capabilityId],
      value,
    };
  }
  refreshZaptecRuntimeState(nextState, logger);
  return true;
}
