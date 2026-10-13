import { vi } from 'vitest';
import type { SettingsHandlerDeps } from '../../lib/utils/settingsHandlers';

/** The price service as the settings handler drives it, every operation an inert spy. */
export const settingsHandlerPriceServiceDouble = (
  overrides: Partial<SettingsHandlerDeps['priceService']> = {},
): SettingsHandlerDeps['priceService'] => ({
  refreshGridTariffData: vi.fn().mockResolvedValue(undefined),
  refreshSpotPrices: vi.fn().mockResolvedValue(undefined),
  updateCombinedPrices: vi.fn(),
  loadPriceOptimizationSettings: vi.fn(),
  updatePriceOptimizationEnabled: vi.fn(),
  ...overrides,
});

/**
 * Every settings-handler collaborator as an inert spy, over a settings store
 * that holds nothing; a spec supplies the members its path asserts on.
 */
export const settingsHandlerDepsDouble = (overrides: Partial<SettingsHandlerDeps> = {}): SettingsHandlerDeps => ({
  homey: {
    settings: {
      get: vi.fn(),
      set: vi.fn(),
    },
  } as unknown as SettingsHandlerDeps['homey'],
  onPvForecastSourceObserved: vi.fn(),
  loadCapacitySettings: vi.fn(),
  noteCapacitySettingWritten: vi.fn(),
  recoverCapacitySettingsAfterSkippedWrite: vi.fn(),
  reloadExpectedPowerOverrides: vi.fn(),
  applyBatteryControlSettings: vi.fn(),
  rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
  refreshTargetDevicesSnapshot: vi.fn().mockResolvedValue(undefined),
  getCapacitySettings: vi.fn().mockReturnValue({ limitKw: 10, marginKw: 1, periodMinutes: 60 }),
  getCapacityDryRun: vi.fn().mockReturnValue(false),
  loadDailyBudgetSettings: vi.fn(),
  updateDailyBudgetState: vi.fn(),
  resetDailyBudgetLearning: vi.fn(),
  priceService: settingsHandlerPriceServiceDouble(),
  updateOverheadToken: vi.fn().mockResolvedValue(undefined),
  updateDebugLoggingEnabled: vi.fn(),
  restartHomeyEnergyPoll: vi.fn(),
  onHomeyEnergyMeterObserved: vi.fn(),
  onMainMeterSelectionObserved: vi.fn(),
  onHomeOwnershipConfigurationObserved: vi.fn(),
  reloadWeatherAdvisor: vi.fn(),
  releaseDeOptedExternalOffHolds: vi.fn(),
  onHomeRuntimePowerSourceObserved: vi.fn(),
  onHomeRuntimePowerSourceChanged: vi.fn(),
  onTemperatureControlPolicyObserved: vi.fn(),
  onHomeScopedSettingChanged: vi.fn(),
  recomputeHomeMembership: vi.fn(),
  reconcileHomeRuntimes: vi.fn(),
  rebuildHomeRuntimePlansForModeChange: vi.fn(),
  rebuildAllHomeRuntimePlansForDeviceControlChange: vi.fn(),
  ...overrides,
});
