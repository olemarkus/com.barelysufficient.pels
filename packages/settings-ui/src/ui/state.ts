import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  DeviceTargetPowerConfigs,
  EvBoostConfig,
  EvBoostSettings,
  MeasuredPowerObservedProbe,
  TemperatureBoostConfig,
  TemperatureBoostSettings,
} from '../../../contracts/src/types.ts';
import {
  createEmptyDeferredObjectiveSettings,
  type DeferredObjectiveSettingsV1,
} from '../../../contracts/src/deferredObjectiveSettings.ts';
import type { OverviewDeferredObjectiveActivePlans } from '../../../contracts/src/deferredObjectiveActivePlans.ts';
import { DEFAULT_MODE_NAME } from '../../../shared-domain/src/modeLabels.ts';

export type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';
export type ShedBehavior = {
  action: ShedAction;
  temperature?: number;
  stepId?: string;
};

export type PriceOptimizationConfig = {
  enabled: boolean;
  cheapDelta: number;
  expensiveDelta: number;
  // Surplus-absorb rides this same per-device blob (a distinct cause from price —
  // triggered by exporting, not a cheap hour). Optional so non-solar blobs stay
  // byte-identical.
  surplusWilling?: boolean;
  surplusDelta?: number;
};

/**
 * Settings-UI device view: the decorated backend snapshot plus the UI's own
 * optimistic mirror of boost config. `temperatureBoost`/`evBoost` are NOT part
 * of the backend snapshot contract — the planner sources boost via the app
 * context (`ctx.get*BoostConfig`), and the UI's authoritative source is
 * `state.{temperature,ev}BoostSettings`. The device-detail handlers write these
 * onto the live device object optimistically after a successful settings write.
 *
 * Probe-widened with `MeasuredPowerObservedProbe`: the `/ui_devices` snapshot
 * physically carries the observed `measuredPowerKw` the base type omits
 * (measured-power-observed slice), which the device-control-profile and
 * target-power-config panes read.
 */
export type SettingsUiDeviceView = DecoratedDeviceSnapshot & MeasuredPowerObservedProbe & {
  temperatureBoost?: TemperatureBoostConfig;
  evBoost?: EvBoostConfig;
};

export type UiState = {
  isBusy: boolean;
  initialLoadComplete: boolean;
  devicesLoaded: boolean;
  devicesLoading: boolean;
  dryRun: boolean;
  // The currently shown panel (top tab or settings sub-section `data-panel`).
  // Updated from `showTab`'s `pels:tab-shown` event (wired in boot); the global
  // simulation banner reads it so it can suppress itself on the Simulation-mode
  // settings page, whose own toggle is the single control there.
  activePanel: string;
  capacityPriorities: Record<string, Record<string, number>>;
  // The home whose complete mode catalog currently backs the shared mode maps.
  // `null` while a scope change is loading, so no consumer can mistake stale
  // maps for the newly selected area's catalog.
  loadedModeHomeId: string | null;
  activeMode: string;
  editingMode: string;
  latestDevices: SettingsUiDeviceView[];
  modeTargets: Record<string, Record<string, number>>;
  controllableMap: Record<string, boolean>;
  managedMap: Record<string, boolean>;
  budgetExemptMap: Record<string, boolean>;
  respectExternalOffMap: Record<string, boolean>;
  nativeWiringMap: Record<string, boolean>;
  deviceControlProfiles: DeviceControlProfiles;
  deviceTargetPowerConfigs: DeviceTargetPowerConfigs;
  modeAliases: Record<string, string>;
  shedBehaviors: Record<string, ShedBehavior>;
  temperatureBoostSettings: TemperatureBoostSettings;
  evBoostSettings: EvBoostSettings;
  deferredObjectiveSettings: DeferredObjectiveSettingsV1;
  deferredObjectiveActivePlans: OverviewDeferredObjectiveActivePlans | null;
  priceOptimizationSettings: Record<string, PriceOptimizationConfig>;
  // Home-level: true when an auto-tracked solar/PV device is present (from the
  // `/ui_devices` payload). The per-device "Use solar surplus" control is hidden
  // unless this OR `hasExhibitedExport` is true — the feature is meaningless in a
  // home that does not export.
  hasManagedSolarDevice: boolean;
  // Home-level: true when the home has exhibited material accumulated grid export
  // (from the `/ui_devices` payload) even without a role-detected solar device —
  // the meter-only PV case. Also unlocks the "Use solar surplus" control.
  hasExhibitedExport: boolean;
  // Device IDs the overview "Let it run now" rescue chip may offer the action on,
  // resolved server-side (budget-caused + task-free + a known target). The card
  // view gates the chip on membership so a shown chip's create call cannot be
  // rejected as not-rescuable. Empty until the first rescuable-devices fetch.
  starvationRescuableDeviceIds: Set<string>;
  // One entry per ACTIVE meter area (maintained by capacity.ts's roster+flag
  // refresh). `simulating` is the area's resolved `capacity_dry_run:<homeId>`
  // flag; `null` = no resolved value this session — a transient read miss or a
  // malformed persisted value with nothing last-good to keep (the refresh
  // preserves an area's last resolved value across bad reads, and an unknown
  // joins no aggregate claim). Together with `dryRun` this is the aggregate
  // simulation posture the global banner and the Settings hub chip render.
  // Empty until areas exist.
  meterAreaSimulation: MeterAreaSimulationEntry[];
};

// The posture snapshot entry for one ACTIVE meter area. Keyed by `homeId` so
// a refresh can match an area across renames when it keeps last-good values.
export type MeterAreaSimulationEntry = {
  homeId: string;
  name: string;
  simulating: boolean | null;
};

export const defaultPriceOptimizationConfig: PriceOptimizationConfig = {
  enabled: false,
  cheapDelta: 5,
  expensiveDelta: -5,
  surplusWilling: false,
  surplusDelta: 2,
};


export const state: UiState = {
  isBusy: false,
  initialLoadComplete: false,
  devicesLoaded: false,
  devicesLoading: false,
  dryRun: false,
  activePanel: 'overview',
  capacityPriorities: {},
  loadedModeHomeId: null,
  activeMode: DEFAULT_MODE_NAME,
  editingMode: DEFAULT_MODE_NAME,
  latestDevices: [],
  modeTargets: {},
  controllableMap: {},
  managedMap: {},
  budgetExemptMap: {},
  respectExternalOffMap: {},
  nativeWiringMap: {},
  deviceControlProfiles: {},
  deviceTargetPowerConfigs: {},
  modeAliases: {},
  shedBehaviors: {},
  temperatureBoostSettings: {},
  evBoostSettings: {},
  deferredObjectiveSettings: createEmptyDeferredObjectiveSettings(),
  deferredObjectiveActivePlans: null,
  priceOptimizationSettings: {},
  hasManagedSolarDevice: false,
  hasExhibitedExport: false,
  starvationRescuableDeviceIds: new Set<string>(),
  meterAreaSimulation: [],
};

export const resolveManagedState = (deviceId: string): boolean => {
  return state.managedMap[deviceId] === true;
};

// The per-device "Use solar surplus" control is meaningful only in a home that
// exports solar. Two independent signals unlock it: a role-detected solar/PV
// device (`hasManagedSolarDevice`) OR a meter-only PV home that has exhibited
// material grid export (`hasExhibitedExport`). Only the export signal is
// source-gated: on a flow-source home `hasExhibitedExport` is always false (the
// flow power boundary rejects negative watts), but `hasManagedSolarDevice` is
// NOT source-gated, so a flow home with a role-detected solar device still
// resolves true here.
export const resolveHomeExhibitsSolar = (): boolean => (
  state.hasManagedSolarDevice || state.hasExhibitedExport
);
