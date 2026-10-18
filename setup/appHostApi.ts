import type { NewSmartTaskWriteResult } from '../packages/contracts/src/smartTaskEdit';
import { getDebugEmitter } from '../lib/logging/logger';
import type { BudgetDailyHistory, BudgetDecisionHistory } from '../packages/contracts/src/budgetDiagnostics';
import {
  resolveTemperaturePolicyShedBehavior,
  resolveTemperaturePolicyShedLimitsC,
} from '../lib/device/temperatureControlPosture';
import type Homey from 'homey';
import type { AppContext } from '../lib/app/appContext';
import {
  readRuntimeDevice,
  readRuntimeDevices,
  type PlanInputSnapshotDevice,
} from '../lib/planInput/runtimeDeviceRead';
import { readFlowDevices } from '../lib/device/deviceFlowRead';
import type { FlowCardDeps } from '../flowCards/registerFlowCards';
import type { PowerSource } from '../lib/power/powerSource';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetSettingsInput,
  DailyBudgetUiRead,
} from '../lib/dailyBudget/dailyBudgetTypes';
import type {
  DecoratedDeviceSnapshot,
  DeviceDescriptorRead,
} from '../packages/contracts/src/types';
import type {
  PriceLevelSummaryRead,
  PriceSetupRead,
  PriceSetupSuggestion,
  SettingsUiHardCapConfigurationRead,
  SettingsUiPlanSnapshot,
} from '../packages/contracts/src/settingsUiApi';
import type {
  CreateSmartTaskCandidateDevicesRead,
  PelsWidgetHostApi,
} from '../packages/contracts/src/widgetHostApi';
import type { SmartTaskHomeScope } from '../packages/contracts/src/smartTaskHomeScope';
import type { PriceTimelineRead } from '../packages/contracts/src/priceTimeline';
import type { SettingsUiDeviceDiagnosticsPayload } from '../packages/contracts/src/deviceDiagnosticsTypes';
import type { ResolvedDeferredObjectiveActivePlansV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanPreviewEstimate } from '../packages/contracts/src/deferredObjectivePlanPreview';
import type { StarvationNotListedDevice, StarvationRescueDevice } from '../packages/contracts/src/starvationRescue';
import type {
  SettingsUiDeferredObjectivePlanHistoryPayload,
  SettingsUiDeviceLogPayload,
} from '../packages/contracts/src/settingsUiApi';
import type { WeatherAdvisorReadout } from '../packages/contracts/src/weatherAdvisorTypes';
import type { WeatherCollector } from '../lib/weather/weatherCollector';
import type {
  DeferredObjectivePlanPreviewCandidate,
} from '../lib/objectives/deferredObjectives';
import {
  buildLimitedNotListedDevices,
  buildStarvedRescueDevices,
  readCreateSmartTaskCandidateDevices,
  resolveSmartTaskHomeScope,
} from './appInit/smartTaskHomeScope';
import { requireConfiguredPowerSource } from './powerSourceSettings';
import { assembleWeatherAdvisorReadout } from './appInit/weatherAdvisorReadoutAssembler';
import {
  requireDailyBudgetService,
  requireDeviceDiagnosticsService,
  requirePlanService,
} from './appInit/contextGuards';
import type { AppSmartTaskApi, SmartTaskWriteResult } from './appSmartTaskApi';
import type { AppSmartTaskPayloads } from './appSmartTaskPayloads';
import type { RefreshTargetDevicesSnapshotOptions } from './appSnapshotHelpers';
import type { AppRuntimeHandles } from './appRuntimeHandles';
import { resolveCurrentMonthQuarterPeakKw } from '../lib/power/capacityPeak';
import {
  readHomeBatteryDevices,
  resolveCapacityControlEnabled,
  resolveDeviceManagedState,
} from '../lib/device/deviceRoleReads';
import type { HomeBatteryDevicesRead } from '../lib/ports/homeBatteryDevices';
import type { CapacityScalarSettings } from '../packages/contracts/src/capacitySettings';
import type { PriceOptimizationSetupRead } from '../packages/contracts/src/priceOptimizationSettings';

/**
 * Stable Homey/widget/settings-API façade. Bodies either resolve a value from
 * the trusted live context or delegate to one focused setup-layer controller.
 */
/** Add the stable host API to the Homey entry-point class supplied by `app.ts`. */
// The callback body is one class declaration; class/file line caps still apply.
// eslint-disable-next-line max-lines-per-function
export const withAppHostApi = (Base: typeof Homey.App) => {
abstract class AppHostApi extends Base implements PelsWidgetHostApi {
  protected abstract readonly context: AppContext;
  protected abstract readonly getHomeOperatingMode: () => string;
  protected abstract readonly setHomeOperatingMode: (
    mode: string,
  ) => { previous: string; resolved: string };
  protected abstract readonly reloadHomeModeCatalog: () => void;
  /** The target the device's governing mode holds for it, or `null` (`readGoverningModeDeviceTargetC`). */
  protected abstract readonly readGoverningModeTargetC: (deviceId: string) => number | null;
  protected abstract readonly resolveHomeModeName: (mode: string) => string;
  protected abstract readonly getHomeModeNames: () => Set<string>;
  protected abstract readonly listDeviceTargetModes: FlowCardDeps['listDeviceTargetModes'];
  protected abstract readonly setDeviceModeTarget: FlowCardDeps['setDeviceModeTarget'];
  protected abstract readonly smartTaskApi: AppSmartTaskApi;
  protected abstract readonly smartTaskPayloads: AppSmartTaskPayloads;
  protected abstract readonly runtime: AppRuntimeHandles;
  // The price wiring replaces PelsApp's default once the coordinator exists.
  public abstract getCombinedPricesForUi: () => unknown;

  public readHardCapConfiguration = (): SettingsUiHardCapConfigurationRead => (
    this.context.capacitySettingsStore.readHardCapConfiguration()
  );

  public getCapacityScalars = (): CapacityScalarSettings => ({
    ...this.context.capacitySettings,
    dryRun: this.context.capacityDryRun,
  });

  public readPriceOptimizationSetup = (): PriceOptimizationSetupRead => {
    const coordinator = this.context.priceCoordinator;
    return coordinator ? coordinator.readPriceOptimizationSetup() : { state: 'unavailable' };
  };

  public readPriceSetup = (): PriceSetupRead => {
    const coordinator = this.context.priceCoordinator;
    return coordinator ? coordinator.readPriceSetup() : { state: 'unavailable' };
  };

  public readPriceLevelSummary = (): PriceLevelSummaryRead => {
    const coordinator = this.context.priceCoordinator;
    return coordinator ? coordinator.readPriceLevelSummary() : { state: 'unavailable' };
  };

  // `unavailable` until the price coordinator is wired, like the setup read above.
  public getPriceTimelineForUi = (): PriceTimelineRead => {
    const coordinator = this.context.priceCoordinator;
    return coordinator ? coordinator.getPriceTimeline() : { state: 'unavailable', reason: 'no_prices' };
  };

  public suggestPriceSetup = async (): Promise<PriceSetupSuggestion> => {
    const coordinator = this.context.priceCoordinator;
    // Before the price coordinator is wired there is nothing to suggest yet.
    if (!coordinator) {
      return { gridCompany: { kind: 'none' }, priceArea: { kind: 'none' }, powerhour: { kind: 'none' } };
    }
    return coordinator.suggestPriceSetup();
  };

  public getCurrentMonthCapacityPeakKw = (): number | null => resolveCurrentMonthQuarterPeakKw(
    this.context.powerTracker,
    this.getTimeZone(),
    Date.now(),
  );

  // The read answers `unavailable` when the service is not wired yet, because
  // that IS the boot window the member is for — the method itself exists from
  // construction, so the honest answer has to come from here. Preview and apply below keep throwing: they
  // are commands, and a command that cannot run must fail loudly rather than
  // report a state.
  public getDailyBudgetUiPayload(): DailyBudgetUiRead {
    const service = this.context.dailyBudgetService;
    return service ? service.getUiPayload() : { kind: 'unavailable' };
  }

  public previewDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetModelPreviewResponse {
    return requireDailyBudgetService(this.context).previewModelSettings(settings);
  }

  public applyDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetUiRead {
    return requireDailyBudgetService(this.context).applyModelSettings(settings);
  }

  public getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    return requirePlanService(this.context).getLatestPlanSnapshotForUi();
  }

  public registerFlowCards(): void {
    this.registerAppFlowCards();
  }

  protected abstract registerAppFlowCards(): void;

  public async handleOperatingModeChange(rawMode: string): Promise<void> {
    const { previous: previousMode, resolved } = this.setHomeOperatingMode(rawMode);
    if (resolved !== rawMode) {
      getDebugEmitter('settings', 'settings')({
        event: 'mode_resolved_via_alias', requestedMode: rawMode, resolvedMode: resolved,
      });
    }
    const aliasUsed = rawMode !== resolved ? rawMode : null;
    if (this.homey.settings.get('mode_alias_used') !== aliasUsed) this.homey.settings.set('mode_alias_used', aliasUsed);
    if (previousMode?.toLowerCase() === resolved.toLowerCase()) {
      getDebugEmitter('settings', 'settings')({ event: 'mode_already_active', mode: resolved });
    }
    this.context.notifyOperatingModeChanged(resolved);
  }

  public async getFlowSnapshot(): Promise<DecoratedDeviceSnapshot[]> {
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(
      readFlowDevices(
        await this.readFlowDeviceDescriptors(),
        (deviceId) => this.context.observer.getObservedRecord(deviceId),
      ),
    );
  }

  /**
   * Flow cards that need only inventory metadata use descriptors directly.
   * The read shares the lazy initial refresh with `getFlowSnapshot`, without
   * joining Observer state or decorating planner input.
   */
  public async getFlowDeviceDescriptors(): Promise<DeviceDescriptorRead[]> {
    return this.readFlowDeviceDescriptors();
  }

  private async readFlowDeviceDescriptors(): Promise<DeviceDescriptorRead[]> {
    const descriptors = this.context.deviceReads.descriptors();
    if (descriptors.length > 0) return descriptors;
    await this.refreshTargetDevicesSnapshot();
    return this.context.deviceReads.descriptors();
  }

  /** Device inventory metadata; runtime state comes from Observer. */
  public getDeviceDescriptors(): DeviceDescriptorRead[] {
    return this.context.deviceReads.descriptors();
  }

  /** The by-id form of the inventory read. */
  public getDeviceDescriptor(deviceId: string): DeviceDescriptorRead | undefined {
    return this.context.deviceReads.descriptor(deviceId);
  }

  /** Settings UI needs inventory metadata plus the separately owned observation. */
  public getSettingsUiManagedDevices(): DecoratedDeviceSnapshot[] {
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(
      this.context.getDeviceSurfaces(),
    );
  }

  /** Legacy host alias; internal runtime consumers use `getPlanInputSnapshot()`. */
  public get latestTargetSnapshot(): PlanInputSnapshotDevice[] {
    return this.getPlanInputSnapshot();
  }

  /** Plan/executor input, composed only from their two owners. */
  public getPlanInputSnapshot(): PlanInputSnapshotDevice[] {
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(this.getRuntimeDevices());
  }

  private getRuntimeDevices() {
    return readRuntimeDevices(
      this.context.deviceConfiguration.getAll(),
      (deviceId) => this.context.observer.getObservedRecord(deviceId),
    );
  }

  private getRuntimeDevice(deviceId: string): PlanInputSnapshotDevice | undefined {
    const device = readRuntimeDevice(
      this.context.deviceConfiguration.get(deviceId),
      this.context.observer.getObservedRecord(deviceId),
    );
    return device
      ? this.context.deviceControlHelpers.decorateTargetSnapshotList([device])[0]
      : undefined;
  }

  /** Picker view for unmanaged devices; runtime planning reads from Observer. */
  public getUiPickerDevices(): DecoratedDeviceSnapshot[] {
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(
      this.context.settingsUiDeviceReads.getUiPickerDevices(),
    );
  }

  public getCreateSmartTaskCandidateDevices(): CreateSmartTaskCandidateDevicesRead {
    return readCreateSmartTaskCandidateDevices(this.context);
  }

  public resolveSmartTaskHomeScope(deviceId: string): SmartTaskHomeScope {
    return resolveSmartTaskHomeScope(this.context, deviceId);
  }

  public getStarvedRescueDevices(): StarvationRescueDevice[] {
    return buildStarvedRescueDevices(this.context);
  }

  public getLimitedNotListedDevices(): StarvationNotListedDevice[] {
    return buildLimitedNotListedDevices(this.context);
  }

  public async refreshTargetDevicesSnapshot(options: RefreshTargetDevicesSnapshotOptions = {}): Promise<void> {
    await this.context.snapshotHelpers.refreshTargetDevicesSnapshot(options);
  }

  public getTimeZone = (): string => this.homey.clock.getTimezone();
  public getPowerSource = (): PowerSource => requireConfiguredPowerSource(this.homey.settings);
  public getNow = (): Date => new Date();

  public readHomeBatteryDevices = (): HomeBatteryDevicesRead => readHomeBatteryDevices(this.context.deviceManager);
  public resolveManagedState = (deviceId: string): boolean => resolveDeviceManagedState(
    this.context.deviceManager,
    this.context.batteryManaged,
    this.context.deviceControlSettings,
    deviceId,
  );
  public isCapacityControlEnabled = (deviceId: string): boolean => resolveCapacityControlEnabled(
    this.context.deviceManager,
    this.context.deviceControlSettings,
    deviceId,
  );
  public getShedBehavior = (deviceId: string) => resolveTemperaturePolicyShedBehavior(
    this.context.deviceControlSettings.getConfiguredShedBehavior(deviceId),
    this.context.deviceConfiguration.get(deviceId),
    // Lazy and single-device: this runs several times per device per plan build,
    // and `getPlanInputSnapshot` rebuilds the whole list on every access.
    () => this.getRuntimeDevice(deviceId),
    this.context.observedTemperatureModeUpdates.allowsLimiting(deviceId),
    // The observer's answer, so the configured pair collapses to the one limit
    // for the direction the device is moving demand in — the same resolution
    // `toPlanDevice` asks for the price shift.
    this.context.observer.getThermalDirection(deviceId),
    () => this.readGoverningModeTargetC(deviceId),
  );

  public getShedLimitTemperaturesC = (deviceId: string): readonly number[] => resolveTemperaturePolicyShedLimitsC(
    this.context.deviceControlSettings.getConfiguredShedBehavior(deviceId),
    this.context.deviceConfiguration.get(deviceId),
    () => this.getRuntimeDevice(deviceId),
    () => this.readGoverningModeTargetC(deviceId),
  );

  public computeDynamicSoftLimit = (): number | null => requirePlanService(this.context).computePhysicalPowerLimit();

  public getDeviceDiagnosticsUiPayload(): SettingsUiDeviceDiagnosticsPayload {
    return requireDeviceDiagnosticsService(this.context).getUiPayload();
  }

  public getDeviceLogUiPayload(): SettingsUiDeviceLogPayload {
    return requirePlanService(this.context).getDeviceLogUiPayload();
  }

  // Read through the weather collector, the history stores' only holder. It is
  // constructed (not necessarily started) after the startup window, so a
  // disabled weather insight still serves its persisted history.
  public getBudgetDailyHistory(query: unknown): BudgetDailyHistory {
    return this.requireWeatherCollector().budgetHistory.readDays(query);
  }

  public getBudgetDecisionHistory(query: unknown): BudgetDecisionHistory {
    return this.requireWeatherCollector().budgetHistory.readDecisions(query);
  }

  public async getWeatherAdvisorReadout(): Promise<WeatherAdvisorReadout> {
    const collector = this.runtime.backgroundCollectors?.weatherCollector;
    if (!collector) return { kind: 'inactive' };
    const dailyBudget = requireDailyBudgetService(this.context);
    return assembleWeatherAdvisorReadout(this.context, collector, dailyBudget);
  }

  public hasDeferredObjectiveForDevice(deviceId: string): boolean {
    return this.smartTaskApi.hasDeferredObjectiveForDevice(deviceId);
  }
  public getDeferredObjectiveActivePlansUiPayload(): ResolvedDeferredObjectiveActivePlansV1 | null {
    return this.smartTaskPayloads.getDeferredObjectiveActivePlansUiPayload();
  }
  public previewStarvationRescuePlan(deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate): {
    estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean;
  } {
    return this.smartTaskApi.previewStarvationRescuePlan(deviceId, candidate);
  }
  public previewDeferredObjectivePlan(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate {
    return this.smartTaskApi.previewDeferredObjectivePlan(deviceId, candidate);
  }
  public createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
    rescuePolicy: 'preserve' | 'replace' = 'preserve',
  ): SmartTaskWriteResult {
    return this.smartTaskApi.createDeferredObjective(deviceId, candidate, rescuePolicy);
  }
  public createNewDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): NewSmartTaskWriteResult {
    return this.smartTaskApi.createNewDeferredObjective(deviceId, candidate);
  }
  public cancelDeferredObjective(deviceId: string) {
    return this.smartTaskApi.cancelDeferredObjective(deviceId);
  }
  public rescueDeviceWithBudgetExemption(
    deviceId: string, candidate: DeferredObjectivePlanPreviewCandidate,
  ): SmartTaskWriteResult {
    return this.smartTaskApi.rescueDeviceWithBudgetExemption(deviceId, candidate);
  }
  public getDeferredObjectivePlanHistoryUiPayload(): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.smartTaskPayloads.getDeferredObjectivePlanHistoryUiPayload();
  }
  public getDeferredObjectivePlanHistoryRecentUiPayload(
    sinceMs: number,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.smartTaskPayloads.getDeferredObjectivePlanHistoryRecentUiPayload(sinceMs);
  }
  protected requireWeatherCollector(): WeatherCollector {
    const collectors = this.runtime.backgroundCollectors;
    if (!collectors) throw new Error('Budget history is unavailable during startup');
    return collectors.weatherCollector;
  }
}

return AppHostApi;
};
