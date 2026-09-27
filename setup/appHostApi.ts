import { resolveTemperaturePolicyShedBehavior } from '../lib/device/temperatureControlPosture';
import type Homey from 'homey';
import type { AppContext } from '../lib/app/appContext';
import type { DeviceTransportPort } from '../lib/device/deviceTransport';
import { readRuntimeDevice, readRuntimeDevices } from '../lib/device/deviceRuntimeRead';
import { readFlowDevices } from '../lib/device/deviceFlowRead';
import { PriceLevel } from '../lib/price/priceLevels';
import type { CombinedHourlyPrice } from '../lib/price/priceTypes';
import type { PowerSource } from '../lib/power/powerSource';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetSettingsInput,
  DailyBudgetUiRead,
} from '../lib/dailyBudget/dailyBudgetTypes';
import { resolveShedBehavior } from '../packages/shared-domain/src/settings/shedBehaviors';
import type {
  DecoratedDeviceSnapshot,
  DeviceDescriptorRead,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import type { DeviceConfigurationRead } from '../lib/ports/deviceConfigurationRead';
import type {
  SettingsUiHardCapConfigurationRead,
  SettingsUiPlanSnapshot,
} from '../packages/contracts/src/settingsUiApi';
import type {
  CreateSmartTaskCandidateDevicesRead,
  PelsWidgetHostApi,
} from '../packages/contracts/src/widgetHostApi';
import type { SmartTaskHomeScope } from '../packages/contracts/src/smartTaskHomeScope';
import type { SettingsUiDeviceDiagnosticsPayload } from '../packages/contracts/src/deviceDiagnosticsTypes';
import type { ResolvedDeferredObjectiveActivePlansV1 } from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectivePlanPreviewEstimate } from '../packages/contracts/src/deferredObjectivePlanPreview';
import type { StarvationRescueDevice } from '../packages/contracts/src/starvationRescue';
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
  buildStarvedRescueDevices,
  readCreateSmartTaskCandidateDevices,
  resolveSmartTaskHomeScope,
} from './appInit/smartTaskHomeScope';
import { requireConfiguredPowerSource } from './powerSourceSettings';
import { assembleWeatherAdvisorReadout } from './appInit/weatherAdvisorReadoutAssembler';
import { requirePlanService as requireInitializedPlanService } from './appInit/contextGuards';
import type { AppSmartTaskApi, SmartTaskWriteResult } from './appSmartTaskApi';
import type { AppSmartTaskPayloads } from './appSmartTaskPayloads';
import type { RefreshTargetDevicesSnapshotOptions } from './appSnapshotHelpers';
import { resolveCurrentMonthQuarterPeakKw } from '../lib/power/capacityPeak';
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
  protected abstract readonly resolveHomeModeName: (mode: string) => string;
  protected abstract readonly getHomeModeNames: () => Set<string>;
  protected abstract readonly smartTaskApi: AppSmartTaskApi;
  protected abstract readonly smartTaskPayloads: AppSmartTaskPayloads;
  protected abstract weatherCollector?: WeatherCollector;

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

  public getCurrentMonthCapacityPeakKw = (): number | null => resolveCurrentMonthQuarterPeakKw(
    this.context.powerTracker,
    this.getTimeZone(),
    Date.now(),
  );

  // The read answers `unavailable` when the service is not wired yet, because
  // that IS the boot window the member is for — `hasDailyBudgetSeam` can only
  // see the prototype method, which exists from construction, so the honest
  // answer has to come from here. Preview and apply below keep throwing: they
  // are commands, and a command that cannot run must fail loudly rather than
  // report a state.
  public getDailyBudgetUiPayload(): DailyBudgetUiRead {
    const service = this.context.dailyBudgetService;
    return service ? service.getUiPayload() : { kind: 'unavailable' };
  }

  public previewDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetModelPreviewResponse {
    return this.requireDailyBudgetService().previewModelSettings(settings);
  }

  public applyDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetUiRead {
    return this.requireDailyBudgetService().applyModelSettings(settings);
  }

  public getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    return this.requirePlanService().getLatestPlanSnapshotForUi();
  }

  public registerFlowCards(): void {
    this.registerAppFlowCards();
  }

  protected abstract registerAppFlowCards(): void;

  public async handleOperatingModeChange(rawMode: string): Promise<void> {
    const { previous: previousMode, resolved } = this.setHomeOperatingMode(rawMode);
    if (resolved !== rawMode) {
      this.context.getStructuredDebugEmitter('settings', 'settings')({
        event: 'mode_resolved_via_alias', requestedMode: rawMode, resolvedMode: resolved,
      });
    }
    const aliasUsed = rawMode !== resolved ? rawMode : null;
    if (this.homey.settings.get('mode_alias_used') !== aliasUsed) this.homey.settings.set('mode_alias_used', aliasUsed);
    if (previousMode?.toLowerCase() === resolved.toLowerCase()) {
      this.context.getStructuredDebugEmitter('settings', 'settings')({ event: 'mode_already_active', mode: resolved });
    }
    this.context.notifyOperatingModeChanged(resolved);
  }

  public async getFlowSnapshot(): Promise<DecoratedDeviceSnapshot[]> {
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(
      readFlowDevices(
        await this.readFlowDeviceDescriptors(),
        (deviceId) => this.context.getObservedRecord(deviceId),
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
  public get latestTargetSnapshot(): (DecoratedDeviceSnapshot & DeviceConfigurationRead)[] {
    return this.getPlanInputSnapshot();
  }

  /** Plan/executor input, composed only from their two owners. */
  public getPlanInputSnapshot(): (DecoratedDeviceSnapshot & DeviceConfigurationRead)[] {
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(this.getRuntimeDevices());
  }

  private getRuntimeDevices() {
    return readRuntimeDevices(
      this.context.deviceConfiguration.getAll(),
      (deviceId) => this.context.getObservedRecord(deviceId),
    );
  }

  private getRuntimeDevice(deviceId: string): DecoratedDeviceSnapshot | undefined {
    const device = readRuntimeDevice(
      this.context.deviceConfiguration.get(deviceId),
      this.context.getObservedRecord(deviceId),
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

  public setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
    this.requireDeviceManager().setSnapshotForTests(snapshot);
  }

  public parseDevicesForTests(
    list: Parameters<DeviceTransportPort['parseDeviceListForTests']>[0],
  ): TargetDeviceSnapshot[] {
    return this.requireDeviceManager().parseDeviceListForTests(list);
  }

  public async refreshTargetDevicesSnapshot(options: RefreshTargetDevicesSnapshotOptions = {}): Promise<void> {
    await this.context.snapshotHelpers.refreshTargetDevicesSnapshot(options);
  }

  public getCombinedHourlyPrices = (): CombinedHourlyPrice[] => (
    this.requirePriceCoordinator().getCombinedHourlyPrices()
  );
  public getTimeZone = (): string => this.homey.clock.getTimezone();
  public getPowerSource = (): PowerSource => requireConfiguredPowerSource(this.homey.settings);
  public getNow = (): Date => new Date();
  public getCurrentHourPriceLevel = (): PriceLevel => (
    this.requirePriceCoordinator().getCurrentHourPriceLevel()
  );

  public storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string; storedCount: number; missingHours: number[];
  } {
    return this.requirePriceCoordinator().storeFlowPriceData(kind, raw);
  }

  protected isObserveOnlyRoleDevice = (deviceId: string): boolean => (
    this.context.deviceManager?.isBatteryDevice(deviceId) === true
    || this.context.deviceManager?.isSolarDevice(deviceId) === true
  );
  public resolveManagedState = (deviceId: string): boolean => (
    this.isObserveOnlyRoleDevice(deviceId) || this.context.managedDevices[deviceId] === true
  );
  protected isManagedFilterActive = (): boolean => (
    Object.values(this.context.managedDevices).some((value) => value === true)
  );
  protected getDeviceDriverIdOverride = (deviceId: string): string | undefined => {
    const override = this.context.deviceDriverOverrides[deviceId]?.trim();
    return override || undefined;
  };
  public isCapacityControlEnabled = (deviceId: string): boolean => (
    !this.isObserveOnlyRoleDevice(deviceId)
    && this.context.managedDevices[deviceId] === true
    && this.context.controllableDevices[deviceId] === true
  );
  public isBudgetExempt = (deviceId: string): boolean => this.context.budgetExemptDevices[deviceId] === true;
  public getTemperatureBoostConfig = (deviceId: string) => this.context.temperatureBoostSettings[deviceId];
  public getEvBoostConfig = (deviceId: string) => this.context.evBoostSettings[deviceId];
  public getShedBehavior = (deviceId: string) => resolveTemperaturePolicyShedBehavior(
    resolveShedBehavior(this.context.shedBehaviors, deviceId),
    // Lazy and single-device: this runs several times per device per plan build,
    // and `getPlanInputSnapshot` rebuilds the whole list on every access.
    () => this.getRuntimeDevice(deviceId),
    this.context.observedTemperatureModeUpdates.allowsLimiting(deviceId),
    // The observer's answer, so the configured pair collapses to the one limit
    // for the direction the device is moving demand in — the same resolution
    // `toPlanDevice` asks for the price shift.
    this.context.getThermalDirection(deviceId),
  );

  public computeDynamicSoftLimit = (): number => this.requirePlanService().computeDynamicSoftLimit();
  protected computeShortfallThreshold = (): number => this.requirePlanService().computeShortfallThreshold();

  public getDeviceDiagnosticsUiPayload(): SettingsUiDeviceDiagnosticsPayload {
    return this.requireDeviceDiagnosticsService().getUiPayload();
  }

  public getDeviceLogUiPayload(): SettingsUiDeviceLogPayload {
    return this.requirePlanService().getDeviceLogUiPayload();
  }

  public getWeatherAdvisorReadout(): Promise<WeatherAdvisorReadout> {
    return assembleWeatherAdvisorReadout({ ctx: this.context, collector: this.weatherCollector });
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
  protected requirePriceCoordinator() {
    if (!this.context.priceCoordinator) throw new Error('PriceCoordinator must be initialized');
    return this.context.priceCoordinator;
  }
  protected requirePlanService() {
    return requireInitializedPlanService(this.context);
  }
  protected requireDeviceManager(): DeviceTransportPort {
    if (!this.context.deviceManager) throw new Error('DeviceTransport must be initialized');
    return this.context.deviceManager;
  }
  protected requireDeviceDiagnosticsService() {
    if (!this.context.deviceDiagnosticsService) {
      throw new Error('DeviceDiagnosticsService must be initialized');
    }
    return this.context.deviceDiagnosticsService;
  }
  protected requireDailyBudgetService() {
    if (!this.context.dailyBudgetService) throw new Error('DailyBudgetService must be initialized');
    return this.context.dailyBudgetService;
  }
}

return AppHostApi;
};
