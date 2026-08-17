import { requireDeviceManager, requirePlanEngine } from './contextGuards';
import { PlanService } from '../../lib/plan/planService';
import { DeviceOverviewLogRecorder } from '../../lib/plan/deviceOverviewLog';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { AppContext } from '../../lib/app/appContext';
import type {
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { HomeScope } from '../homeRuntime/homeScope';
import {
  readObservedEvChargingState,
  readObservedStateOfCharge,
  readObservedTemperatureState,
} from '../../lib/observer/observedDeviceStateProjection';
import { resolveTemperatureBoostConfigForDevice } from './toPlanDevice';
import { isDeviceObservationStale } from '../../lib/observer/observationFreshness';
import { readConfiguredPowerSource } from '../powerSourceSettings';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import { PowerMeasurementGate } from '../powerMeasurementGate';

// How long a home may sit with no meter reading before the gate warns. Matches
// the boot grace the zone-tree gate uses, and is short in tests so a suite can
// reach the warning without burning wall-clock.
const NO_POWER_SAMPLE_WARN_MS = process.env.NODE_ENV === 'test' ? 500 : 5 * 60 * 1000;

// `planEngine` is the engine this service drives: the main home omits it (the
// wiring assigns `ctx.planEngine` before `initPlanService`, the historical
// coupling); a sub-home capacity bundle MUST pass its own engine — falling
// through to `ctx.planEngine` would silently drive the MAIN home's engine.
export function createPlanService(ctx: AppContext, scope: HomeScope, planEngine?: PlanEngine): PlanService {
  const deviceManager = requireDeviceManager(ctx);
  return new PlanService({
    homeId: scope.homeId,
    homey: ctx.homey,
    writePelsStatus: scope.writePelsStatus,
    planEngine: planEngine ?? requirePlanEngine(ctx),
    // Home-scoped plan-device source (boot/hot-plug projection seed + eviction +
    // `toPlanDevice` + shared planned-set predicate); the invariants are
    // documented at the closure in `setup/homeRuntime/homeScope.ts`.
    getPlanDevices: scope.getPlanDevices,
    // Explicit observer projection: transport capability and Flow bindings must
    // never cross into the plan-owned service merely because structural typing
    // accepts a wider object.
    getSettleDevices: () => deviceManager.getBinaryCommandConfirmationSnapshot(),
    // EV charging state for the settings-UI read model comes from the observer
    // (its canonical owner), not the plan device — the planner carries only the
    // resolved flat EV plug-state sub-fields, not the raw observed plug-state. NB: do NOT
    // fall back to `ctx.latestTargetSnapshot` here — that getter re-runs
    // `getSnapshot()` + full re-decoration on every access, so a per-device lookup
    // mid-serialization is O(n²) and re-entrant-unsafe (it breaks the SDK-boundary
    // shed e2es). The cold-start gap (a generic chip for the first cycle before
    // the event-driven projection fills) is closed by the boot/hot-plug seed in
    // `getPlanDevices` above: every plan build seed-fills the projection from the
    // raw snapshot before the read model serializes, so a boot-present EV's real
    // plug-state is materialized for cycle 1.
    getObservedEvChargingState: (deviceId) => readObservedEvChargingState(ctx.getObservedState(deviceId)),
    // Read live from the transport, not off a snapshot: the association is
    // resolved per read and moves within seconds of a plug edge.
    getAssociatedCarChargingState: (deviceId) => deviceManager.getAssociatedCar(deviceId)?.chargingState,
    // The card's battery level and boost thresholds. Same seam and same reason as
    // the plug-state above: the plan device carries the boost DECISION, not the
    // reading or the configuration it was made from.
    getObservedStateOfCharge: (deviceId) => readObservedStateOfCharge(ctx.getObservedState(deviceId)),
    getEvBoostConfig: (deviceId) => ctx.getEvBoostConfig?.(deviceId),
    getTemperatureBoostConfig: (deviceId) => resolveTemperatureBoostConfigForDevice(ctx, deviceId),
    getObservedTemperature: (deviceId) => readObservedTemperatureState(ctx.getObservedState(deviceId)),
    // Observation staleness for the settings-UI gray-state label and the idle
    // classifier, sourced from the observer projection — the same seam as
    // `getObservedEvChargingState`. The plan device no longer carries
    // `observationStale`; the plan trusts the observer's resolved on/off truth.
    // A device with no projection entry yet (never observed) is treated as not
    // stale here. This is only ever invoked over COMMITTED plan devices (the
    // overview serialize + idle tick), which were built from the seeded snapshot,
    // so it can read the projection directly with no `?? snapshot` fallback. A
    // future caller must NOT wire it to an unseeded path (the smart-task picker or
    // realtime-reconcile devices), where the projection may have no entry and this
    // would silently report not-stale.
    getObservationStale: (deviceId) => {
      const observed = ctx.getObservedState(deviceId);
      return observed !== undefined && isDeviceObservationStale(observed);
    },
    getSteppedLoadProfileById: () => {
      const map = new Map<string, SteppedLoadProfile>();
      for (const device of deviceManager.getSnapshot()) {
        const profile = ctx.deviceControlHelpers.getSteppedLoadProfile(device.id);
        if (profile) map.set(device.id, profile);
      }
      return map;
    },
    getCapacityDryRun: scope.getCapacityDryRun,
    // Sub-homes publish their EFFECTIVE (membership-gated) dry-run into
    // `pels_status:<id>` so the per-home Limits card shows honest posture. The
    // main home omits it (undefined ⇒ JSON-dropped) — its `pels_status` blob
    // stays byte-identical to origin/main.
    getStatusEffectiveDryRun: scope.homeId === MAIN_HOME_ID ? undefined : scope.getCapacityDryRun,
    loggers: {
      structuredLog: ctx.getStructuredLogger('plan'),
      debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    },
    // Policy closures from the scope (main: live ctx reads, byte-identical;
    // sub-home bundles: constant false — capacity-only status, no price levels
    // driving plan behavior).
    getCurrentHourPriceLevel: scope.getCurrentHourPriceLevel,
    // Scope-owned combined-price read: main reads via the combined-prices reader
    // (so a legacy V1 payload is migrated to V2 on first read; otherwise
    // hasPrices()/hasCombinedPrices() would return false during the post-upgrade
    // window and price_level would resolve to UNKNOWN). A sub-home binds null so
    // its capacity-only status resolves price level UNKNOWN and never fires the
    // shared `price_level_changed` trigger card against MAIN's price level.
    getCombinedPrices: scope.getCombinedPrices,
    getLastPowerUpdate: () => scope.getPowerTracker().lastTimestamp ?? null,
    schedulePostActuationRefresh: () => ctx.snapshotHelpers.schedulePostActuationRefresh(),
    overviewDebugStructured: ctx.getStructuredDebugEmitter('overview', 'overview'),
    isOverviewDebugEnabled: () => ctx.debugLoggingTopics.has('overview'),
    deviceOverviewLogRecorder: new DeviceOverviewLogRecorder(),
    isPlanDebugEnabled: () => ctx.debugLoggingTopics.has('plan'),
    // Scope-owned so a sub-home never drives MAIN's shared UI surfaces: main
    // binds the app recorder + emits the realtime `plan_updated` stream; a
    // sub-home binds undefined (no diagnostics pollution) and false (no clobber
    // of the single settings-UI plan channel with its partitioned plan).
    deviceDiagnostics: scope.getDeviceDiagnostics(),
    emitsUiRealtime: scope.emitsUiRealtime,
    snapshotWarmupGate: ctx.snapshotWarmupGate,
    // Scope-owned, so each home gates on ITS OWN meter: a sub-home whose area
    // meter has never reported must not ride the main home's first sample.
    planBuildGate: new PowerMeasurementGate({
      homeId: scope.homeId,
      getPowerTracker: scope.getPowerTracker,
      logger: () => ctx.getStructuredLogger('power/measurement-gate'),
      warnAfterMs: NO_POWER_SAMPLE_WARN_MS,
      nowMs: () => Date.now(),
      getPowerSource: () => readConfiguredPowerSource(ctx.homey.settings),
    }),
  });
}
