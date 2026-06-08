import { isBinaryObservedOff, isBinaryOnOrUnknown } from '../../packages/shared-domain/src/binaryControlState';
import { isCommandableNow } from '../../packages/shared-domain/src/commandableNow';
import { getLogger } from '../logging/logger';
import {
  shouldSkipShedding,
} from '../plan/planExecutorSupport';
import {
  getBinaryControlPlan,
} from '../plan/planBinaryControl';
import {
  resolveBinaryShedReasonCode,
  selectShedActuationRecorder,
  shedActuationStampsCapacityMarkers,
} from './lifecycleReleaseRecording';
import type { BinaryControlCapabilityId, TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type {
  ExecutableBinaryIntent,
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
} from './executablePlan';
import type { PlanActuationMode } from './executorTypes';
import { runBinaryControl, type PlanExecutorBinaryContext } from './binaryControlShared';
import {
  applyBinaryRestoreWithSnapshot,
  applyCapacityControlOffRestoreWithSnapshot,
  canApplyRestoreSnapshot,
} from './binaryRestoreHelpers';

// Re-exported so existing importers keep resolving the context type from binaryExecutor.
export type { PlanExecutorBinaryContext };

const logger = getLogger('executor/binary');

export const applyBinaryRestore = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableBinaryIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (!intent || intent.kind !== 'restore' || intent.source !== 'controlled') return false;
  const snapshot = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  if (!snapshot) {
    canApplyRestoreSnapshot(ctx, {
      snapshot,
      deviceId: intent.deviceId,
      name: intent.name,
      logContext: 'capacity',
      mode,
    });
    return false;
  }
  if (isBinaryOnOrUnknown(snapshot)) return false;
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity',
    mode,
  })) return false;
  return applyBinaryRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot: snapshot as TargetDeviceSnapshot,
    logContext: 'capacity',
    mode,
  });
};

export const applyUncontrolledBinaryRestore = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableBinaryIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent || intent.kind !== 'restore' || intent.source !== 'uncontrolled') return false;
  const shedDecided = ctx.state.shedDecidedMs[intent.deviceId];
  if (!shedDecided) return false;
  const entry = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  if (!entry) {
    canApplyRestoreSnapshot(ctx, {
      snapshot: entry,
      deviceId: intent.deviceId,
      name: intent.name,
      logContext: 'capacity_control_off',
      mode: 'plan',
    });
    return false;
  }
  if (isBinaryOnOrUnknown(entry)) return false;
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot: entry,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity_control_off',
    mode: 'plan',
  })) return false;
  return applyCapacityControlOffRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot: entry as TargetDeviceSnapshot,
  });
};

export const applyBinarySheddingToDevice = async (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    deviceName: string;
    reason?: string;
    skipPrecheck?: boolean;
    trackPendingShed?: boolean;
    // Set by the smart-task lifecycle-end disable path. Routes recording through the
    // diagnostic-only recorder (no capacity cooldown markers) and, by default, bypasses
    // the capacity precheck (shouldSkipShedding) and the pendingSheds bookkeeping:
    // skipPrecheck / trackPendingShed default from this flag, so lifecycle callers pass
    // only `lifecycleRelease: true`. An explicit skipPrecheck / trackPendingShed still wins.
    lifecycleRelease?: boolean;
  },
): Promise<boolean> => {
  const {
    deviceId,
    deviceName,
    reason,
    lifecycleRelease,
  } = params;
  // A lifecycle disable is off the capacity path: skip the capacity precheck and don't
  // track it as a pending capacity shed, unless the caller explicitly overrides.
  const skipPrecheck = params.skipPrecheck ?? Boolean(lifecycleRelease);
  const trackPendingShed = params.trackPendingShed ?? !lifecycleRelease;
  if (ctx.capacityDryRun) return false;
  const snapshotState = ctx.observation.getSnapshotByDeviceId(deviceId);
  if (!skipPrecheck && shouldSkipShedding({
    state: ctx.state,
    deviceId,
    deviceName,
    snapshotState,
  })) {
    return false;
  }
  if (!trackPendingShed) {
    return turnOffDevice(ctx, {
      deviceId,
      name: deviceName,
      reason,
      snapshot: snapshotState,
      lifecycleRelease,
    });
  }
  ctx.state.pendingSheds.add(deviceId);
  try {
    return await turnOffDevice(ctx, {
      deviceId,
      name: deviceName,
      reason,
      snapshot: snapshotState,
      lifecycleRelease,
    });
  } finally {
    ctx.state.pendingSheds.delete(deviceId);
  }
};

export const applyDeferredBinaryCommand = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableReleaseIntent | null,
  observed: ExecutableObservedDeviceState | undefined,
  mode: PlanActuationMode,
): Promise<boolean> => {
  if (!intent) return false;
  if (intent.kind === 'shed_release') return false;
  const snapshot = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  // Requires a binary control handle (onoff or evcharger_charging). The actuation is
  // device-agnostic — the dispatched command's capability is derived from the device's
  // `controlCapabilityId`, never hardcoded — so this accepts any binary control.
  if (!snapshot || snapshot.controlCapabilityId === undefined) return false;

  if (intent.kind === 'binary_release') {
    // A released binary device is just onoff=false; release only one that is
    // currently on. `binaryControl.on` is the consolidated binary truth.
    // Lifecycle-end release (smart task satisfied/idle), not a capacity shed:
    // lifecycleRelease routes through the diagnostic-only recorder and (by
    // default) bypasses the capacity precheck / pendingSheds path so it does not
    // stamp the cooldown markers. The binary-on check is the trusted-evidence
    // gate, mirroring applyShedReleaseBinaryOff's gate.
    if (isBinaryObservedOff(snapshot)) return false;
    return applyBinarySheddingToDevice(ctx, {
      deviceId: intent.deviceId,
      deviceName: intent.name,
      lifecycleRelease: true,
    });
  }

  // Restore only an off-but-commandable device — i.e. released. Reads the binary
  // truth (`binaryControl.on`) + producer-resolved commandability, not any
  // device-specific state string.
  if (isBinaryOnOrUnknown(snapshot) || !isCommandableNow(snapshot)) return false;
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity',
    mode,
  })) return false;
  return applyBinaryRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot,
    logContext: 'capacity',
    mode,
  });
};

const recordDirectBinaryShedActuation = (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    name: string;
    capabilityId: BinaryControlCapabilityId;
    reason?: string;
    lifecycleRelease?: boolean;
    now: number;
  },
): void => {
  const { deviceId, name, capabilityId, reason, lifecycleRelease, now } = params;
  logger.info({
    event: 'binary_command_applied',
    deviceId,
    deviceName: name,
    capabilityId,
    desired: false,
    mode: 'plan',
    reasonCode: resolveBinaryShedReasonCode(reason, lifecycleRelease),
  });
  selectShedActuationRecorder({
    lifecycleRelease,
    recordShedActuation: ctx.recordShedActuation,
    recordReleaseShedActuation: ctx.recordReleaseShedActuation,
  })(deviceId, name, now);
};

const turnOffDevice = async (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    name: string;
    reason?: string;
    snapshot?: TargetDeviceSnapshot;
    lifecycleRelease?: boolean;
  },
): Promise<boolean> => {
  const {
    deviceId,
    name,
    reason,
    snapshot,
    lifecycleRelease,
  } = params;
  const snapshotEntry = snapshot ?? ctx.observation.getSnapshotByDeviceId(deviceId);
  const controlPlan = getBinaryControlPlan(snapshotEntry);
  if (!controlPlan) {
    const hasTarget = Array.isArray(snapshotEntry?.targets) && snapshotEntry.targets.length > 0;
    if (shedActuationStampsCapacityMarkers(lifecycleRelease)) {
      const now = Date.now();
      // eslint-disable-next-line no-param-reassign, functional/immutable-data -- Shared executor state update.
      ctx.state.lastDeviceShedMs[deviceId] = now;
    }
    logger.debug({
      event: 'binary_command_skipped',
      reasonCode: hasTarget ? 'missing_onoff_capability' : 'missing_control_targets',
      deviceId,
      deviceName: name,
      desired: false,
      logContext: 'capacity',
      actuationMode: 'plan',
      hasTargets: hasTarget,
      capabilityId: snapshotEntry?.controlCapabilityId ?? null,
    });
    logger.debug({ event: 'executor_binary_log_debug', msg: hasTarget
      ? `Capacity: skip turn_off for ${name}, device has no onoff capability`
      : `Capacity: skip turn_off for ${name}, device has no onoff or temperature target` });
    return false;
  }
  const now = Date.now();
  try {
    const outcome = await runBinaryControl({
      ctx,
      deviceId,
      name,
      desired: false,
      snapshot: snapshotEntry,
      logContext: 'capacity',
      reason,
      actuationMode: 'plan',
      lifecycleRelease,
    });
    if (!outcome.applied) return false;
    if (!outcome.flowBacked) {
      recordDirectBinaryShedActuation(ctx, {
        deviceId,
        name,
        capabilityId: snapshotEntry?.controlCapabilityId ?? controlPlan.capabilityId,
        reason,
        lifecycleRelease,
        now,
      });
    }
    return true;
  } catch (error) {
    logger.error({ event: 'executor_binary_error', msg: `Failed to turn off ${name} via DeviceTransport`, err: error });
    return false;
  }
};
