/**
 * Observer-owned per-write settle window for binary capabilities.
 *
 * When PELS writes `onoff` or `evcharger_charging`, observer opens a
 * short-lived window keyed by `deviceId+capabilityId`. The window's job
 * is to reconcile what the device reports back against what PELS asked
 * for, and to emit a `plan_reconcile` event whenever the observation
 * disagrees ("drift"). On confirmation the window closes silently; on
 * timeout, it falls back to the current snapshot to decide whether
 * drift escalation is warranted.
 *
 * Lives in `lib/observer/` (was `lib/device/managerBinarySettle.ts`)
 * per PR #4 of the observer/transport split — see
 * `notes/state-management/observer-transport-split.md`. Observer is a
 * leaf in the cruiser graph, so this module's dependencies are kept
 * structural: the few pieces of behavior that historically lived in
 * `lib/device/transport/managerRealtimeSupport.ts` (formatting a
 * binary value, expiring an "I just wrote this" suppression entry)
 * arrive via the `deps` bag rather than as direct module references.
 *
 * Transport (the only producer of binary writes) still calls the
 * functions here directly; the state object travels via DI from
 * wiring (`app.ts`) so transport never statically references the
 * observer layer.
 */
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

export const LOCAL_BINARY_SETTLE_WINDOW_MS = 5 * 1000;

const BINARY_SETTLE_CAPABILITY_IDS = ['onoff', 'evcharger_charging'] as const;
type BinarySettleCapabilityId = (typeof BINARY_SETTLE_CAPABILITY_IDS)[number];

type PendingBinarySettleWindow = {
  deviceId: string;
  capabilityId: string;
  deviceName?: string;
  desired: boolean;
  timer: ReturnType<typeof setTimeout>;
};

export type BinarySettleState = {
  pendingBinarySettleWindows: Map<string, PendingBinarySettleWindow>;
};

/**
 * Structural reconcile event shape — mirrors the subset of
 * `PlanRealtimeUpdateEvent` (transport-side type) that the settle path
 * actually populates. Defined here to keep observer's import graph free
 * of `lib/device/` types.
 */
export type BinarySettleReconcileEvent = {
  deviceId: string;
  observationSeq?: number;
  observedAtMs?: number;
  name?: string;
  capabilityId?: string;
  changes?: Array<{
    capabilityId: string;
    previousValue: string;
    nextValue: string;
  }>;
};

export type BinarySettleObservationCursor = {
  observationSeq?: number;
  observedAtMs?: number;
};

type BinarySettleDeps = {
  logger: {
    structuredLog?: {
      info?: (payload: Record<string, unknown>) => void;
    };
  };
  /**
   * Clear the matching "I just wrote this" suppression entry when the
   * settle window closes. Owned by transport (the source of those
   * entries); passed in as a callback so observer doesn't import the
   * map type from `lib/device/`.
   */
  clearLocalCapabilityWrite: (params: {
    deviceId: string;
    capabilityId: string;
  }) => void;
  isLiveFeedHealthy: () => boolean;
  shouldTrackRealtimeDevice: (deviceId: string) => boolean;
  getSnapshotById: (deviceId: string) => TargetDeviceSnapshot | undefined;
  emitPlanReconcile: (event: BinarySettleReconcileEvent) => void;
};

export function createBinarySettleState(): BinarySettleState {
  return {
    pendingBinarySettleWindows: new Map(),
  };
}

export function hasPendingBinarySettleWindow(
  state: BinarySettleState,
  deviceId: string,
  capabilityId: string,
): boolean {
  return state.pendingBinarySettleWindows.has(buildPendingBinarySettleKey(deviceId, capabilityId));
}

export function clearPendingBinarySettleWindow(
  state: BinarySettleState,
  deviceId: string,
  capabilityId: string,
): void {
  const key = buildPendingBinarySettleKey(deviceId, capabilityId);
  const pending = state.pendingBinarySettleWindows.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  state.pendingBinarySettleWindows.delete(key);
}

export function clearAllPendingBinarySettleWindows(state: BinarySettleState): void {
  for (const pending of state.pendingBinarySettleWindows.values()) {
    clearTimeout(pending.timer);
  }
  state.pendingBinarySettleWindows.clear();
}

export function startPendingBinarySettleWindow(params: {
  state: BinarySettleState;
  deps: BinarySettleDeps;
  deviceId: string;
  capabilityId: string;
  value: unknown;
  deviceName?: string;
}): void {
  const {
    state, deps, deviceId, capabilityId, value, deviceName,
  } = params;
  if (typeof value !== 'boolean') return;
  if (!isBinarySettleCapability(capabilityId)) return;
  if (!deps.isLiveFeedHealthy()) return;

  clearPendingBinarySettleWindow(state, deviceId, capabilityId);
  const key = buildPendingBinarySettleKey(deviceId, capabilityId);
  const timer = setTimeout(() => {
    finalizePendingBinarySettleWindow(state, key, deps);
  }, LOCAL_BINARY_SETTLE_WINDOW_MS);
  state.pendingBinarySettleWindows.set(key, {
    deviceId,
    capabilityId,
    deviceName,
    desired: value,
    timer,
  });
}

export function notePendingBinarySettleObservation(params: {
  state: BinarySettleState;
  deps: BinarySettleDeps;
  deviceId: string;
  capabilityId: string;
  value: boolean;
  source: 'realtime_capability' | 'device_update';
  ensureEventFields?: () => BinarySettleObservationCursor;
}): 'settled' | 'drift' | 'none' {
  const {
    state, deps, deviceId, capabilityId, value, source, ensureEventFields,
  } = params;
  const key = buildPendingBinarySettleKey(deviceId, capabilityId);
  const pending = state.pendingBinarySettleWindows.get(key);
  if (!pending) return 'none';

  clearTimeout(pending.timer);
  state.pendingBinarySettleWindows.delete(key);

  const outcome = value === pending.desired ? 'settled' : 'drift';
  deps.logger.structuredLog?.info?.({
    event: 'binary_write_observed',
    deviceId,
    ...buildBinarySettleDeviceNameFields(pending.deviceName),
    capabilityId,
    desired: pending.desired,
    observed: value,
    source,
    outcome,
  });

  deps.clearLocalCapabilityWrite({ deviceId, capabilityId });

  if (outcome === 'drift') {
    deps.emitPlanReconcile({
      deviceId,
      ...ensureEventFields?.(),
      name: pending.deviceName,
      capabilityId,
      changes: [{
        capabilityId,
        previousValue: formatBinaryValue(pending.desired),
        nextValue: formatBinaryValue(value),
      }],
    });
  }

  return outcome;
}

function finalizePendingBinarySettleWindow(
  state: BinarySettleState,
  key: string,
  deps: BinarySettleDeps,
): void {
  const pending = state.pendingBinarySettleWindows.get(key);
  if (!pending) return;
  state.pendingBinarySettleWindows.delete(key);
  deps.clearLocalCapabilityWrite({
    deviceId: pending.deviceId,
    capabilityId: pending.capabilityId,
  });
  if (!deps.shouldTrackRealtimeDevice(pending.deviceId)) return;

  const snapshot = deps.getSnapshotById(pending.deviceId);
  if (!snapshot) return;

  deps.logger.structuredLog?.info?.({
    event: 'binary_write_timeout',
    deviceId: pending.deviceId,
    ...buildBinarySettleDeviceNameFields(pending.deviceName),
    capabilityId: pending.capabilityId,
    desired: pending.desired,
  });

  const observed = snapshot.binaryControl?.on;
  if (observed === pending.desired) return;

  const changes = typeof observed === 'boolean'
    ? [{
      capabilityId: pending.capabilityId,
      previousValue: formatBinaryValue(pending.desired),
      nextValue: formatBinaryValue(observed),
    }]
    : undefined;
  deps.emitPlanReconcile({
    deviceId: pending.deviceId,
    name: snapshot.name,
    capabilityId: pending.capabilityId,
    changes,
  });
}

function buildPendingBinarySettleKey(deviceId: string, capabilityId: string): string {
  return `${deviceId}:${capabilityId}`;
}

function buildBinarySettleDeviceNameFields(deviceName?: string): { deviceName?: string } {
  return typeof deviceName === 'string' && deviceName.length > 0
    ? { deviceName }
    : {};
}

function isBinarySettleCapability(capabilityId: string): capabilityId is BinarySettleCapabilityId {
  return BINARY_SETTLE_CAPABILITY_IDS.includes(capabilityId as BinarySettleCapabilityId);
}

function formatBinaryValue(value: boolean | undefined): string {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'unknown';
}
