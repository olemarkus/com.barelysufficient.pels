/**
 * Observer-owned pending-binary-command state.
 *
 * Per `notes/state-management/observer-transport-split.md` (step 6 / PR #4),
 * pending-binary-command bookkeeping is observer-owned:
 *
 * - Writes happen at dispatch time (`lib/executor/binaryControlDispatch.ts`)
 *   after the plan layer produces a `BinaryControlDecision`.
 * - Deletes happen in two places: the dispatcher clears when the actuator
 *   declines or dispatch fails, and the per-cycle sync sweep (this module's
 *   `syncPendingBinaryCommands`) clears on confirmation or timeout.
 * - Reads happen in plan/executor predicates that need to know "is a
 *   command in flight for this device?".
 *
 * The store is the canonical owner in BOTH directions: writes go through
 * `record` / `clear`, and reads go through `hasActiveCommand` /
 * `hasActiveTurnOn` / `hasActiveTurnOff` — the three in-flight questions,
 * resolved here so no consumer re-derives them. `get` (freshness-evicting) and
 * `peek` (raw) remain for the few sites that need the RECORD, or the eviction
 * itself. Plan- and executor-side consumers no longer touch
 * `state.pendingBinaryCommands[id]` directly — the store binds to that
 * backing `Record` (supplied by `PlanEngine`) but is the only path that
 * mutates or evicts it. The field survives only as the store's backing
 * store and the `isPlanActivelyConverging` emptiness probe; no consumer
 * reads or evicts it in place.
 */
import {
  type PendingBinaryCommand,
  type PendingObservationSource,
  isPendingBinaryCommandActive,
} from './pendingBinaryCommandTypes';
import { CONTROL_COMMAND_CONFIRMATION_MS } from './controlCommandConfirmation';
import { getLogger } from '../logging/logger';

export type {
  PendingBinaryCommand,
} from './pendingBinaryCommandTypes';

const logger = getLogger('observer/pending-binary-commands');
export const RECENT_CONFIRMED_BINARY_OFF_MS = 5 * 60 * 1000;

export type BinaryCommandLifecycleEvent = {
  deviceId: string;
  desired: boolean;
  startedAtMs?: number;
  settledAtMs?: number;
};

export type BinaryCommandDispatchAcceptedEvent = {
  deviceId: string;
  desired: boolean;
  startedAtMs: number;
};

export type BinaryCommandLifecycleListener = {
  onDispatchAccepted?: (event: BinaryCommandDispatchAcceptedEvent) => void;
  onDispatchFailed?: (event: BinaryCommandLifecycleEvent) => void;
  onConfirmed?: (event: BinaryCommandLifecycleEvent) => void;
  onTimedOut?: (event: BinaryCommandLifecycleEvent) => void;
};

/**
 * Observer-owned facade over the pending-binary-command map. The backing
 * `Record` is supplied by the engine at construction; it is the only SHARED
 * state the store mutates (the deferred-confirmation and recent-confirmed-off
 * maps are private to it), and plan-/executor-side consumers read it only
 * through this class — the `hasActive*` predicates for "is something in
 * flight", `get` / `peek` when the record itself is needed — so the store is
 * the single source of truth in both directions.
 */
export class PendingBinaryCommandStore {
  private readonly recentConfirmedOffByDevice = new Map<string, {
    confirmedAtMs: number;
  }>();

  constructor(
    private readonly backing: Record<string, PendingBinaryCommand>,
    private readonly lifecycle?: BinaryCommandLifecycleListener,
  ) {}

  recordDispatchAccepted(deviceId: string, command: BinaryCommandLifecycleEvent): void {
    const pending = this.backing[deviceId];
    if (!pending) return;
    // The acceptance must belong to the entry it is flipping. Plan logic may
    // supersede an in-flight command with the opposite direction — only a
    // SAME-direction command is skipped as already pending — so a late
    // acceptance from the superseded write can arrive after `record` replaced
    // the entry. Flipping on device id alone would mark the REPLACEMENT
    // accepted on the strength of its predecessor's transport call, letting an
    // echo settle a command whose own write may not have been accepted yet.
    if (pending.desired !== command.desired) return;
    this.backing[deviceId] = { ...pending, dispatchState: 'accepted' };
    this.lifecycle?.onDispatchAccepted?.({
      deviceId,
      desired: command.desired,
      startedAtMs: pending.startedMs,
    });
    // Nothing is replayed here. An echo that arrived before acceptance is not a
    // consumed event — `binaryCommandConfirmation` is a projection of the
    // device's CURRENT observed value, so it is still there on the next sweep,
    // which now sees `accepted` and confirms it. Parking a closure to fire from
    // here bought one sweep of latency and cost a stale-replay hazard: the
    // closure captured `pending`/`observation`/`liveDevice` from an older sweep,
    // and `record` replaces the entry WITHOUT clearing it, so a closure parked
    // for a superseded command could confirm its stale desired value against the
    // command that replaced it — stamping PELS-actuation provenance from it and
    // clearing the live entry. Re-reading the projection each sweep cannot go
    // stale against itself.
  }

  recordDispatchFailed(deviceId: string, command: BinaryCommandLifecycleEvent): void {
    this.lifecycle?.onDispatchFailed?.({
      ...command,
      deviceId,
      startedAtMs: this.backing[deviceId]?.startedMs,
      settledAtMs: Date.now(),
    });
  }

  lifecycleConfirmed(
    deviceId: string,
    command: PendingBinaryCommand,
    observation: ObservedBinaryCommandConfirmation,
  ): void {
    this.lifecycle?.onConfirmed?.({
      deviceId,
      desired: command.desired,
      startedAtMs: command.startedMs,
      settledAtMs: observation.observedAtMs,
    });
  }

  lifecycleTimedOut(deviceId: string, command: PendingBinaryCommand): void {
    this.lifecycle?.onTimedOut?.({
      deviceId,
      desired: command.desired,
      startedAtMs: command.startedMs,
      settledAtMs: Date.now(),
    });
  }

  /** Record a freshly issued command keyed by `deviceId`; replaces any prior entry. */
  record(deviceId: string, command: Omit<PendingBinaryCommand, 'dispatchState'>): void {
    this.backing[deviceId] = { ...command, dispatchState: 'dispatching' };
  }

  /** Whether transport accepted the request and observer settlement may commit it. */
  isDispatchAccepted(deviceId: string): boolean {
    return this.backing[deviceId]?.dispatchState === 'accepted';
  }

  /**
   * Preserve telemetry-confirmed PELS actuation provenance after pending is
   * cleared. This covers later duplicate/reordered OFF observations. It is
   * deliberately never created from request acceptance alone: after the
   * pending window, an unconfirmed OFF is indistinguishable from a user's
   * manual action and must remain eligible to start an external-off hold.
   */
  recordConfirmedBinaryCommand(params: {
    deviceId: string;
    desired: boolean;
    confirmedAtMs?: number;
  }): void {
    const {
      deviceId, desired, confirmedAtMs = Date.now(),
    } = params;
    const current = this.recentConfirmedOffByDevice.get(deviceId);
    if (desired) {
      if (
        current && confirmedAtMs > current.confirmedAtMs
      ) {
        this.recentConfirmedOffByDevice.delete(deviceId);
      }
      return;
    }
    if (current && current.confirmedAtMs > confirmedAtMs) return;
    this.recentConfirmedOffByDevice.set(deviceId, { confirmedAtMs });
  }

  hasRecentConfirmedOff(
    deviceId: string,
    nowMs = Date.now(),
  ): boolean {
    const recent = this.recentConfirmedOffByDevice.get(deviceId);
    if (!recent) return false;
    if ((nowMs - recent.confirmedAtMs) >= RECENT_CONFIRMED_BINARY_OFF_MS) {
      this.recentConfirmedOffByDevice.delete(deviceId);
      return false;
    }
    return true;
  }

  clearRecentConfirmedOff(
    deviceId: string,
    observedOnAtMs?: number,
  ): void {
    const recent = this.recentConfirmedOffByDevice.get(deviceId);
    if (
      recent && (observedOnAtMs === undefined || observedOnAtMs > recent.confirmedAtMs)
    ) {
      this.recentConfirmedOffByDevice.delete(deviceId);
    }
  }

  isBinaryChangeAttributableToPels(
    deviceId: string,
  ): boolean {
    return this.get(deviceId) !== undefined || this.hasRecentConfirmedOff(deviceId);
  }

  /** Clear the pending entry for a device, if any. */
  clear(deviceId: string): void {
    delete this.backing[deviceId];
  }

  /** Return the active pending entry, transparently evicting stale entries. */
  get(deviceId: string): PendingBinaryCommand | undefined {
    const entry = this.backing[deviceId];
    if (!entry) return undefined;
    const nowMs = Date.now();
    if (isPendingBinaryCommandActive({ pending: entry, nowMs })) return entry;
    delete this.backing[deviceId];
    this.lifecycleTimedOut(deviceId, entry);
    logger.debug({
      event: 'pending_binary_command_cleared',
      reason: 'stale_age',
      deviceId,
      desired: entry.desired,
      ageMs: nowMs - entry.startedMs,
      timeoutMs: CONTROL_COMMAND_CONFIRMATION_MS,
    });
    return undefined;
  }

  /**
   * Return the raw pending entry without freshness-eviction; used by plan
   * helpers that read fields like `desired` even after the window expired.
   */
  peek(deviceId: string): PendingBinaryCommand | undefined {
    return this.backing[deviceId];
  }

  /**
   * The three in-flight questions, answered here so no consumer re-derives them.
   *
   * They exist because "is a binary command in flight" is really two different
   * questions and the answers are not interchangeable: the owner-facing
   * "Resuming" state and the restore serializer want a pending turn-ON, while
   * the shortfall log wants ANY direction (a turn-OFF is as much mid-actuation
   * as a turn-ON). Hand-rolling either from `peek` is how the same field name
   * came to mean both, so read the question you actually mean.
   *
   * Non-evicting by construction: an expired entry answers `false` but stays in
   * the backing store, because eviction fires the timeout lifecycle and belongs
   * to `get`/`reconcilePendingEntry`, not to a predicate a projection may call.
   */
  hasActiveCommand(deviceId: string): boolean {
    return isPendingBinaryCommandActive({ pending: this.backing[deviceId] });
  }

  /** A pending turn-ON, specifically. See {@link hasActiveCommand}. */
  hasActiveTurnOn(deviceId: string): boolean {
    return this.hasActiveCommand(deviceId) && this.backing[deviceId]?.desired === true;
  }

  /** A pending turn-OFF, specifically. See {@link hasActiveCommand}. */
  hasActiveTurnOff(deviceId: string): boolean {
    return this.hasActiveCommand(deviceId) && this.backing[deviceId]?.desired === false;
  }

  /** True if the store carries at least one entry. */
  hasAny(): boolean {
    return Object.keys(this.backing).length > 0;
  }

  /** Iterate all entries (active + expired). Order is insertion order. */
  entries(): Array<[string, PendingBinaryCommand]> {
    return Object.entries(this.backing);
  }
}

export function createPendingBinaryCommandStore(
  backing: Record<string, PendingBinaryCommand>,
  lifecycle?: BinaryCommandLifecycleListener,
): PendingBinaryCommandStore {
  return new PendingBinaryCommandStore(backing, lifecycle);
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
 */
export function syncPendingBinaryCommands(params: {
  store: PendingBinaryCommandStore;
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
  const { store, liveDevices, source, onConfirmed } = params;
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
  })) {
    store.clear(deviceId);
    store.lifecycleTimedOut(deviceId, pending);
    logger.debug({
      event: 'pending_binary_command_timed_out',
      deviceId,
      deviceName: liveDevice ? liveDevice.name : undefined,
      controlAxis: 'binary',
      desired: pending.desired,
      ageMs: nowMs - pending.startedMs,
      timeoutMs: CONTROL_COMMAND_CONFIRMATION_MS,
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
    // Observer settlement may only commit once transport has accepted the
    // request. Until then this is a no-op, NOT a deferral: the observation is a
    // projection of the device's current value, so the next sweep sees the same
    // echo against an accepted entry and confirms it then. A contradiction
    // arriving first simply falls through below and supersedes it, with no
    // parked evidence to cancel.
    if (!store.isDispatchAccepted(deviceId)) return false;
    confirmPendingBinaryCommand({
      store, deviceId, pending, liveDevice, source, observation, onConfirmed,
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
    controlAxis: 'binary',
    observedValue,
    expected: pending.desired,
    source,
  });
  return true;
}

function confirmPendingBinaryCommand(params: {
  store: PendingBinaryCommandStore;
  deviceId: string;
  pending: PendingBinaryCommand;
  liveDevice: PendingBinaryLiveDevice;
  source: PendingObservationSource;
  observation: ObservedBinaryCommandConfirmation;
  onConfirmed?: (params: {
    deviceId: string;
    liveDevice: PendingBinaryLiveDevice;
    pending: PendingBinaryCommand;
    source: PendingObservationSource;
    confirmedAtMs: number;
  }) => void;
}): void {
  const {
    store, deviceId, pending, liveDevice, source, observation, onConfirmed,
  } = params;
  store.recordConfirmedBinaryCommand({
    deviceId,
    desired: pending.desired,
    confirmedAtMs: observation.observedAtMs,
  });
  onConfirmed?.({
    deviceId,
    liveDevice,
    pending,
    source,
    confirmedAtMs: observation.observedAtMs,
  });
  store.lifecycleConfirmed(deviceId, pending, observation);
  store.clear(deviceId);
  logger.debug({
    event: 'pending_binary_command_confirmed',
    deviceId,
    deviceName: liveDevice.name,
    controlAxis: 'binary',
    observedValue: observation.observedValue,
    source,
  });
}

/**
 * The structural shape `syncPendingBinaryCommands` needs from a live
 * device. Mirrors `PlanInputDevice` fields without dragging the plan
 * layer into observer's import graph.
 *
 * The producer explicitly projects only these confirmation facts; raw transport
 * capability and Flow bindings never enter this observer/planner handoff.
 */
export type PendingBinaryLiveDevice = {
  id: string;
  name: string;
  binaryCommandConfirmation:
    | { state: 'unavailable' }
    | {
      state: 'observed';
      observedValue: boolean;
      observedAtMs: number;
    };
};

type ObservedBinaryCommandConfirmation = Extract<
  PendingBinaryLiveDevice['binaryCommandConfirmation'],
  { state: 'observed' }
>;

function getSettlingBinaryObservation(
  liveDevice: PendingBinaryLiveDevice,
  pending: PendingBinaryCommand,
): ObservedBinaryCommandConfirmation | undefined {
  const observation = liveDevice.binaryCommandConfirmation;
  if (observation.state === 'unavailable') return undefined;
  if (!Number.isFinite(observation.observedAtMs)) return undefined;
  // Millisecond timestamps can be equal when Homey echoes the capability value
  // synchronously inside the SDK write. The command was only dispatched because
  // the prior observed value disagreed, so a matching observation at the same
  // timestamp is valid post-dispatch evidence.
  if (observation.observedAtMs < pending.startedMs) return undefined;
  return observation;
}
