import { requireDailyBudgetService, requireFlowHomey } from './contextGuards';
import { registerFlowCards } from '../../flowCards/registerFlowCards';
import type { AppContext } from '../../lib/app/appContext';
import { normalizeError } from '../../lib/utils/errorUtils';
import {
  hasMainHomeSmartTaskAuthority,
  isSmartTaskDeviceInMainHome,
} from './smartTaskHomeScope';
import {
  FlowPowerSampleFreshnessClock,
  registerFlowPowerSampleFreshnessClock,
} from '../flowPowerSampleFreshnessClock';
import {
  clearObjectiveForDevice,
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
  upsertObjectiveForDevice,
} from '../../lib/objectives/deferredObjectives';
import { buildDeferredObjectiveDeviceWriteDeps } from './deferredRecorders';
import {
  readConfiguredPowerSource,
  requireConfiguredPowerSource,
} from '../powerSourceSettings';

export function registerAppFlowCards(ctx: AppContext): void {
  const flowPowerSampleFreshnessClock = new FlowPowerSampleFreshnessClock({
    timers: ctx.timers,
    getNowMs: () => ctx.getNow().getTime(),
    getPowerSource: () => requireConfiguredPowerSource(ctx.homey.settings),
    requestPlanRebuild: (reason) => ctx.requestFlowPlanRebuild(reason),
    onPowerSourceReadError: (error) => ctx.getStructuredLogger('power')?.error({
      event: 'flow_freshness_power_source_read_failed',
      err: normalizeError(error),
    }),
  });
  registerFlowPowerSampleFreshnessClock(ctx.timers, flowPowerSampleFreshnessClock);
  const syncLatestSample = () => {
    flowPowerSampleFreshnessClock.syncLatestSample(ctx.powerTracker.lastTimestamp);
  };
  registerFlowCards({
    homey: requireFlowHomey(ctx),
    structuredLog: ctx.getStructuredLogger('devices'),
    resolveModeName: (mode) => ctx.resolveModeName(mode),
    getAllModes: () => ctx.getAllModes(),
    getCurrentOperatingMode: () => ctx.operatingMode,
    handleOperatingModeChange: (rawMode) => ctx.handleOperatingModeChange(rawMode),
    getCurrentPriceLevel: () => ctx.getCurrentPriceLevel(),
    areFlowBackedCardsAvailable: () => ctx.areFlowBackedCardsAvailable(),
    recordPowerSample: async (powerW) => {
      const source = readConfiguredPowerSource(ctx.homey.settings);
      if (source.state === 'suspect') {
        ctx.getStructuredLogger('power')?.error({
          event: 'flow_power_sample_source_read_failed',
          reason: source.reason,
          err: normalizeError(source.error),
        });
        throw source.error;
      }
      if (source.value === 'homey_energy') return;
      const nowMs = ctx.getNow().getTime();
      const admission = await ctx.recordPowerSample(powerW, nowMs);
      // The pipeline coalesces concurrent samples behind one loop. Waiting for
      // that loop is not evidence this request won: a newer Homey-Energy
      // sample may now be the tracker value. Only the final recorded request
      // may replace sampled-meter authority and advance Flow freshness.
      if (admission.state !== 'admitted') return;
      // Re-read after the awaited ingest. A Flow request can overlap a switch
      // back to Homey Energy; only a sample that is still authoritative may
      // settle the old sampled-meter fence. Until then the episode remains
      // closed and the next Homey poll replaces these watts.
      const admittedSource = readConfiguredPowerSource(ctx.homey.settings);
      if (admittedSource.state !== 'resolved' || admittedSource.value !== 'flow') return;
      ctx.homeMembership?.noteAdmittedFlowHomeSample();
      flowPowerSampleFreshnessClock.noteSample(nowMs);
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
    // Existing status follows durable membership, while new-task discovery
    // follows stricter current authority. A transient Main fence therefore
    // hides task creation without falsely erasing an existing task's status.
    isDeviceInMainHome: (deviceId) => isSmartTaskDeviceInMainHome(ctx, deviceId),
    hasMainHomeSmartTaskAuthority: (deviceId) => hasMainHomeSmartTaskAuthority(ctx, deviceId),
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
    debugStructured: ctx.getStructuredDebugEmitter('flow', 'settings'),
  });
  syncLatestSample();
}
