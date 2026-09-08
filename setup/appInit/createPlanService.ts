import { requireDeviceManager } from './contextGuards';
import { buildSteppedSettleSnapshot } from '../../lib/observer/steppedSettleSnapshot';
import { requireLastSampleAtMs } from '../../lib/power/lastTotalPower';
import { PlanService } from '../../lib/plan/planService';
import { DeviceOverviewLogRecorder } from '../../lib/plan/deviceOverviewLog';
import type { PlanEngine } from '../../lib/plan/planEngine';
import type { AppContext } from '../../lib/app/appContext';
import type {
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import type { HomeScope } from '../homeRuntime/homeScope';
import { readConfiguredPowerSource } from '../powerSourceSettings';
import { PowerMeasurementGate } from '../../lib/power/powerMeasurementGate';

// How long a home may sit with no meter reading before the gate warns. Matches
// the boot grace the zone-tree gate uses, and is short in tests so a suite can
// reach the warning without burning wall-clock.
const NO_POWER_SAMPLE_WARN_MS = process.env.NODE_ENV === 'test' ? 500 : 5 * 60 * 1000;

// `planEngine` is the engine this service drives, named by every home. The main
// home used to omit it and fall through to `ctx.planEngine` — which worked only
// because main's engine is the one that happens to be ambient on the context,
// and made the default silently wrong for anyone else who omitted it.
export function createPlanService(ctx: AppContext, scope: HomeScope, planEngine: PlanEngine): PlanService {
  const deviceManager = requireDeviceManager(ctx);
  return new PlanService({
    homeId: scope.homeId,
    homey: ctx.homey,
    publishPelsStatus: scope.publishPelsStatus,
    planEngine,
    // Home-scoped plan-device source (boot/hot-plug projection seed + eviction +
    // `toPlanDevice` + shared planned-set predicate); the invariants are
    // documented at the closure in `setup/homeRuntime/homeScope.ts`.
    getPlanDevices: scope.getPlanDevices,
    // Explicit observer projection: transport capability and Flow bindings must
    // never cross into the plan-owned service merely because structural typing
    // accepts a wider object.
    getSettleDevices: () => deviceManager.getBinaryCommandConfirmationSnapshot(),
    // The decorated devices carry their own ladder, so the settle evidence is a
    // pure projection off them — no profile lookup at the consumer.
    getSteppedSettleDevices: () => buildSteppedSettleSnapshot(ctx.latestTargetSnapshot),
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
    getObservedEvChargingState: (deviceId) => ctx.getObservedEvChargingState(deviceId),
    // Read live from the transport, not off a snapshot: the association is
    // resolved per read and moves within seconds of a plug edge.
    getAssociatedCarChargingState: (deviceId) => deviceManager.getAssociatedCar(deviceId)?.chargingState,
    // The card's battery level. Same seam and same reason as the plug-state
    // above: the plan device carries the boost DECISION, not the reading it was
    // made from.
    getObservedStateOfCharge: (deviceId) => ctx.getObservedStateOfCharge(deviceId),
    getObservedTemperature: (deviceId) => ctx.getObservedTemperature(deviceId),
    getSteppedLoadProfileById: () => {
      const map = new Map<string, SteppedLoadProfile>();
      for (const device of deviceManager.getSnapshot()) {
        const profile = ctx.deviceControlHelpers.getSteppedLoadProfile(device.id);
        if (profile) map.set(device.id, profile);
      }
      return map;
    },
    // Gates the rebuild outcome AND publishes this home's posture in its
    // status (under its own home id) so its Limits card reads
    // honestly: persisted-live but no committed zone tree still shows
    // Simulating. One read for both — the status used to take a second,
    // sub-home-only dep for it.
    getCapacityDryRun: scope.getCapacityDryRun,
    loggers: {
      structuredLog: ctx.getStructuredLogger('plan'),
      debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    },
    // Policy closure from the scope (main: the live ctx read; sub-home bundles:
    // constant UNKNOWN — capacity-only status, no price level driving plan
    // behavior and no `price_level_changed` fired against MAIN's level).
    getCurrentHourPriceLevel: scope.getCurrentHourPriceLevel,
    getLastPowerUpdate: () => requireLastSampleAtMs(scope.getPowerTracker()),
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
    // ONE composed boolean, composed here in the wiring: the planner asks a
    // single question and learns no reason (`planServiceDeps.ts`). The
    // measurement gate owns "never reported"; the silence monitor owns
    // "reported, then went silent past the shed timeout" — including letting
    // the escalation's one fail-closed pass through before the block latches.
    planBuildGate: composePlanBuildGate(
      new PowerMeasurementGate({
        homeId: scope.homeId,
        getPowerTracker: scope.getPowerTracker,
        logger: () => ctx.getStructuredLogger('power/measurement-gate'),
        warnAfterMs: NO_POWER_SAMPLE_WARN_MS,
        nowMs: () => Date.now(),
        getPowerSource: () => readConfiguredPowerSource(ctx.homey.settings),
      }),
      scope.getMeterSilenceMonitor(),
    ),
  });
}

/** The one plan-build boolean: measured at least once, and not silence-blocked. */
function composePlanBuildGate(
  measurementGate: PowerMeasurementGate,
  meterSilence: ReturnType<HomeScope['getMeterSilenceMonitor']>,
): { isOpen: () => boolean } {
  return { isOpen: () => measurementGate.isOpen() && !meterSilence.isBlocked() };
}
