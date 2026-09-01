import type Homey from 'homey';
import type { AppContext } from '../lib/app/appContext';
import type { DeviceTransport } from '../lib/device/deviceTransport';
import { PriceLevel } from '../lib/price/priceLevels';
import type { CombinedHourlyPrice } from '../lib/price/priceTypes';
import type { PowerSource } from '../lib/power/powerSource';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetSettingsInput,
  DailyBudgetUiRead,
} from '../lib/dailyBudget/dailyBudgetTypes';
import {
  getAllModes as getAllModesHelper,
  getShedBehavior as getShedBehaviorHelper,
  resolveModeName as resolveModeNameHelper,
} from '../lib/utils/capacityHelpers';
import { OPERATING_MODE_SETTING } from '../lib/utils/settingsKeys';
import type {
  DecoratedDeviceSnapshot,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import type { SettingsUiPlanSnapshot } from '../packages/contracts/src/settingsUiApi';
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
  SmartTaskWriteOrigin,
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
import { SMART_TASK_WIDGET_WRITE_ORIGIN } from './appSmartTaskApi';
import type { AppSmartTaskPayloads } from './appSmartTaskPayloads';
import type { RefreshTargetDevicesSnapshotOptions } from './appSnapshotHelpers';
import { readCurrentPriceLevel } from './priceLevelSettings';

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
  protected abstract readonly smartTaskApi: AppSmartTaskApi;
  protected abstract readonly smartTaskPayloads: AppSmartTaskPayloads;
  protected abstract weatherCollector?: WeatherCollector;

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
    const resolved = resolveModeNameHelper(
      rawMode,
      this.context.modeAliases,
      getAllModesHelper('', this.context.capacityPriorities, this.context.modeDeviceTargets),
    );
    const previousMode = this.context.operatingMode;
    if (resolved !== rawMode) {
      this.context.getStructuredDebugEmitter('settings', 'settings')({
        event: 'mode_resolved_via_alias', requestedMode: rawMode, resolvedMode: resolved,
      });
    }
    this.context.operatingMode = resolved;
    this.homey.settings.set(OPERATING_MODE_SETTING, resolved);
    const aliasUsed = rawMode !== resolved ? rawMode : null;
    if (this.homey.settings.get('mode_alias_used') !== aliasUsed) this.homey.settings.set('mode_alias_used', aliasUsed);
    if (previousMode?.toLowerCase() === resolved.toLowerCase()) {
      this.context.getStructuredDebugEmitter('settings', 'settings')({ event: 'mode_already_active', mode: resolved });
    }
    this.context.notifyOperatingModeChanged(resolved);
  }

  public async getFlowSnapshot(): Promise<DecoratedDeviceSnapshot[]> {
    if (this.latestTargetSnapshot.length === 0) await this.refreshTargetDevicesSnapshot();
    return this.latestTargetSnapshot;
  }

  public getCurrentPriceLevel(): PriceLevel {
    return readCurrentPriceLevel(
      this.homey.settings,
      () => this.requirePlanService().getLastNotifiedPriceLevel(),
    );
  }

  public get latestTargetSnapshot(): DecoratedDeviceSnapshot[] {
    const snapshot = this.context.deviceManager?.getSnapshot() ?? [];
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }

  public getUiPickerDevices(): DecoratedDeviceSnapshot[] {
    const snapshot = this.context.deviceManager?.getUiPickerDevices() ?? [];
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
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

  public parseDevicesForTests(list: Parameters<DeviceTransport['parseDeviceListForTests']>[0]): TargetDeviceSnapshot[] {
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
  public findCheapestHours = (count: number): string[] => this.requirePriceCoordinator().findCheapestHours(count);
  public isCurrentHourCheap = (): boolean => this.requirePriceCoordinator().isCurrentHourCheap();
  public getCurrentHourPriceLevel = (): PriceLevel => (
    this.requirePriceCoordinator().getCurrentHourPriceLevel()
  );
  public isCurrentHourExpensive = (): boolean => this.requirePriceCoordinator().isCurrentHourExpensive();
  public getCurrentHourPriceInfo = (): string => this.requirePriceCoordinator().getCurrentHourPriceInfo();

  public storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string; storedCount: number; missingHours: number[];
  } {
    return this.requirePriceCoordinator().storeFlowPriceData(kind, raw);
  }

  public async applyPriceOptimization(): Promise<void> {
    await this.requirePriceCoordinator().applyPriceOptimization();
  }

  public resolveModeName = (name: string): string => resolveModeNameHelper(
    name,
    this.context.modeAliases,
    getAllModesHelper('', this.context.capacityPriorities, this.context.modeDeviceTargets),
  );
  public getAllModes = (): Set<string> => (
    getAllModesHelper(this.context.operatingMode, this.context.capacityPriorities, this.context.modeDeviceTargets)
  );
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
  public getShedBehavior = (deviceId: string) => getShedBehaviorHelper(deviceId, this.context.shedBehaviors);
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
    origin: SmartTaskWriteOrigin = SMART_TASK_WIDGET_WRITE_ORIGIN,
    rescuePolicy: 'preserve' | 'replace' = 'preserve',
  ): SmartTaskWriteResult {
    return this.smartTaskApi.createDeferredObjective(deviceId, candidate, origin, rescuePolicy);
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
  protected requireDeviceManager(): DeviceTransport {
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
