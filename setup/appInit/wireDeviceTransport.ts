/**
 * Construction and event wiring of the app's single `DeviceTransport`, sliced
 * out of `setup/appServiceWiring.ts` to keep that entry point under the line
 * budget. This is the whole former `AppServiceWiring.initDeviceManager` body:
 * the observed-state projection epoch, the boundary-resolved whole-home meter
 * authority, the four transport dep bags, and the observer-emitter
 * subscriptions that feed the projection. Plan-dependent subscriptions are
 * wired later by `planObservedStateSubscription.ts`.
 *
 * The projection subscriptions retain their load-bearing registration order.
 */
import type Homey from 'homey';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import type { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import type { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import {
  createCalibrationSnapshotMutationHook,
  type PowerCalibrationStore,
} from '../../lib/device/devicePowerCalibrationStore';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import type { HomeMembershipService } from '../homeMembership';
import { buildDeviceParseProviders } from './buildDeviceParseProviders';
import { createExternalOffHoldPolicy } from '../externalOffHoldAdapter';
import { createPersistedEvCarLinkAccess } from './evCarLinkAccess';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';

// The probe's decisions are time-based; mirrors the pre-extraction constant in
// `appServiceWiring.ts` (30 s — well inside the shortest 90 s probe deadline).
const EV_CAR_LINK_TICK_INTERVAL_MS = 30 * 1000;
import { readMainMeterSelection } from '../mainMeterSettings';

// Boundary-resolved whole-home meter authority for the homey_energy source.
// `resolved/null` = Automatic; `unavailable` suppresses Main sampling instead
// of silently promoting an SDK miss to Automatic. Read fresh per call so the
// 10s poll picks up a changed selection without a transport restart.
const resolveHomeyEnergyMeterSelection = (homey: Homey.App['homey']): MainMeterSelection => {
  return readMainMeterSelection(homey.settings);
};

/**
 * The wiring surface this module reads. Declared structurally (like
 * `OvershootTrackerDeps` in the planner) so it never imports
 * `appServiceWiring.ts` back — `AppServiceWiring` passes its own dep bag plus
 * the two lazy getters over its private fields.
 */
export type DeviceTransportWiringDeps = {
  ctx: AppContext;
  homeyApp: Homey.App;
  getStructuredLogger: () => PinoLogger | undefined;
  installStructuredLogger: () => PinoLogger;
  getPowerCalibrationStore: () => PowerCalibrationStore;
  getObservedStateEmitter: () => ObservedStateEmitter;
  getObservedHomePower: () => ObservedHomePower;
  getObservedDeviceStateProjection: () => ObservedDeviceStateProjection;
  setObservedDeviceStateProjection: (projection: ObservedDeviceStateProjection) => void;
  isManagedFilterActive: () => boolean;
  /** Rate-limited, change-gated write of the learned measured peaks. */
  persistLearnedPowerPeaks: () => void;
  resolveNativeWiringEnabled: (deviceId: string) => boolean;
  getDeviceDriverIdOverride: (deviceId: string) => string | undefined;
  getFlowConflict: (deviceId: string) => { conflictingCapabilities: readonly string[]; flowName?: string } | undefined;
  /** Owns the `evCarLinkTick` heartbeat registered after transport init. */
  timers: TimerRegistry;
  /** Lazy over `AppServiceWiring`'s private field — the registry is built later. */
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined;
  /** Lazy for the same reason: the membership service is built after the transport. */
  getHomeMembershipService: () => HomeMembershipService | undefined;
};

/**
 * Feeds the observer-owned projection. Registered with the transport (inside
 * `initDeviceManager`) because it depends on nothing but the projection itself
 * — the plan-dependent listeners are registered separately, later, by
 * {@link subscribePlanObservedState}.
 *
 * Wiring subscribes to the observer-owned emitter rather than the transport-side
 * EventEmitter. Transport's dispatcher routes every post-translation event
 * through `observedStateEmitter`, which is the single source of truth for
 * realtime fan-out post-PR #5. See
 * notes/state-management/observer-transport-split.md.
 *
 * These two register FIRST, before any listener that reads the projection.
 * Listeners fire in registration order, and `syncLivePlanState` in the plan-side
 * subscription reads the projection (via `toPlanDevice`'s
 * `currentOn`/`currentState`); applying the event here first ensures that pass
 * sees the freshly-merged observed value for the same event instead of the
 * previous one (stage 4b). Splitting the subscription in two PRESERVES that
 * order — the plan-side listeners can only ever register later.
 *
 * NB: the projection is seeded lazily on the first plan build
 * (`createPlanService.getPlanDevices` → `ctx.seedObservedStateFromSnapshot`),
 * not here: right after this wiring the transport's `getSnapshot()` is still
 * empty (transport `init()` only attaches the live feed; the first snapshot
 * arrives with the bootstrap refresh, which dispatches its own refresh into
 * the projection). Seeding here would be a guaranteed no-op.
 */
function subscribeObservedStateProjection(deps: DeviceTransportWiringDeps): void {
  const emitter = deps.getObservedStateEmitter();
  emitter.onObservedStateChanged((e) => deps.getObservedDeviceStateProjection().applyDelta(e));
  emitter.onObservedStateRefresh((e) => deps.getObservedDeviceStateProjection().applyRefresh(e));
}

export async function wireDeviceTransport(deps: DeviceTransportWiringDeps): Promise<void> {
  const { ctx } = deps;
  const structuredLogger = deps.getStructuredLogger() ?? deps.installStructuredLogger();
  const structuredLog = structuredLogger.child({ component: 'devices' });
  // Co-create the observed-state projection with the transport so their
  // lifecycles are coupled. The projection's sequence guard is keyed on the
  // transport's per-device `observationSeq`; a new DeviceTransport resets those
  // counters, so a long-lived projection would drop a fresh transport's early
  // deltas (seq <= the previous transport's higher seqs). This runs once today
  // (no in-process restart path), so it is currently equivalent to the field
  // initializer — but it documents and enforces the transport/projection epoch
  // coupling for any future restart. The persistent emitter subscription reads
  // the projection getter at event time, so reassigning the field is sufficient.
  deps.setObservedDeviceStateProjection(new ObservedDeviceStateProjection());
  // "Leave off until turned on again". Constructed here so the persisted holds
  // are visible before the first plan cycle can resume anything — a hold that
  // survived a restart must win over the first rebuild, not lose a race with it.
  // The blob→per-key migration needs no sequencing from this side: the policy
  // asserts it on every read, so it cannot be built against an unmigrated store
  // and it heals itself if the SDK was failing at boot. Assigned onto ctx (the
  // wiring-assigns-ctx-members house pattern).
  // eslint-disable-next-line functional/immutable-data -- shared AppContext write
  ctx.externalOffHold = createExternalOffHoldPolicy(ctx.homey.settings);
  const observeCalibrationSnapshotMutation = createCalibrationSnapshotMutationHook({
    getStore: () => deps.getPowerCalibrationStore(),
    debugStructured: ctx.getStructuredDebugEmitter('power_calibration', 'power_calibration'),
  });
  const deviceManager = new DeviceTransport(deps.homeyApp, {
    log: ctx.log.bind(ctx),
    debug: (...args: unknown[]) => ctx.logDebug('devices', ...args),
    error: ctx.error.bind(ctx),
    structuredLog,
  }, buildDeviceParseProviders({
    ctx,
    deps,
    getHomeRuntimeRegistry: deps.getHomeRuntimeRegistry,
    resolveMeterSelection: () => resolveHomeyEnergyMeterSelection(ctx.homey),
  }), {
    expectedPowerKwOverrides: ctx.expectedPowerKwOverrides,
    lastKnownPowerKw: ctx.lastKnownPowerKw,
    lastPositiveMeasuredPowerKw: ctx.lastPositiveMeasuredPowerKw,
    // Driven off the learned-peak mutation, NOT the snapshot-mutation seam
    // below. That seam fires on a changed calibration input, and a reading equal
    // to the standing peak changes none of them while still re-anchoring the
    // window — so the peak of the steadiest devices, the ones the estimate most
    // depends on, would have expired in settings while memory said it was fresh.
    // The persist is itself rate-limited and change-gated.
    onLearnedPeakChanged: () => deps.persistLearnedPowerPeaks(),
  }, {
    debugStructured: ctx.getStructuredDebugEmitter('devices', 'devices'),
    getFlowTriggerCard: (cardId) => ctx.homey.flow?.getTriggerCard?.(cardId),
    onSnapshotMutated: (snapshot, nowMs) => {
      observeCalibrationSnapshotMutation(snapshot, nowMs);
      ctx.deviceControlHelpers.reconcileTargetPowerReachability([snapshot], nowMs);
    },
    observedStateDispatcher: deps.getObservedStateEmitter().asDispatcher(deps.getObservedHomePower()),
    evCarLinkSnapshotAccess: createPersistedEvCarLinkAccess(ctx.homey, deps.timers),
  });
  // eslint-disable-next-line functional/immutable-data -- shared AppContext write
  ctx.deviceManager = deviceManager;
  await deviceManager.init();
  // The probe's decisions are time-based — edge settlement, away verdicts, and
  // the self-stop dwell all need 90-180 s to elapse. Without a heartbeat they
  // are only evaluated when unrelated telemetry happens to arrive, so a car
  // sitting quietly at its charge limit (the single most valuable thing the
  // probe records) is never noticed. Well inside the shortest deadline.
  deps.timers.registerInterval('evCarLinkTick', setInterval(
    () => ctx.deviceManager?.tickEvCarLink(Date.now()),
    EV_CAR_LINK_TICK_INTERVAL_MS,
  ));
  subscribeObservedStateProjection(deps);
}
