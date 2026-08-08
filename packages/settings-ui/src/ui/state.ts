import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  DeviceTargetPowerConfigs,
  EvBoostConfig,
  EvBoostSettings,
  EvCarAssociations,
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
  temperatureControlDisabledMap: Record<string, boolean>;
  nativeWiringMap: Record<string, boolean>;
  deviceControlProfiles: DeviceControlProfiles;
  deviceTargetPowerConfigs: DeviceTargetPowerConfigs;
  modeAliases: Record<string, string>;
  shedBehaviors: Record<string, ShedBehavior>;
  temperatureBoostSettings: TemperatureBoostSettings;
  evBoostSettings: EvBoostSettings;
  evCarAssociations: EvCarAssociations;
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
  // Home-level: true when the surplus ENGINE can act here — the home has
  // recorded ANY grid export, or its curtailment estimator can contribute (from
  // the `/ui_devices` payload). A strictly WEAKER export bar than
  // `hasExhibitedExport`'s 1 kWh floor; do not collapse the two. Distinct from
  // the two flags above, which
  // also unlock the export-PRICE section and therefore say nothing about the
  // pool. Gates the "Use solar surplus" control on its own, because the runtime
  // declines the posture without it: offering the toggle here would let a user
  // switch on a feature that cannot engage.
  surplusPoolReachable: boolean;
  // Device IDs the overview "Let it run now" rescue chip may offer the action on,
  // resolved server-side (task-free + a known target). The card view gates the
  // chip on membership, which keeps stale affordances rare — but this is a
  // SNAPSHOT: a device can recover, gain a smart task, lose its target, or change
  // home scope between the fetch and the tap, and the create path re-checks live
  // state and may still reject. Empty until the first rescuable-devices fetch.
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
  temperatureControlDisabledMap: {},
  nativeWiringMap: {},
  deviceControlProfiles: {},
  deviceTargetPowerConfigs: {},
  modeAliases: {},
  shedBehaviors: {},
  temperatureBoostSettings: {},
  evBoostSettings: {},
  evCarAssociations: {},
  deferredObjectiveSettings: createEmptyDeferredObjectiveSettings(),
  deferredObjectiveActivePlans: null,
  priceOptimizationSettings: {},
  hasManagedSolarDevice: false,
  hasExhibitedExport: false,
  surplusPoolReachable: false,
  starvationRescuableDeviceIds: new Set<string>(),
  meterAreaSimulation: [],
};

export const resolveManagedState = (deviceId: string): boolean => {
  return state.managedMap[deviceId] === true;
};

// One resolver for "does this device carry a standing smart task right now" —
// previously five hand-copies (Overview card chip, hero, and three Setup-row
// gates) held equal only by comments.
export const hasActiveDeadlineObjective = (deviceId: string, nowMs: number = Date.now()): boolean => {
  const entry = state.deferredObjectiveSettings?.objectivesByDeviceId?.[deviceId];
  if (!entry || !entry.enabled) return false;
  return Number.isFinite(entry.deadlineAtMs) && entry.deadlineAtMs > nowMs;
};

// "This home has solar surfaces at all" — a role-detected solar/PV device OR a
// meter-only PV home that has exhibited material grid export. Neither is gated
// on the power source: both sources report signed net, so a flow home exports on
// the same evidence as a Homey Energy one.
//
// This unlocks the export-PRICE section, whose fixed feed-in amount needs no
// surplus pool. It is NOT the gate for the surplus toggle — see
// `resolveSurplusControlAvailable`.
export const resolveHomeExhibitsSolar = (): boolean => (
  state.hasManagedSolarDevice || state.hasExhibitedExport
);

// The per-device "Use solar surplus" control, which needs a pool the engine can
// actually allocate from — a strictly narrower question than having solar.
// Kept separate rather than folded into the flag above because the two diverge
// on a real home: a flow install whose Flow predates signed watts has a solar
// device and can price its export, yet its net never goes negative, so no
// surplus can ever arrive.
//
// The two modalities behind this one control fail differently, and only one is
// dangerous. A BINARY dump load stamped `surplusOnly` on an unreachable pool is
// held OFF forever, so the runtime declines that stamp outright. A TEMPERATURE
// device's lift is not gated in the runtime at all — it simply never engages,
// because engaging needs surplus. So this flag is a correctness gate for the
// first and an honesty gate for the second: do not offer a switch that cannot
// do anything. Both keep an opted-in escape hatch so a setting stored before
// the gate existed stays visible and clearable.
export const resolveSurplusControlAvailable = (): boolean => (
  state.surplusPoolReachable
);
