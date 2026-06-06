import { requireDailyBudgetService, requireFlowHomey } from './contextGuards';
import { registerFlowCards } from '../../flowCards/registerFlowCards';
import type { AppContext } from '../../lib/app/appContext';
import {
  clearObjectiveForDevice,
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
  upsertObjectiveForDevice,
} from '../../lib/objectives/deferredObjectives';
import { buildDeferredObjectiveDeviceWriteDeps } from './deferredRecorders';

export function registerAppFlowCards(ctx: AppContext): void {
  registerFlowCards({
    homey: requireFlowHomey(ctx),
    structuredLog: ctx.getStructuredLogger('devices'),
    resolveModeName: (mode) => ctx.resolveModeName(mode),
    getAllModes: () => ctx.getAllModes(),
    getCurrentOperatingMode: () => ctx.operatingMode,
    handleOperatingModeChange: (rawMode) => ctx.handleOperatingModeChange(rawMode),
    getCurrentPriceLevel: () => ctx.getCurrentPriceLevel(),
    areFlowBackedCardsAvailable: () => ctx.areFlowBackedCardsAvailable(),
    recordPowerSample: (powerW) => {
      if (ctx.homey.settings.get('power_source') === 'homey_energy') return Promise.resolve();
      return ctx.recordPowerSample(powerW);
    },
    getCapacityGuard: () => ctx.capacityGuard,
    getHeadroom: () => ctx.capacityGuard?.getHeadroom() ?? null,
    setCapacityLimit: (kw) => ctx.capacityGuard?.setLimit(kw),
    getSnapshot: () => ctx.getFlowSnapshot(),
    refreshSnapshot: (options) => ctx.refreshTargetDevicesSnapshot(options),
    getHomeyDevicesForFlow: () => ctx.getHomeyDevicesForFlow(),
    reportFlowBackedCapability: (params) => ctx.reportFlowBackedCapability(params),
    reportSteppedLoadActualStep: (deviceId, stepId) => (
      ctx.deviceControlHelpers.reportSteppedLoadActualStep(deviceId, stepId)
    ),
    getDeviceLoadSetting: (deviceId) => ctx.getDeviceLoadSetting(deviceId),
    setExpectedOverride: (deviceId, kw) => ctx.setExpectedOverride(deviceId, kw),
    storeFlowPriceData: (kind, raw) => ctx.storeFlowPriceData(kind, raw),
    rebuildPlan: (source) => ctx.requestFlowPlanRebuild(source),
    getDeferredObjectiveSettings: () => {
      // Self-heal a boot-time empty-`getKeys()` flake that skipped the one-shot
      // migration: idempotent + marker-gated (a cheap single `get` once done), so
      // retrying on the plan cycle makes legacy objectives visible within seconds
      // instead of staying invisible (planner + UI) until the next app restart.
      migrateBlobToPerKeyIfNeeded(ctx.homey.settings);
      return readAllObjectives(ctx.homey.settings);
    },
    // Both writes route through the device-scoped ops over the hardened
    // settings-mutation primitive (see buildDeferredObjectiveDeviceWriteDeps),
    // so the Flow cards and the create-smart-task widget share one
    // read-modify-write + notify/flush/rebuild path.
    upsertDeferredObjectiveForDevice: (params) => upsertObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(ctx, {
        nowMs: ctx.getNow().getTime(),
        rebuildReason: 'deadline_objective_card_set',
      }),
      params,
    ),
    clearDeferredObjectiveForDevice: (params) => clearObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(ctx, {
        nowMs: ctx.getNow().getTime(),
        rebuildReason: 'deadline_objective_card_clear',
      }),
      params,
    ),
    getDeferredObjectiveActivePlans: () => (
      ctx.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null
    ),
    getDeferredObjectiveStatusBus: () => ctx.deferredObjectiveStatusBus,
    getDeferredObjectivePlanRevisionBus: () => ctx.deferredObjectivePlanRevisionBus,
    getDeferredObjectiveEndedBus: () => ctx.deferredObjectiveEndedBus,
    getDeferredObjectiveHoursRemainingBus: () => ctx.deferredObjectiveHoursRemainingBus,
    getDeferredObjectiveHoursRemainingTracker: () => ctx.deferredObjectiveHoursRemainingTracker,
    evaluateHeadroomForDevice: (params) => ctx.evaluateHeadroomForDevice(params),
    loadDailyBudgetSettings: () => requireDailyBudgetService(ctx).loadSettings(),
    updateDailyBudgetState: (options) => ctx.updateDailyBudgetState(options),
    getCombinedHourlyPrices: () => ctx.getCombinedHourlyPrices(),
    getTimeZone: () => ctx.getTimeZone(),
    getNow: () => ctx.getNow(),
    getStructuredLogger: (component) => ctx.getStructuredLogger(component),
    log: (...args: unknown[]) => ctx.log(...args),
    logDebug: (...args: unknown[]) => ctx.logDebug('settings', ...args),
    error: (...args: unknown[]) => ctx.error(...args),
  });
}
