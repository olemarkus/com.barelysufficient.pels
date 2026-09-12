import { resolveTemperaturePolicyShedBehavior } from '../lib/device/temperatureControlPosture';
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
  DeviceDescriptorRead,
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
import {
  projectDeviceDescriptors,
  readDeviceDescriptor,
  readDeviceDescriptors,
} from '../lib/device/deviceDescriptorProjection';
import { projectDeviceSurfaces, readDeviceSurface, readDeviceSurfaces } from '../lib/device/deviceSurfaces';
import type { AppSmartTaskApi, SmartTaskWriteResult } from './appSmartTaskApi';
import { SMART_TASK_WIDGET_WRITE_ORIGIN } from './appSmartTaskApi';
import type { AppSmartTaskPayloads } from './appSmartTaskPayloads';
import type { RefreshTargetDevicesSnapshotOptions } from './appSnapshotHelpers';

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

  /**
   * The Flow-card device list as DESCRIPTORS: identity and config, no
   * observations.
   *
   * Same underlying value and same lazy first-read refresh as `getFlowSnapshot`
   * above — deliberately, so this is a pure narrowing of the declared surface
   * with no behaviour change. Most Flow cards only ever wanted a descriptor:
   * they resolve a device by id and filter with predicates that read
   * `deviceClass`, `controlAdapter` or `targetPowerConfig`. Handing them the
   * whole snapshot let them reach observations they never asked for, and is why
   * `getSnapshot()` cannot be sealed inside transport yet.
   */
  public async getFlowDeviceDescriptors(): Promise<DeviceDescriptorRead[]> {
    return projectDeviceDescriptors(await this.getFlowSnapshot());
  }

  /**
   * The device DESCRIPTORS, synchronously — identity and config, no observations.
   *
   * Surface 2 of the observer/transport split
   * (`notes/state-management/snapshot-decomposition.md`). Most wiring that
   * reaches for `getSnapshot()` wants only this: a device's id, its zone, what it
   * can natively write, what class it is. PROJECTED, not merely narrowed
   * (`projectDeviceDescriptor`): the executor spreads a descriptor into its own
   * read, and a spread copies what the object physically carries, so the served
   * object must carry no observation — the property stage 7 needs before
   * `getSnapshot()` can be sealed inside transport.
   *
   * The reads themselves live with their owner (`readDeviceDescriptors` in
   * `lib/device/deviceDescriptorProjection.ts`); this façade only delegates, and
   * decides one thing: what an absent transport means. The two forms answer that
   * differently, on purpose. This list read resolves to "no devices": one of its
   * callers is the target-power probe scheduler's timer
   * (`appTargetPowerReachabilityWiring.ts`), which cannot surface a throw and
   * runs before the transport exists in the app's own boot ordering
   * (`setup/AGENTS.md`: "assert only where the caller can surface the error, and
   * resolve where it cannot"). The by-id read below is the executor's alone,
   * constructed only after `requireDeviceManager`, so it asserts.
   */
  public getDeviceDescriptors(): DeviceDescriptorRead[] {
    const transport = this.context.deviceManager;
    return transport ? readDeviceDescriptors(transport) : [];
  }

  /**
   * The by-id form of `getDeviceDescriptors`, same projection. Asserts the
   * transport rather than optional-chaining it: this is the executor's read, and
   * an absent transport must surface as the boot-order error, not as "untracked
   * device" — a plan decided and silently never applied (`setup/AGENTS.md`
   * § "An extracted body re-asserts a boot-window invariant by throwing, never
   * by defaulting").
   */
  public getDeviceDescriptor(deviceId: string): DeviceDescriptorRead | undefined {
    return readDeviceDescriptor(this.requireDeviceManager(), deviceId);
  }

  /**
   * The plan-input view: every tracked device as its descriptor joined with the
   * observer's record (`readDeviceSurfaces`), then decorated with the stepped
   * command state. Stage 6 of the snapshot decomposition: what the plan-input
   * producer gets is the union of the two declared surfaces and nothing else, so
   * the carried-key gate on `toPlanDevice` is a statement about the object, not
   * just its type. (The raw snapshot is still the SOURCE of both halves, and on
   * the no-record fallback path it is the source of the observed half directly —
   * what it no longer does is travel onward as itself.)
   *
   * Still a getter that re-projects and re-decorates on every access, so a
   * per-device lookup inside a loop is O(n²) — read it once per pass.
   */
  public get latestTargetSnapshot(): DecoratedDeviceSnapshot[] {
    const transport = this.context.deviceManager;
    if (!transport) return [];
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(
      readDeviceSurfaces(transport, (deviceId) => this.context.getObservedRecord(deviceId)),
    );
  }

  /**
   * The picker list is a fresh parse of every Homey device, managed or not, so
   * an unmanaged entry has no observer record to join against: both surfaces
   * are projected from the parse itself (`projectDeviceSurfaces`), which keeps
   * a picker device bounded exactly like a tracked one when the smart-task
   * preview hands it to `toPlanDevice`.
   */
  public getUiPickerDevices(): DecoratedDeviceSnapshot[] {
    const snapshot = this.context.deviceManager?.getUiPickerDevices() ?? [];
    return this.context.deviceControlHelpers.decorateTargetSnapshotList(projectDeviceSurfaces(snapshot));
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
  public getShedBehavior = (deviceId: string) => resolveTemperaturePolicyShedBehavior(
    getShedBehaviorHelper(deviceId, this.context.shedBehaviors),
    // Lazy and single-device: this runs several times per device per plan build,
    // and `latestTargetSnapshot` rebuilds the whole list on every access.
    () => this.decorateOneDevice(deviceId),
    this.context.observedTemperatureModeUpdates.allowsAutomaticAdjustments(deviceId),
  );

  /** One device through the same join + decoration `latestTargetSnapshot` applies to all of them. */
  private decorateOneDevice(deviceId: string): DecoratedDeviceSnapshot | undefined {
    const transport = this.context.deviceManager;
    if (!transport) return undefined;
    const device = readDeviceSurface(transport, (id) => this.context.getObservedRecord(id), deviceId);
    return device ? this.context.deviceControlHelpers.decorateTargetSnapshotList([device])[0] : undefined;
  }
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
