/**
 * Construction and event wiring of the app's single `DeviceTransport`, sliced
 * out of `setup/appServiceWiring.ts` to keep that entry point under the line
 * budget. This is the whole former `AppServiceWiring.initDeviceManager` body:
 * the observed-state projection epoch, the boundary-resolved whole-home meter
 * authority, the four transport dep bags, and the observer-emitter
 * subscriptions that feed the projection and drive plan rebuilds.
 *
 * Behaviour is byte-for-byte unchanged, including the ORDER of the emitter
 * subscriptions (the projection must be fed before any listener that reads it).
 */
import type Homey from 'homey';
import { DeviceTransport, type DeviceTransportBinarySettleOps } from '../../lib/device/deviceTransport';
import {
  clearAllPendingBinarySettleWindows,
  clearPendingBinarySettleWindow,
  hasPendingBinarySettleWindow,
  notePendingBinarySettleObservation,
  startPendingBinarySettleWindow,
  type BinarySettleState,
} from '../../lib/observer/binarySettle';
import type {
  ObservedStateChangedEvent,
  ObservedStateEmitter,
  PlanReconcileObservedEvent,
} from '../../lib/observer/observedStateEvents';
import type { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import type { PlanRebuildScheduler } from '../../lib/plan/rebuildScheduler/scheduler';
import {
  createCalibrationSnapshotMutationHook,
  type PowerCalibrationStore,
} from '../../lib/device/devicePowerCalibrationStore';
import { isStateOfChargeCapabilityId } from '../../lib/device/transport/stateOfCharge';
import { incPerfCounters } from '../../lib/utils/perfCounters';
import type { Logger as PinoLogger } from '../../lib/logging/logger';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import type { HomeMembershipService } from '../homeMembership';
import type { RealtimeDeviceReconcileEvent } from '../appRealtimeDeviceReconcile';
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
  planRebuildScheduler: PlanRebuildScheduler;
  getStructuredLogger: () => PinoLogger | undefined;
  installStructuredLogger: () => PinoLogger;
  getPowerCalibrationStore: () => PowerCalibrationStore;
  getObserverBinarySettleState: () => BinarySettleState;
  getObservedStateEmitter: () => ObservedStateEmitter;
  getObservedHomePower: () => ObservedHomePower;
  getObservedDeviceStateProjection: () => ObservedDeviceStateProjection;
  setObservedDeviceStateProjection: (projection: ObservedDeviceStateProjection) => void;
  isManagedFilterActive: () => boolean;
  resolveNativeWiringEnabled: (deviceId: string) => boolean;
  getDeviceDriverIdOverride: (deviceId: string) => string | undefined;
  getFlowConflict: (deviceId: string) => { conflictingCapabilities: readonly string[]; flowName?: string } | undefined;
  getSnapshotDevice: (deviceId: string) => TargetDeviceSnapshot | undefined;
  hasEnabledEvBoostForSnapshot: (device: TargetDeviceSnapshot | undefined) => boolean;
  /** Owns the `evCarLinkTick` heartbeat registered after transport init. */
  timers: TimerRegistry;
  /** Lazy over `AppServiceWiring`'s private field — the registry is built later. */
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined;
  /** Lazy for the same reason: the membership service is built after the transport. */
  getHomeMembershipService: () => HomeMembershipService | undefined;
  scheduleRealtimeDeviceReconcile: (event: RealtimeDeviceReconcileEvent) => void;
};

/**
 * Build the observer-owned binarySettle operation bag passed into
 * `DeviceTransport`. Binds each observer function so transport can
 * invoke them through the bag without statically referencing
 * `lib/observer/binarySettle.ts` (cruiser rule
 * `no-device-to-peer-except-power`). PR #4 of the observer/transport
 * split — `notes/state-management/observer-transport-split.md`.
 */
function buildObserverBinarySettleOps(): DeviceTransportBinarySettleOps {
  return {
    start: startPendingBinarySettleWindow,
    note: notePendingBinarySettleObservation,
    hasWindow: hasPendingBinarySettleWindow,
    clear: clearPendingBinarySettleWindow,
    clearAll: clearAllPendingBinarySettleWindows,
  };
}

function shouldRebuildPlanForRealtimeEvSocObservation(
  deps: DeviceTransportWiringDeps,
  event: ObservedStateChangedEvent,
): boolean {
  const capabilityIds = [
    ...(event.capabilityId ? [event.capabilityId] : []),
    ...(event.observedCapabilityIds ?? []),
  ];
  if (!capabilityIds.some((capabilityId) => isStateOfChargeCapabilityId(capabilityId))) return false;
  return deps.hasEnabledEvBoostForSnapshot(deps.getSnapshotDevice(event.deviceId));
}

function subscribeObservedState(deps: DeviceTransportWiringDeps): void {
  const { ctx } = deps;
  const emitter = deps.getObservedStateEmitter();
  // Wiring subscribes to the observer-owned emitter rather than the
  // transport-side EventEmitter. Transport's dispatcher routes every
  // post-translation event through `observedStateEmitter`, which is the
  // single source of truth for realtime fan-out post-PR #5. See
  // notes/state-management/observer-transport-split.md.
  emitter.onPlanReconcile((event: PlanReconcileObservedEvent) => {
    deps.scheduleRealtimeDeviceReconcile(event);
  });
  // Feed the projection FIRST, before any listener that reads it. Listeners
  // fire in registration order, and `syncLivePlanState` below reads the
  // projection (via `toPlanDevice`'s `currentOn`/`currentState`); applying the
  // event here first ensures that pass sees the freshly-merged observed value for
  // the same event instead of the previous one (stage 4b).
  emitter.onObservedStateChanged((e) => deps.getObservedDeviceStateProjection().applyDelta(e));
  emitter.onObservedStateRefresh((e) => deps.getObservedDeviceStateProjection().applyRefresh(e));
  // NB: the projection is seeded lazily on the first plan build
  // (`createPlanService.getPlanDevices` → `ctx.seedObservedStateFromSnapshot`),
  // not here: right after this wiring the transport's `getSnapshot()` is still
  // empty (transport `init()` only attaches the live feed; the first snapshot
  // arrives with the bootstrap refresh, which dispatches its own refresh into
  // the projection). Seeding here would be a guaranteed no-op.
  emitter.onObservedStateChanged((event: ObservedStateChangedEvent) => {
    if (shouldRebuildPlanForRealtimeEvSocObservation(deps, event)) {
      incPerfCounters([
        'plan_rebuild_requested_total',
        'plan_rebuild_requested.flow_total',
        'plan_rebuild_requested.flow.realtime_ev_soc_total',
      ]);
      deps.planRebuildScheduler.request({
        kind: 'flow',
        reason: 'realtime_ev_soc',
      });
    }
    if (
      event.measurePowerBecameSignificantlyPositive === true
      && ctx.isCapacityControlEnabled(event.deviceId)
    ) {
      // eslint-disable-next-line functional/immutable-data -- shared AppContext write
      ctx.powerSampleRebuildState = {
        ...ctx.powerSampleRebuildState,
        shortfallSuppressionInvalidated: true,
      };
    }
    // `?.` is load-bearing, NOT a default (`setup/AGENTS.md`): this wiring runs
    // before `initPlanService`, so an observed-state event inside the boot
    // window has no plan service to sync and is dropped by design. Asserting
    // here would break boot; the call yields no value, so nothing is fabricated.
    void ctx.planService?.syncLivePlanState(event.source);
  });
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
  // are loaded before the first plan cycle can resume anything — a hold that
  // survived a restart must win over the first rebuild, not lose a race with
  // it. Assigned onto ctx (the wiring-assigns-ctx-members house pattern).
  // eslint-disable-next-line functional/immutable-data -- shared AppContext write
  ctx.externalOffHold = createExternalOffHoldPolicy(ctx.homey.settings);
  // Bound here instead of via a constructor dep so the app.ts wiring literal
  // stays untouched; same resolver instance the transport providers use.
  ctx.snapshotHelpers.bindHomeyEnergyMeterResolver(() => resolveHomeyEnergyMeterSelection(ctx.homey));
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
  }, {
    debugStructured: ctx.getStructuredDebugEmitter('devices', 'devices'),
    getFlowTriggerCard: (cardId) => ctx.homey.flow?.getTriggerCard?.(cardId),
    onSnapshotMutated: createCalibrationSnapshotMutationHook({
      getStore: () => deps.getPowerCalibrationStore(),
      debugStructured: ctx.getStructuredDebugEmitter('power_calibration', 'power_calibration'),
    }),
    binarySettleState: deps.getObserverBinarySettleState(),
    binarySettleOps: buildObserverBinarySettleOps(),
    pendingPredicate: (deviceId, capabilityId) => (
      hasPendingBinarySettleWindow(deps.getObserverBinarySettleState(), deviceId, capabilityId)
    ),
    observedStateDispatcher: deps.getObservedStateEmitter().asDispatcher(deps.getObservedHomePower()),
    evCarLinkSnapshotAccess: createPersistedEvCarLinkAccess(ctx.homey),
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
  subscribeObservedState(deps);
}
