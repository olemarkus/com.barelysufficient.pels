/**
 * Construction and event wiring of the app's single `DeviceTransport`, sliced
 * out of `setup/appServiceWiring.ts` to keep that entry point under the line
 * budget: the boundary-resolved whole-home meter authority, the transport's
 * owners and meters, the observer-emitter subscriptions that feed the projection, and
 * the transport's start. `AppServiceWiring.initDeviceManager` sequences the
 * three steps. Plan-dependent subscriptions are wired later by
 * `planObservedStateSubscription.ts`.
 *
 * The projection subscriptions retain their load-bearing registration order.
 */
import { createRetainedPowerStore } from '../../lib/device/retainedPowerStore';
import type Homey from 'homey';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import type { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import type { ObservedStateEmitterDispatcher } from '../../lib/ports/observedStateEvents';
import type { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import { createCalibrationSnapshotMutationHook } from '../../lib/device/devicePowerCalibrationStore';
import { getDebugEmitter, type Logger as PinoLogger } from '../../lib/logging/logger';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';
import { buildHomeRuntimeMeterProviders } from './wireHomeRuntimeRegistry';
import { createExternalOffHoldPolicy } from '../externalOffHoldAdapter';
import { createEvCarLinkAccessForApp } from './evCarLinkAccess';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import type { AppNativeWiring } from '../appNativeWiring';

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
 * The first snapshot arrives with the bootstrap refresh, which dispatches its
 * refresh into the projection before the warmup gate admits a plan build. No
 * separate snapshot seed path is needed.
 */
export function subscribeObservedStateProjection(
  emitter: ObservedStateEmitter,
  projection: ObservedDeviceStateProjection,
): void {
  emitter.onObservedStateChanged((e) => projection.applyDelta(e));
  emitter.onObservedStateRefresh((e) => projection.applyRefresh(e));
}

/**
 * The app's one transport, built once per run beside its observed-state
 * projection. The projection's sequence guard is keyed on the transport's
 * per-device `observationSeq`, which a new transport would reset, so the two
 * share one lifecycle: there is no in-process transport restart.
 *
 * `getHomeRuntimeRegistry` is lazy: the registry is built after the transport.
 */
export function buildDeviceTransport(
  ctx: AppContext,
  homeyApp: Homey.App,
  structuredLogger: PinoLogger,
  nativeWiring: AppNativeWiring,
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined,
  observedStateDispatcher: ObservedStateEmitterDispatcher,
): DeviceTransport {
  const structuredLog = structuredLogger.child({ component: 'devices' });
  // "Leave off until turned on again". Constructed here so the persisted holds
  // are visible before the first plan cycle can resume anything — a hold that
  // survived a restart must win over the first rebuild, not lose a race with it.
  // The blob→per-key migration needs no sequencing from this side: the policy
  // asserts it on every read, so it cannot be built against an unmigrated store
  // and it heals itself if the SDK was failing at boot. Assigned onto ctx (the
  // wiring-assigns-ctx-members house pattern).
  // eslint-disable-next-line functional/immutable-data, no-param-reassign -- shared AppContext write
  ctx.externalOffHold = createExternalOffHoldPolicy(ctx.homey.settings);
  const observeCalibrationSnapshotMutation = createCalibrationSnapshotMutationHook(
    ctx.getPowerCalibrationStore(),
    getDebugEmitter('power_calibration', 'power_calibration'),
  );
  return new DeviceTransport(homeyApp, {
    log: ctx.log.bind(ctx),
    error: ctx.error.bind(ctx),
    structuredLog,
  }, {
    expectedPowerKwOverrides: ctx.expectedPowerKwOverrides,
    lastKnownPowerKw: ctx.lastKnownPowerKw,
  }, {
    getFlowTriggerCard: (cardId) => ctx.homey.flow?.getTriggerCard?.(cardId),
    onSnapshotMutated: (snapshot, nowMs) => {
      observeCalibrationSnapshotMutation(snapshot, nowMs);
      ctx.deviceControlHelpers.reconcileTargetPowerReachability([snapshot], nowMs);
    },
    observedStateDispatcher,
    evCarLinkSnapshotAccess: createEvCarLinkAccessForApp(ctx),
    retainedPowerStore: createRetainedPowerStore(ctx.getUserdataDatabase()),
    settings: ctx.deviceControlSettings,
    nativeWiring,
    // Also where a moved learned peak is persisted: driven off the learned-peak
    // mutation, NOT the snapshot-mutation seam above. That seam fires on a changed
    // calibration input, and a reading equal to the standing peak changes none of
    // them while still re-anchoring the window, so the peak of the steadiest
    // devices would have expired in settings while memory said it was fresh. The
    // persist is itself rate-limited and change-gated.
    flowBacked: ctx.flowBacked,
    batteryManaged: ctx.batteryManaged,
    meters: {
      getHomeyEnergyMeterSelection: () => resolveHomeyEnergyMeterSelection(ctx.homey),
      // Lazy: the registry is built after the transport.
      ...buildHomeRuntimeMeterProviders(getHomeRuntimeRegistry),
    },
  });
}

/**
 * Publish the built transport on `ctx` and start it. Runs after
 * {@link subscribeObservedStateProjection}: past the `ctx` assignment any
 * consumer can read the composed plan input, which is the descriptor joined
 * with the projection's record, so a delta dispatched in between would be one
 * no subscriber received.
 *
 * The mode catalogs hold their rank writes until the home batteries are known
 * (`HomeModeCatalogOwner.persistMissingRanks`); `onHomeBatteryDevicesResolved`
 * is what reloads them when that happens.
 */
export async function startDeviceTransport(
  ctx: AppContext,
  deviceManager: DeviceTransport,
  onHomeBatteryDevicesResolved: () => void,
): Promise<void> {
  deviceManager.setOnHomeBatteryDevicesResolved(onHomeBatteryDevicesResolved);
  // eslint-disable-next-line functional/immutable-data, no-param-reassign -- shared AppContext write
  ctx.deviceManager = deviceManager;
  ctx.settingsUiDeviceReads.connect(deviceManager);
  await deviceManager.init();
  // The probe's decisions are time-based — edge settlement, away verdicts, and
  // the self-stop dwell all need 90-180 s to elapse. Without a heartbeat they
  // are only evaluated when unrelated telemetry happens to arrive, so a car
  // sitting quietly at its charge limit (the single most valuable thing the
  // probe records) is never noticed. Well inside the shortest deadline.
  ctx.timers.registerInterval('evCarLinkTick', setInterval(
    () => ctx.deviceManager?.tickEvCarLink(Date.now()),
    EV_CAR_LINK_TICK_INTERVAL_MS,
  ));
}
