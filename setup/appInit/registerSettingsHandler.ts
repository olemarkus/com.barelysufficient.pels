import type { AppContext } from '../../lib/app/appContext';
import { createSettingsHandler } from '../../lib/utils/settingsHandlers';
import { attachSettingsHandler } from '../../lib/utils/settingsHandlerListeners';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import {
  requireBatteryControl,
  requireDailyBudgetService,
  requirePlanService,
  requirePriceCoordinator,
} from './contextGuards';
import { buildHomeRuntimeSettingsHooks } from './wireHomeRuntimeRegistry';

/**
 * Listen for settings writes and dispatch them to their handlers. Home-runtime
 * hooks are lazy over `getHomeRuntimeRegistry`: the registry is built after this
 * step, and until then a suffixed write is dropped here and absorbed by the
 * registry's boot-time reconcile. Returns the listener teardown.
 */
export const registerSettingsHandler = (
  ctx: AppContext,
  getHomeOperatingMode: () => string,
  getHomeRuntimeRegistry: () => HomeRuntimeRegistry | undefined,
  requestMainAuthorityRecovery: (timing?: 'scheduled' | 'immediate') => void,
  observeOwnershipConfigurationChanged: () => void,
  onPvForecastSourceObserved: () => void,
): (() => void) => {
  const planService = requirePlanService(ctx);
  const dailyBudgetService = requireDailyBudgetService(ctx);
  const batteryControl = requireBatteryControl(ctx);
  const homeRuntimeHooks = buildHomeRuntimeSettingsHooks(getHomeRuntimeRegistry);
  const settingsHandler = createSettingsHandler({
    homey: ctx.homey,
    ...homeRuntimeHooks,
    onHomeRuntimePowerSourceObserved: () => {
      // The tracker owns retry when this immediate safety write fails.
      ctx.resetMainPowerTrackerFreshness();
      homeRuntimeHooks.onHomeRuntimePowerSourceObserved();
    },
    onTemperatureControlPolicyObserved: () => ctx.deviceControlSettings.reloadTemperatureControlPolicy(),
    onHomeyEnergyMeterObserved: () => {
      // Reset before the old poll is invalidated; either way no old sample can
      // be joined to the new meter, and a failed safety write retries in-place.
      ctx.resetMainPowerTrackerFreshness();
      ctx.homeyEnergyHelpers.invalidate();
    },
    onPvForecastSourceObserved,
    onMainMeterSelectionObserved: () => requestMainAuthorityRecovery(),
    onHomeOwnershipConfigurationObserved: observeOwnershipConfigurationChanged,
    // Lazy read on purpose: the membership service is assigned by a separate
    // wiring step, and the handler must tolerate a context without it.
    recomputeHomeMembership: () => {
      ctx.homeMembership?.recompute();
      // Apply the current generation after the serialized semantic recompute.
      requestMainAuthorityRecovery('immediate');
    },
    loadCapacitySettings: ctx.loadCapacitySettings,
    noteCapacitySettingWritten: ctx.noteCapacitySettingWritten,
    recoverCapacitySettingsAfterSkippedWrite: ctx.recoverCapacitySettingsAfterSkippedWrite,
    // The handlers name the settings SOURCE that moved; naming the trigger is
    // this seam's job, not theirs.
    rebuildPlanFromCache: async (settingsSource) => {
      await planService.rebuildPlanFromCache('settings', { detail: settingsSource });
    },
    refreshTargetDevicesSnapshot: () => ctx.refreshTargetDevicesSnapshot(),
    getCapacitySettings: () => ctx.capacitySettings,
    getCapacityDryRun: () => ctx.capacityDryRun,
    loadPriceOptimizationSettings: ctx.loadPriceOptimizationSettings,
    loadDailyBudgetSettings: () => dailyBudgetService.loadSettings(),
    updateDailyBudgetState: (options) => ctx.updateDailyBudgetState(options),
    resetDailyBudgetLearning: () => dailyBudgetService.resetLearning(),
    priceService: requirePriceCoordinator(ctx),
    updatePriceOptimizationEnabled: ctx.updatePriceOptimizationEnabled,
    updateOverheadToken: ctx.updateOverheadToken,
    updateDebugLoggingEnabled: ctx.updateDebugLoggingEnabled,
    restartHomeyEnergyPoll: () => {
      ctx.homeyEnergyHelpers.restart();
      // The two are complementary: exactly one runs for any given source, so a
      // source change must re-evaluate both or the home ends up with neither.
      ctx.generationPollSource.restart();
    },
    reloadWeatherAdvisor: () => ctx.reloadWeatherCollector?.(),
    releaseDeOptedExternalOffHolds: () => ctx.externalOffHold?.releaseDeOptedHolds() ?? [],
    reloadExpectedPowerOverrides: () => ctx.flowBacked.reloadExpectedPowerOverrides(),
    applyBatteryControlSettings: () => batteryControl.applyControlSettings(),
  });
  return attachSettingsHandler(
    ctx.homey.settings,
    settingsHandler,
    (key) => ctx.observedTemperatureModeUpdates.consumeSettingChange(key),
    () => ctx.notifyOperatingModeChanged(getHomeOperatingMode()),
  );
};
