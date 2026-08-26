import {
  isBinaryControlled,
  isBinaryObservedOff,
  isBinaryOnOrUnknown,
} from '../../packages/shared-domain/src/binaryControlState';
import { getLogger } from '../logging/logger';
import {
  shouldSkipShedding,
} from './executorSupport';
import {
  getBinaryControlPlan,
} from '../plan/planBinaryControl';
import {
  shedActuationStampsCapacityMarkers,
} from './lifecycleReleaseRecording';
import type {
  ExecutableBinaryIntent,
  ExecutableObservedDeviceState,
  ExecutableReleaseIntent,
  ExecutorDeviceSnapshot,
} from './executablePlan';
import {
  runBinaryControl,
  skipRestoreForSurplusPosture,
  type PlanExecutorBinaryContext,
} from './binaryControlShared';
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
  intent: ExecutableBinaryIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent || !intent.desiredOn || intent.source !== 'controlled') return false;
  const snapshot = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  if (!snapshot) {
    canApplyRestoreSnapshot(ctx, {
      snapshot,
      deviceId: intent.deviceId,
      name: intent.name,
      logContext: 'capacity',
    });
    return false;
  }
  if (isBinaryOnOrUnknown(snapshot)) return false;
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity',
  })) return false;
  return applyBinaryRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot,
    logContext: 'capacity',
  });
};

export const applyUncontrolledBinaryRestore = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableBinaryIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
): Promise<boolean> => {
  if (!intent || !intent.desiredOn || intent.source !== 'uncontrolled') return false;
  const shedDecided = ctx.state.shedDecidedMs[intent.deviceId];
  if (!shedDecided) return false;
  // "Run on solar surplus" carve-out (shared home for the merge-blocking
  // invariant): a baseline-off dump load must never be force-turned-ON on
  // capacity-control-off. See `skipRestoreForSurplusPosture`.
  if (skipRestoreForSurplusPosture(ctx, intent.deviceId, intent.name)) return false;
  const entry = ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  if (!entry) {
    canApplyRestoreSnapshot(ctx, {
      snapshot: entry,
      deviceId: intent.deviceId,
      name: intent.name,
      logContext: 'capacity_control_off',
    });
    return false;
  }
  if (isBinaryOnOrUnknown(entry)) return false;
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot: entry,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity_control_off',
  })) return false;
  return applyCapacityControlOffRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot: entry,
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
    /** Trusted observer projection for lifecycle-owned dispatch. */
    snapshotOverride?: ExecutorDeviceSnapshot;
    /** Bypass observation idempotency after an accepted opposing claim releases. */
    forceAgainstReleasedOpposing?: boolean;
  },
): Promise<boolean> => {
  const {
    deviceId,
    deviceName,
    reason,
    lifecycleRelease,
    snapshotOverride,
    forceAgainstReleasedOpposing,
  } = params;
  // A lifecycle disable is off the capacity path: skip the capacity precheck and don't
  // track it as a pending capacity shed, unless the caller explicitly overrides.
  const skipPrecheck = params.skipPrecheck ?? Boolean(lifecycleRelease);
  const trackPendingShed = params.trackPendingShed ?? !lifecycleRelease;
  if (ctx.capacityDryRun && !lifecycleRelease) return false;
  const snapshotState = snapshotOverride ?? ctx.observation.getSnapshotByDeviceId(deviceId);
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
      forceAgainstReleasedOpposing,
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
      forceAgainstReleasedOpposing,
    });
  } finally {
    ctx.state.pendingSheds.delete(deviceId);
  }
};

export const applyDeferredBinaryCommand = async (
  ctx: PlanExecutorBinaryContext,
  intent: ExecutableReleaseIntent | undefined,
  observed: ExecutableObservedDeviceState | undefined,
  options: {
    preferObservedSnapshot?: boolean;
    forceAgainstReleasedOpposing?: boolean;
  } = {},
): Promise<boolean> => {
  if (!intent) return false;
  if (intent.kind === 'shed_release') return false;
  const snapshot = options.preferObservedSnapshot
    ? observed?.snapshot
    : ctx.observation.getSnapshotByDeviceId(intent.deviceId) ?? observed?.snapshot;
  // Requires a binary control handle (onoff or evcharger_charging). The actuation is
  // device-agnostic — the dispatched command's capability is derived from the device's
  // `binaryCapabilityId`, never hardcoded — so this accepts any binary control.
  if (!snapshot || !isBinaryControlled(snapshot)) return false;

  if (intent.kind === 'binary_release') {
    // A released binary device is just onoff=false; release only one that is
    // currently on. `binaryControl.on` is the consolidated binary truth.
    // Lifecycle-end release (smart task satisfied/idle), not a capacity shed:
    // lifecycleRelease routes through the diagnostic-only recorder and (by
    // default) bypasses the capacity precheck / pendingSheds path so it does not
    // stamp the cooldown markers. The binary-on check is the trusted-evidence
    // gate, mirroring applyShedReleaseBinaryOff's gate.
    if (options.forceAgainstReleasedOpposing !== true && isBinaryObservedOff(snapshot)) return false;
    return applyBinarySheddingToDevice(ctx, {
      deviceId: intent.deviceId,
      deviceName: intent.name,
      lifecycleRelease: true,
      snapshotOverride: snapshot,
      forceAgainstReleasedOpposing: options.forceAgainstReleasedOpposing === true,
    });
  }

  // Restore only an off device — i.e. released. Reads the binary truth
  // (`binaryControl.on`), not any device-specific state string. Commandability is
  // NOT re-derived here: `canApplyRestoreSnapshot` below runs the same gate
  // through `canTurnOnDevice` and logs the skip, so a second silent copy of it
  // only added a way for the two to disagree.
  if (isBinaryOnOrUnknown(snapshot)) return false;
  if (!canApplyRestoreSnapshot(ctx, {
    snapshot,
    deviceId: intent.deviceId,
    name: intent.name,
    logContext: 'capacity',
  })) return false;
  return applyBinaryRestoreWithSnapshot(ctx, {
    deviceId: intent.deviceId,
    name: intent.name,
    snapshot,
    logContext: 'capacity',
  });
};

const turnOffDevice = async (
  ctx: PlanExecutorBinaryContext,
  params: {
    deviceId: string;
    name: string;
    reason?: string;
    snapshot?: ExecutorDeviceSnapshot;
    lifecycleRelease?: boolean;
    forceAgainstReleasedOpposing?: boolean;
  },
): Promise<boolean> => {
  const {
    deviceId,
    name,
    reason,
    snapshot,
    lifecycleRelease,
    forceAgainstReleasedOpposing,
  } = params;
  const snapshotEntry = snapshot ?? ctx.observation.getSnapshotByDeviceId(deviceId);
  const controlPlan = getBinaryControlPlan(snapshotEntry);
  if (!controlPlan) {
    const hasTarget = Array.isArray(snapshotEntry?.targets) && snapshotEntry.targets.length > 0;
    if (shedActuationStampsCapacityMarkers(lifecycleRelease)) {
      const now = Date.now();
      ctx.state.markDeviceShed(deviceId, now);
    }
    logger.debug({
      event: 'binary_command_skipped',
      reasonCode: hasTarget ? 'missing_onoff_capability' : 'missing_control_targets',
      deviceId,
      deviceName: name,
      desired: false,
      logContext: 'capacity',
      hasTargets: hasTarget,
      controlAxis: 'binary',
    });
    logger.debug({ event: 'executor_binary_log_debug', msg: hasTarget
      ? `Capacity: skip turn_off for ${name}, device has no onoff capability`
      : `Capacity: skip turn_off for ${name}, device has no onoff or temperature target` });
    return false;
  }
  try {
    const outcome = await runBinaryControl({
      ctx,
      deviceId,
      name,
      desired: false,
      snapshot: snapshotEntry,
      logContext: 'capacity',
      reason,
      lifecycleRelease,
      forceAgainstReleasedOpposing,
    });
    if (!outcome.applied) return false;
    return true;
  } catch (error) {
    logger.error({ event: 'executor_binary_error', msg: `Failed to turn off ${name} via DeviceTransport`, err: error });
    return false;
  }
};
