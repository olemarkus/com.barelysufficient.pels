import { requirePlanEngine } from './contextGuards';
import { evictMissingDeviceCacheEntries, toPlanDevice } from './toPlanDevice';
import { PlanService } from '../../lib/plan/planService';
import { DeviceOverviewLogRecorder } from '../../lib/plan/deviceOverviewLog';
import type { AppContext } from '../../lib/app/appContext';
import { buildControlModelMap } from '../appDeviceControlHelpers';
import { PELS_STATUS } from '../../lib/utils/settingsKeys';
import { isRuntimePlannedDevice } from '../appDeviceSupport';
import { readObservedEvChargingState } from '../../lib/observer/observedDeviceStateProjection';

export function createPlanService(ctx: AppContext): PlanService {
  return new PlanService({
    homey: ctx.homey,
    writePelsStatus: (status) => ctx.homey.settings.set(PELS_STATUS, status),
    planEngine: requirePlanEngine(ctx),
    getPlanDevices: () => {
      // Boot/hot-plug seed of the observed-state projection from the RAW cached
      // snapshot BEFORE the per-device `toPlanDevice` reads run. The projection
      // is event-driven (empty until the first delta/refresh for a device), so
      // on the first cold-start cycle — and for a device hot-plugged before its
      // first observation — `getObservedState` would otherwise be empty here and
      // `toPlanDevice` would fall back to the snapshot. Seeding fills only empty
      // slots (never clobbers a recorded observation) and uses the raw cached
      // array, so it adds no re-decoration and no device-manager re-entry.
      ctx.seedObservedStateFromSnapshot();
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
    // Producer `deviceType` for the settings-UI control-mode card. Sourced from
    // the RAW, undecorated device snapshot (`deviceManager.getSnapshot()`) — NOT
    // `latestTargetSnapshot` — so building this map triggers no re-decoration
    // side effects, and it is built once per serialize (O(n)). `deviceType` is a
    // producer setting the planner no longer evaluates; the read model only uses
    // it to pick the temperature-vs-binary card for non-stepped devices.
    getDeviceTypeById: () => {
      const map = new Map<string, 'temperature' | 'onoff'>();
      for (const device of ctx.deviceManager?.getSnapshot() ?? []) {
        if (device.deviceType) map.set(device.id, device.deviceType);
      }
      return map;
    },
    // Control-model map for the device-overview transition signature. Same RAW,
    // undecorated source as `getDeviceTypeById` (`deviceManager.getSnapshot()` —
    // NOT `latestTargetSnapshot`), so building it triggers no re-decoration.
    // `recordOverviewChange` calls this ONCE per overview pass (not per device),
    // so the scan stays O(n) and never re-enters the device manager inside the
    // plan/apply cycle. `buildControlModelMap` DERIVES the three-way model via
    // `resolveDefaultControlModel` — the raw snapshot's `controlModel` is only
    // `'stepped_load' | undefined`, so a bare read would leave non-stepped devices
    // out of the map and a `temperature_target ↔ binary_power` flip would never
    // reach the signature.
    getControlModelById: () => buildControlModelMap(ctx.deviceManager?.getSnapshot() ?? []),
    getCapacityDryRun: () => ctx.capacityDryRun,
    loggers: {
      structuredLog: ctx.getStructuredLogger('plan'),
      debugStructured: ctx.getStructuredDebugEmitter('plan', 'plan'),
    },
    isCurrentHourCheap: () => ctx.isCurrentHourCheap(),
    isCurrentHourExpensive: () => ctx.isCurrentHourExpensive(),
    // Read via the combined-prices reader so a legacy V1 payload is migrated to
    // V2 on first read; otherwise hasPrices()/hasCombinedPrices() (which only
    // know V2) would return false during the post-upgrade window and price_level
    // would resolve to UNKNOWN.
    getCombinedPrices: () => ctx.combinedPricesReader.readStore(ctx.getNow(), ctx.getTimeZone()),
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
