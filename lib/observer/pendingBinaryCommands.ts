/**
 * Observer-owned pending-binary-command state.
 *
 * Per `notes/state-management/observer-transport-split.md` (step 6 / PR #4),
 * pending-binary-command bookkeeping is observer-owned:
 *
 * - Writes happen at dispatch time (`lib/executor/binaryControlDispatch.ts`)
 *   after the plan layer produces a `BinaryControlDecision`.
 * - Deletes happen in two places: the dispatcher's catch arm clears on
 *   `dispatch_failed`, and the per-cycle sync sweep (this module's
 *   `syncPendingBinaryCommands`) clears on confirmation or timeout.
 * - Reads happen in plan/executor predicates that need to know "is a
 *   command in flight for this device?".
 *
 * The store is the canonical owner in BOTH directions: writes go through
 * `record` / `clear`, and reads go through `get` (freshness-evicting) or
 * `peek` (raw). Plan- and executor-side consumers no longer touch
 * `state.pendingBinaryCommands[id]` directly — the store binds to that
 * backing `Record` (supplied by `PlanEngine`) but is the only path that
 * mutates or evicts it. The field survives only as the store's backing
 * store, the legacy state-form of `syncPendingBinaryCommands`, and the
 * `isPlanActivelyConverging` emptiness probe; no consumer reads or
 * evicts it in place.
 */
import {
  type PendingBinaryCommand,
  type PendingObservationSource,
  getPendingBinaryCommandWindowMs,
  isPendingBinaryCommandActive,
} from './pendingBinaryCommandTypes';
import { getLogger } from '../logging/logger';
import { formatPendingBinaryObservedValue } from './pendingBinaryCommandFormatting';

export type {
  PendingBinaryCommand,
} from './pendingBinaryCommandTypes';

const logger = getLogger('observer/pending-binary-commands');

/**
 * Observer-owned facade over the pending-binary-command map. The backing
 * `Record` is supplied by the engine at construction; it is the only
 * thing the store mutates, and plan-/executor-side consumers read it
 * exclusively through `get` (freshness-evicting) or `peek` (raw) so the
 * store is the single source of truth in both directions.
 */
export type PendingBinaryCommandStore = {
  /** Record a freshly issued command keyed by `deviceId`; replaces any prior entry. */
  record(deviceId: string, command: PendingBinaryCommand): void;
  /** Clear the pending entry for a device, if any. */
  clear(deviceId: string): void;
  /** Return the active pending entry, transparently evicting stale entries. */
  get(deviceId: string): PendingBinaryCommand | undefined;
  /**
   * Return the raw pending entry without freshness-eviction; used by plan
   * helpers that read fields like `desired` even after the window expired.
   */
  peek(deviceId: string): PendingBinaryCommand | undefined;
  /** True if the device currently has any pending entry (active or expired). */
  has(deviceId: string): boolean;
  /** True if the store carries at least one entry. */
  hasAny(): boolean;
  /** Iterate all entries (active + expired). Order is insertion order. */
  entries(): Array<[string, PendingBinaryCommand]>;
};

export function createPendingBinaryCommandStore(
  backing: Record<string, PendingBinaryCommand>,
): PendingBinaryCommandStore {
  /* eslint-disable functional/immutable-data, no-param-reassign --
     observer-owned mutator: backing is the engine-state field plan reads transparently. */
  return {
    record(deviceId, command) {
      backing[deviceId] = command;
    },
    clear(deviceId) {
      delete backing[deviceId];
    },
    get(deviceId) {
      const entry = backing[deviceId];
      if (!entry) return undefined;
      const nowMs = Date.now();
      if (isPendingBinaryCommandActive({ pending: entry, nowMs })) return entry;
      delete backing[deviceId];
      logger.debug({
        event: 'pending_binary_command_cleared',
        reason: 'stale_age',
        deviceId,
        capabilityId: entry.capabilityId,
        desired: entry.desired,
        ageMs: nowMs - entry.startedMs,
        timeoutMs: getPendingBinaryCommandWindowMs(entry),
      });
      return undefined;
    },
    peek(deviceId) {
      return backing[deviceId];
    },
    has(deviceId) {
      return Object.prototype.hasOwnProperty.call(backing, deviceId);
    },
    hasAny() {
      return Object.keys(backing).length > 0;
    },
    entries() {
      return Object.entries(backing);
    },
  };
  /* eslint-enable functional/immutable-data, no-param-reassign */
}

/**
 * Per-cycle reconciliation sweep. For every pending entry, either:
 *
 * - confirm and clear (telemetry on the matching capability arrived with
 *   the desired value) — invokes `onConfirmed` first,
 * - drop and clear (window expired without confirmation),
 * - record progress (an observation that disagrees with desired updates
 *   the `lastObserved*` fields for diagnostics).
 *
 * Returns true when at least one entry changed (added, removed, or
 * progress fields mutated). This drives the live-plan refresh in
 * `PlanService.syncLivePlanState`.
 *
 * Accepts either an explicit `store` (production wiring) or a `state`
 * shape carrying `pendingBinaryCommands` (legacy plan-side callers).
 * The state-form derives an ephemeral store bound to the backing
 * record, which the legacy callers then continue to read via the
 * `state.pendingBinaryCommands` field.
 */
export function syncPendingBinaryCommands(params: {
  store?: PendingBinaryCommandStore;
  state?: { pendingBinaryCommands: Record<string, PendingBinaryCommand> };
  liveDevices: PendingBinaryLiveDevice[];
  source: PendingObservationSource;
  onConfirmed?: (params: {
    deviceId: string;
    liveDevice: PendingBinaryLiveDevice;
    pending: PendingBinaryCommand;
    source: PendingObservationSource;
    confirmedAtMs: number;
  }) => void;
}): boolean {
  const { liveDevices, source, onConfirmed } = params;
  const store = resolveStore(params);
  const liveById = new Map(liveDevices.map((device) => [device.id, device]));
  const nowMs = Date.now();
  let changed = false;

  for (const [deviceId, pending] of store.entries()) {
    const liveDevice = liveById.get(deviceId);
    if (reconcilePendingEntry({
      store, deviceId, pending, liveDevice, source, nowMs, onConfirmed,
    })) {
      changed = true;
    }
  }

  return changed;
}

function reconcilePendingEntry(params: {
  store: PendingBinaryCommandStore;
  deviceId: string;
  pending: PendingBinaryCommand;
  liveDevice: PendingBinaryLiveDevice | undefined;
  source: PendingObservationSource;
  nowMs: number;
  onConfirmed?: (params: {
    deviceId: string;
    liveDevice: PendingBinaryLiveDevice;
    pending: PendingBinaryCommand;
    source: PendingObservationSource;
    confirmedAtMs: number;
  }) => void;
}): boolean {
  const { store, deviceId, pending, liveDevice, source, nowMs, onConfirmed } = params;
  if (!isPendingBinaryCommandActive({
    pending,
    nowMs,
    communicationModel: liveDevice?.communicationModel,
  })) {
    store.clear(deviceId);
    logger.debug({
      event: 'pending_binary_command_timed_out',
      deviceId,
      deviceName: liveDevice ? liveDevice.name : undefined,
      capabilityId: pending.capabilityId,
      desired: pending.desired,
      ageMs: nowMs - pending.startedMs,
      timeoutMs: getPendingBinaryCommandWindowMs(pending),
      lastObservedValue: pending.lastObservedValue,
      lastObservedSource: pending.lastObservedSource,
    });
    return true;
  }
  if (!liveDevice) return false;

  const observation = getSettlingBinaryObservation(liveDevice, pending);
  if (!observation) return false;
  const observedValue = observation.observedValue;
  if (observedValue === pending.desired) {
    onConfirmed?.({
      deviceId,
      liveDevice,
      pending,
      source,
      confirmedAtMs: observation.observedAtMs,
    });
    store.clear(deviceId);
    logger.debug({
      event: 'pending_binary_command_confirmed',
      deviceId,
      deviceName: liveDevice.name,
      capabilityId: pending.capabilityId,
      observedValue: formatPendingBinaryObservedValue(pending.capabilityId, observedValue),
      source,
    });
    return true;
  }

  if (
    pending.lastObservedValue === observedValue
    && pending.lastObservedSource === source
    && pending.lastObservedAtMs === observation.observedAtMs
  ) {
    return false;
  }
  // Persist the latest disagreeing observation as a diagnostic breadcrumb;
  // the entry itself is the canonical observer-owned record so in-place
  // updates keep the live-plan refresh on the same identity.
  /* eslint-disable functional/immutable-data --
     observer-owned pending entry: in-place breadcrumb update preserved
     for diagnostic continuity (pre-PR-4 behaviour). */
  pending.lastObservedValue = observedValue;
  pending.lastObservedSource = source;
  pending.lastObservedAtMs = observation.observedAtMs;
  /* eslint-enable functional/immutable-data */
  logger.debug({
    event: 'pending_binary_command_waiting',
    deviceId,
    deviceName: liveDevice.name,
    capabilityId: pending.capabilityId,
    observedValue: formatPendingBinaryObservedValue(pending.capabilityId, observedValue),
    expected: formatPendingBinaryObservedValue(pending.capabilityId, pending.desired),
    source,
  });
  return true;
}

function resolveStore(params: {
  store?: PendingBinaryCommandStore;
  state?: { pendingBinaryCommands: Record<string, PendingBinaryCommand> };
}): PendingBinaryCommandStore {
  if (params.store) return params.store;
  if (!params.state) {
    throw new Error('syncPendingBinaryCommands requires either a store or a state with pendingBinaryCommands');
  }
  return createPendingBinaryCommandStore(params.state.pendingBinaryCommands);
}

/**
 * The structural shape `syncPendingBinaryCommands` needs from a live
 * device. Mirrors `PlanInputDevice` fields without dragging the plan
 * layer into observer's import graph.
 */
export type PendingBinaryLiveDevice = {
  id: string;
  name: string;
  communicationModel?: 'local' | 'cloud';
  evChargingState?: string;
  binaryControlObservation?: PendingBinaryObservationSnapshot;
};

export type PendingBinaryObservationSnapshot = {
  capabilityId: 'onoff' | 'evcharger_charging';
  observedValue: boolean;
  observedAtMs: number;
  observedCapabilityIds: string[];
};

function getSettlingBinaryObservation(
  liveDevice: PendingBinaryLiveDevice,
  pending: PendingBinaryCommand,
): PendingBinaryObservationSnapshot | undefined {
  const observation = liveDevice.binaryControlObservation;
  if (!observation) return undefined;
  if (observation.capabilityId !== pending.capabilityId) return undefined;
  if (!Number.isFinite(observation.observedAtMs)) return undefined;
  if (observation.observedAtMs <= pending.startedMs) return undefined;
  if (pending.capabilityId === 'evcharger_charging') return resolveSettlingEvObservation(liveDevice, observation);
  return observation;
}

function resolveSettlingEvObservation(
  liveDevice: PendingBinaryLiveDevice,
  observation: PendingBinaryObservationSnapshot,
): PendingBinaryObservationSnapshot | undefined {
  const rawStateValue = liveDevice.evChargingState;
  if (rawStateValue === undefined) {
    return observation.observedCapabilityIds.includes('evcharger_charging_state')
      ? undefined
      : observation;
  }
  const observedFromState = observation.observedCapabilityIds.includes('evcharger_charging_state');
  if (!observedFromState) return undefined;
  return observation;
}
