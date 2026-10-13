import type { AppContext } from './appContext';
import type { Logger as PinoLogger } from '../logging/logger';
import type { FlowConflictRefreshResult } from '../flowApi/flowConflictRefreshCoordinator';
import type { ModePriorityOrder } from '../../packages/shared-domain/src/settings/modePriorities';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetModelSettings,
  DailyBudgetUiRead,
} from '../../packages/contracts/src/dailyBudgetTypes';
import type { DeferredObjectivePlanPreviewCandidate } from '../../packages/contracts/src/deferredObjectivePlanPreview';
import type { SettingsUiDeviceDiagnosticsPayload } from '../../packages/contracts/src/deviceDiagnosticsTypes';
import type { PriceOptimizationSetupRead } from '../../packages/contracts/src/priceOptimizationSettings';
import type {
  PriceSetupRead,
  PriceSetupSuggestion,
  SettingsUiDeviceLogPayload,
  SettingsUiHardCapConfigurationRead,
} from '../../packages/contracts/src/settingsUiApi';
import type { WeatherAdvisorReadout } from '../../packages/contracts/src/weatherAdvisorTypes';
import type { PelsWidgetHostApi, WidgetObjectiveWriteResult } from '../../packages/contracts/src/widgetHostApi';
import type { NewSmartTaskWriteResult } from '../../packages/contracts/src/smartTaskEdit';

/** The settings UI's clear of a device's smart task, as the app answers it. */
export type CancelDeferredObjectiveOutcome = { ok: true } | {
  ok: false;
  reason: 'task_not_found' | 'write_refused';
};

/**
 * The running app as the settings-UI and app API handlers reach it through
 * `homey.app`: the widget host surface, the context members those handlers
 * read, and the commands they issue. `PelsApp` implements it, so a rename or a
 * signature change fails to compile on both sides instead of degrading to a
 * runtime "unavailable".
 *
 * Every member is required: the app always has it. A service handle that is
 * genuinely absent during startup (`priceCoordinator`, `batteryControl`, the
 * device transport) keeps the optionality `AppContext` declares for it.
 */
export type PelsHost = PelsWidgetHostApi & Pick<AppContext,
  | 'log'
  | 'error'
  | 'planStatuses'
  | 'deviceManager'
  | 'planService'
  | 'priceCoordinator'
  | 'batteryControl'
  | 'homeMembership'
  | 'homeRuntimeRead'
  | 'powerTracker'
  | 'getTrackerStore'
  | 'observer'
  | 'isSurplusPoolReachable'
  | 'getLatestPlanSnapshotForUi'
  | 'getPowerCalibrationSnapshot'
  | 'refreshTargetDevicesSnapshot'
  | 'getCapacityScalars'
  | 'getCurrentMonthCapacityPeakKw'
  | 'getPriceSourcePayloadsForUi'
  | 'getPvForecastSourceUiStatus'
  | 'getHomeyPriceFormulaUiStatus'
  | 'getPowerhourSourceUiStatus'
> & {
  getModePrioritiesForUi(deviceIds: readonly string[]): ModePriorityOrder;
  getSettingsUiManagedDevices(): DecoratedDeviceSnapshot[];
  refreshFlowConflictsForUi(): Promise<FlowConflictRefreshResult>;
  replacePowerTrackerForUi(nextState: AppContext['powerTracker']): void;
  readHardCapConfiguration(): SettingsUiHardCapConfigurationRead;
  readPriceOptimizationSetup(): PriceOptimizationSetupRead;
  readPriceSetup(): PriceSetupRead;
  suggestNorwayPriceSetup(): Promise<PriceSetupSuggestion>;
  previewDailyBudgetModel(settings: Partial<DailyBudgetModelSettings>): DailyBudgetModelPreviewResponse;
  applyDailyBudgetModel(settings: Partial<DailyBudgetModelSettings>): DailyBudgetUiRead;
  getDeviceDiagnosticsUiPayload(): SettingsUiDeviceDiagnosticsPayload;
  getDeviceLogUiPayload(): SettingsUiDeviceLogPayload;
  getWeatherAdvisorReadout(): Promise<WeatherAdvisorReadout>;
  createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
    rescuePolicy: 'preserve' | 'replace',
  ): WidgetObjectiveWriteResult;
  createNewDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): NewSmartTaskWriteResult;
  cancelDeferredObjective(deviceId: string): CancelDeferredObjectiveOutcome;
  getApiStructuredLogger(): PinoLogger | undefined;
};

/**
 * `homey.app` as the running PELS app, or `null` while the app is not wired.
 * The SDK types `homey.app` as always present; it is not, during the boot and
 * uninit windows the handle exists and `app` is undefined. This is the one
 * place that says so, and the one place that names the app's type.
 */
export const readPelsHost = (homey: { readonly app?: unknown } | undefined): PelsHost | null => {
  const app = homey?.app;
  return typeof app === 'object' && app !== null ? app as PelsHost : null;
};
