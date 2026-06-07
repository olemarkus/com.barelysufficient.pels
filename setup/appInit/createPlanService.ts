import { requirePlanEngine } from './contextGuards';
import { evictMissingDeviceCacheEntries, toPlanDevice } from './toPlanDevice';
import { PlanService } from '../../lib/plan/planService';
import { DeviceOverviewLogRecorder } from '../../lib/plan/deviceOverviewLog';
import { readPriceStore } from '../../lib/price/priceStore';
import type { AppContext } from '../../lib/app/appContext';
import { isRuntimePlannedDevice } from '../appDeviceSupport';

export function createPlanService(ctx: AppContext): PlanService {
  return new PlanService({
    homey: ctx.homey,
    planEngine: requirePlanEngine(ctx),
    getPlanDevices: () => {
      const snapshot = ctx.latestTargetSnapshot;
      evictMissingDeviceCacheEntries(ctx, snapshot);
      return snapshot
        .map((device) => toPlanDevice(ctx, device))
        // Shared planned-set predicate — the create-smart-task candidate list
        // and create-time validation use the SAME `isRuntimePlannedDevice` so a
        // `managed: false` device can never be offered/persisted but unplanned.
        .filter(isRuntimePlannedDevice);
    },
    // The binary settle reads the observer-internal `binaryControlObservation`
    // straight off the device snapshot — it is not (and must not be) on the
    // plan-facing `PlanInputDevice`. Pending commands only exist for commanded
    // devices, so the unfiltered snapshot is a harmless superset.
    getSettleDevices: () => ctx.latestTargetSnapshot,
    // EV charging state for the settings-UI read model comes from the observer
    // (its canonical owner), not the plan device — the planner carries only the
    // resolved `evCommandability`, not the raw observed plug-state. NB: do NOT
    // fall back to `ctx.latestTargetSnapshot` here — that getter re-runs
    // `getSnapshot()` + full re-decoration on every access, so a per-device lookup
    // mid-serialization is O(n²) and re-entrant-unsafe (it breaks the SDK-boundary
    // shed e2es). The observed projection is event-driven, so the chip can show
    // generic copy for the first cold-start cycle before the projection fills;
    // tracked as a P3 in TODO.md.
    getObservedEvChargingState: (deviceId) => ctx.getObservedState(deviceId)?.evChargingState,
    getCapacityDryRun: () => ctx.capacityDryRun,
    loggers: {
      structuredLog: ctx.getStructuredLogger('plan'),
      debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    },
    isCurrentHourCheap: () => ctx.isCurrentHourCheap(),
    isCurrentHourExpensive: () => ctx.isCurrentHourExpensive(),
    // Use readPriceStore so a legacy V1 payload is migrated to V2 on first
    // read; otherwise hasPrices()/hasCombinedPrices() (which only know V2)
    // would return false during the post-upgrade window and price_level
    // would resolve to UNKNOWN.
    getCombinedPrices: () => readPriceStore(
      { homey: ctx.homey, requestRefetch: () => ctx.priceCoordinator?.updateCombinedPrices() },
      ctx.getNow(),
      ctx.getTimeZone(),
    ),
    getLastPowerUpdate: () => ctx.powerTracker.lastTimestamp ?? null,
    schedulePostActuationRefresh: () => ctx.snapshotHelpers.schedulePostActuationRefresh(),
    overviewDebugStructured: ctx.getStructuredDebugEmitter('overview', 'overview'),
    isOverviewDebugEnabled: () => ctx.debugLoggingTopics.has('overview'),
    deviceOverviewLogRecorder: new DeviceOverviewLogRecorder(),
    isPlanDebugEnabled: () => ctx.debugLoggingTopics.has('plan'),
    deviceDiagnostics: ctx.deviceDiagnosticsService,
    snapshotWarmupGate: ctx.snapshotWarmupGate,
  });
}
