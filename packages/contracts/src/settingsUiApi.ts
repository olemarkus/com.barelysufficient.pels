import type { DailyBudgetUiPayload } from './dailyBudgetTypes.js';
import type { ResolvedDeferredObjectiveActivePlansV1 } from './deferredObjectiveActivePlans.js';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from './deferredObjectivePlanHistory.js';
import type { SettingsUiDeviceDiagnosticsPayload } from './deviceDiagnosticsTypes.js';
import type { PowerTrackerState } from './powerTrackerTypes.js';
import type {
  DecoratedDeviceSnapshot,
  EvBoostConfig,
  SettingsUiLogEntry,
  SteppedLoadProfile,
  TemperatureBoostConfig,
} from './types.js';
import type { DeviceOverviewSnapshot, DeviceOverviewStrings } from '../../shared-domain/src/deviceOverview.js';

export const SETTINGS_UI_BOOTSTRAP_PATH = '/ui_bootstrap';
export const SETTINGS_UI_DEVICES_PATH = '/ui_devices';
/**
 * Endpoint backing both whole-home meter pickers. It returns the meters the
 * Homey Energy live report actually exposes (so every listed pick is a reading
 * a selection can resolve) narrowed to actual meters: the whole-home
 * `cumulative` item plus `sensor`-class devices, never appliances. Selecting an
 * appliance would make PELS read one device's draw as whole-home power, so the
 * class narrowing is a safety guard resolved in the producer.
 */
export const HOMEY_ENERGY_METERS_PATH = '/homey_energy_meters';
/** One pickable whole-home meter (id + display name); the producer already narrowed to meters. */
export type HomeyEnergyMeterEntry = { id: string; name: string };
export const SETTINGS_UI_PLAN_PATH = '/ui_plan';
export const SETTINGS_UI_POWER_PATH = '/ui_power';
export const SETTINGS_UI_PRICES_PATH = '/ui_prices';

/**
 * Query parameter naming ONE sub-home on `ui_plan` / `ui_power` / `ui_devices`
 * (multi-home). Absent = the historical whole-home / main-home read, whose URI
 * and payload stay byte-identical: `?homeId=main` is never produced, and the
 * runtime boundary REFUSES it if a client sends it anyway.
 *
 * Runtime mirror: the boundary parser (`setup/settingsUiHomeScope.ts`) reads
 * `query.homeId` as a literal, because `packages/contracts` is types-only at
 * runtime — the sanitize step drops it from the shipped bundle, so a VALUE
 * import from the runtime backend crashes boot. Keep the two in sync.
 */
export const SETTINGS_UI_HOME_ID_QUERY_PARAM = 'homeId';

/**
 * Producer-resolved home scope of a settings-UI read model — the complete
 * classification of a `?homeId=` request, so no consumer re-derives it.
 *
 * ABSENT on an unscoped read: the payload is then byte-identical to the
 * pre-multi-home shape, which is what keeps a single-home install (and every
 * whole-home surface) on exactly the response it has always had.
 *
 * `unavailable` folds every non-serving case the producer knows about — a
 * malformed or refused id, an unknown sub-home, and a home whose runtime is not
 * (or no longer) wired. Render it as "no data for this home"; never substitute
 * another home's values, and never read the flat payload fields as if they were
 * that home's real state (they are the empty shape, not measurements).
 */
export type SettingsUiHomeScope =
  | { readonly state: 'resolved'; readonly homeId: string }
  | { readonly state: 'unavailable' };
export const SETTINGS_UI_REFRESH_DEVICES_PATH = '/ui_refresh_devices';
export const SETTINGS_UI_REFRESH_PRICES_PATH = '/ui_refresh_prices';
export const SETTINGS_UI_REFRESH_GRID_TARIFF_PATH = '/ui_refresh_grid_tariff';
export const SETTINGS_UI_DEVICE_DIAGNOSTICS_PATH = '/ui_device_diagnostics';
export const SETTINGS_UI_DEFERRED_OBJECTIVE_HISTORY_PATH = '/ui_deferred_objective_history';
export const SETTINGS_UI_DEVICE_LOG_PATH = '/ui_device_log';
export const SETTINGS_UI_DEFERRED_OBJECTIVE_SETTINGS_PATH = '/ui_deferred_objective_settings';
export const SETTINGS_UI_LOG_PATH = '/settings_ui_log';
export const SETTINGS_UI_RESET_POWER_STATS_PATH = '/ui_reset_power_stats';
export const SETTINGS_UI_WEATHER_ADVISOR_READOUT_PATH = '/ui_weather_advisor_readout';
export const SETTINGS_UI_RECOMPUTE_DAILY_BUDGET_PATH = '/ui_recompute_daily_budget';
export const SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH = '/ui_preview_daily_budget_model';
export const SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH = '/ui_apply_daily_budget_model';
// Budget-exempt rescue from the overview device card (the bounded "Let it run
// now" path, identical to the starvation_rescue widget's rescue). Devices = the
// gate (which cards may offer the chip); preview = the optional bounded-window
// readout; create = the committed rescue.
export const SETTINGS_UI_STARVATION_RESCUE_DEVICES_PATH = '/ui_starvation_rescue_devices';
export const SETTINGS_UI_STARVATION_RESCUE_PREVIEW_PATH = '/ui_starvation_rescue_preview';
export const SETTINGS_UI_STARVATION_RESCUE_CREATE_PATH = '/ui_starvation_rescue_create';
// Smart-task edit lane from the detail page (edit end time/target + clear).
// Preview = the optional feasibility/cost readout for the edited candidate;
// update = the committed edit (a validated re-create over the same device);
// cancel = clear the task. Shapes live in `smartTaskEdit.ts`.
export const SETTINGS_UI_SMART_TASK_PREVIEW_PATH = '/ui_smart_task_preview';
export const SETTINGS_UI_SMART_TASK_UPDATE_PATH = '/ui_smart_task_update';
export const SETTINGS_UI_SMART_TASK_CANCEL_PATH = '/ui_smart_task_cancel';

// Sentinel prefix the runtime API layer uses when the Homey app shell exists
// but the PELS runtime services have not finished initializing yet (e.g.
// during the boot window after `homey app run` or an app restart). The
// settings UI client matches this prefix to keep callers in a bounded
// loading/retry state instead of surfacing a hard error.
export const SETTINGS_UI_APP_NOT_READY_ERROR_PREFIX = 'PELS_APP_NOT_READY:';

export const SETTINGS_UI_BOOTSTRAP_KEYS = [
  'capacity_limit_kw',
  'capacity_margin_kw',
  'capacity_dry_run',
  'homey_energy_meter_device_id',
  'capacity_priorities',
  'mode_device_targets',
  'operating_mode',
  'controllable_devices',
  'managed_devices',
  'device_control_profiles',
  'device_target_power_configs',
  'budget_exempt_devices',
  'respect_external_off_devices',
  'temperature_boost_settings',
  'native_ev_wiring_devices',
  'device_driver_overrides',
  'mode_aliases',
  'overshoot_behaviors',
  'price_optimization_settings',
  'price_optimization_enabled',
  'price_scheme',
  'norway_price_model',
  'price_area',
  'provider_surcharge',
  'price_threshold_percent',
  'price_min_diff_ore',
  'nettleie_fylke',
  'nettleie_orgnr',
  'nettleie_tariffgruppe',
  'export_price_enabled',
  'export_spot_factor',
  'export_fixed',
  'daily_budget_enabled',
  'daily_budget_kwh',
  'daily_budget_price_shaping_enabled',
  'daily_budget_controlled_weight',
  'daily_budget_price_flex_share',
  'debug_logging_topics',
  'debug_logging_enabled',
  'deferred_objectives',
  'weather_advisor_settings',
] as const;

export type SettingsUiBootstrapKey = (typeof SETTINGS_UI_BOOTSTRAP_KEYS)[number];

export type SettingsUiSettingsPatch = {
  settings: Partial<Record<SettingsUiBootstrapKey, unknown>>;
};

export type SettingsUiBootstrap = SettingsUiSettingsPatch & {
  dailyBudget: DailyBudgetUiPayload | null;
  deferredObjectiveActivePlans: ResolvedDeferredObjectiveActivePlansV1 | null;
  plan: SettingsUiPlanSnapshot | null;
  power: SettingsUiPowerPayload;
  prices: SettingsUiPricesPayload;
};

export type SettingsUiLogRequest = SettingsUiLogEntry;

export type SettingsUiPlanPendingTargetCommand = {
  desired: number;
  retryCount: number;
  nextRetryAtMs: number;
  status: 'waiting_confirmation' | 'temporary_unavailable';
  lastObservedValue?: unknown;
  lastObservedSource?: string;
};

export type SettingsUiPlanStarvationCause = 'capacity' | 'budget';

export type SettingsUiPlanDeviceStarvation = {
  isStarved: boolean;
  accumulatedMs: number;
  cause: SettingsUiPlanStarvationCause;
  startedAtMs: number | null;
};

export type SettingsUiPlanSteppedLoadState = {
  profile: SteppedLoadProfile;
  reportedStepId: string | null;
  targetStepId: string | null;
  commandPending: boolean;
};

export type SettingsUiPlanMetaSnapshot = {
  [key: string]: unknown;
  totalKw?: number | null;
  softLimitKw?: number;
  capacitySoftLimitKw?: number;
  dailySoftLimitKw?: number | null;
  softLimitSource?: 'capacity' | 'daily' | 'both';
  headroomKw?: number;
  powerKnown?: boolean;
  hasLivePowerSample?: boolean;
  powerSampleAgeMs?: number | null;
  powerFreshnessState?: 'fresh' | 'stale_hold' | 'stale_fail_closed';
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  hardCapLimitKw?: number | null;
  hardCapHeadroomKw?: number | null;
  hourlyBudgetExhausted?: boolean;
  usedKWh?: number;
  budgetKWh?: number;
  capacityHourBudgetKWh?: number;
  hourBudgetKWh?: number;
  capacityLimitKw?: number;
  minutesRemaining?: number;
  controlledKw?: number;
  uncontrolledKw?: number;
  hourControlledKWh?: number;
  hourUncontrolledKWh?: number;
  dailyBudgetRemainingKWh?: number;
  dailyBudgetExceeded?: boolean;
  dailyBudgetHourKWh?: number;
  lastPowerUpdateMs?: number;
};

export type SettingsUiPlanDeviceSnapshot = DeviceOverviewSnapshot & {
  [key: string]: unknown;
  id: string;
  name: string;
  deviceClass?: string;
  plannedTarget?: number;
  priority?: number;
  zone?: string;
  budgetExempt?: boolean;
  temperatureBoost?: TemperatureBoostConfig;
  temperatureBoostActive?: boolean;
  // True when a surplus-absorb lift is the binding cause of this device's planned target
  // (raised to self-consume solar). Drives the "Raised to use your solar power" reason line.
  surplusAbsorbActive?: boolean;
  evBoost?: EvBoostConfig;
  evBoostActive?: boolean;
  currentTemperature?: number;
  stateKind?: string;
  stateTone?: string;
  starvation?: SettingsUiPlanDeviceStarvation;
  pendingTargetCommand?: SettingsUiPlanPendingTargetCommand;
  steppedLoad?: SettingsUiPlanSteppedLoadState;
  idleClassification?: 'near_target_idle' | 'unresponsive' | 'capped_idle';
};

export type SettingsUiPlanDevice = SettingsUiPlanDeviceSnapshot;

export type SettingsUiPlanSnapshot = {
  generatedAtMs?: number;
  meta?: SettingsUiPlanMetaSnapshot;
  devices?: SettingsUiPlanDeviceSnapshot[];
};

export type SettingsUiPlanPayload = {
  plan: SettingsUiPlanSnapshot | null;
  // Present only on a `?homeId=` read; absent keeps the whole-home payload
  // byte-identical. `unavailable` means `plan: null` carries NO information
  // about that home — it is the empty shape, not "this home has no plan".
  homeScope?: SettingsUiHomeScope;
};

export type SettingsUiDevicesPayload = {
  // Served from the app-layer DECORATED device list (`latestTargetSnapshot`),
  // so the payload carries the stepped-load step-command/planning decoration
  // the settings-UI reads (`selectedStepId` / `planningPowerKw` / ...). Typed
  // as the decoration carrier rather than the raw transport snapshot.
  // The served objects are the transport-owned snapshots, which physically
  // carry the observed EV plug-state the base type omits (`EvObservedFields`
  // slice). Deliberately NOT probe-widened here: exposing `EvObservedProbe` on
  // the consumer contract would re-permit un-narrowed optional reads across the
  // settings-UI — consumers must narrow through `isEvObserved`. The physical
  // carriage is pinned by the ui_devices payload test instead
  // (`test/integration/settingsUiApi.test.ts`).
  devices: DecoratedDeviceSnapshot[];
  // True when the home has at least one auto-tracked solar/PV device (deviceClass
  // 'solarpanel'). The PV device itself is excluded from `devices` (observe-only), so
  // this home-level flag is the only signal the settings UI has that solar exists — it
  // gates the per-device "Use solar surplus" control, which is otherwise meaningless
  // (and misleading) in a home that does not export.
  // Optional (with hasExhibitedExport below) for one reason: an `unavailable`
  // scoped read OMITS both flags rather than fabricating `false` — absence, not
  // a measurement. Every whole-home and resolved scoped payload carries them.
  hasManagedSolarDevice?: boolean;
  // True when the home has exhibited material accumulated grid export (a stable
  // export-kWh signal), even without a role-detected solar device — the meter-only PV
  // case (string inverter, no Homey solarpanel device). Broadens the "Use solar surplus"
  // toggle gate so such homes, whose surplus-absorb engine already works off whole-home
  // net export, also get the control. Always false on the flow power source.
  hasExhibitedExport?: boolean;
  // Present only on a `?homeId=` read; absent keeps the whole-home payload
  // byte-identical. `unavailable` means the empty `devices: []` is the empty
  // shape, NOT "this home manages nothing" (the two solar flags are then
  // omitted for the same reason).
  homeScope?: SettingsUiHomeScope;
};

export type SettingsUiDeferredObjectivePlanHistoryPayload = {
  version: 1;
  entriesByDeviceId: Record<string, ResolvedDeferredObjectivePlanHistoryEntry[]>;
};

// One recorded device-overview transition. The four message fields ARE the
// shared `DeviceOverviewStrings` the runtime overview logging emits — captured
// verbatim from `formatDeviceOverview`, never re-typed — so the visible
// device-log wording matches the backend transition logs exactly. `stateTone`
// is the same tone token the live device cards use, so the log can colour the
// state line consistently without re-deriving it.
export type SettingsUiDeviceLogEntry = DeviceOverviewStrings & {
  atMs: number;
  stateKind: string;
  stateTone: string;
};

export type SettingsUiDeviceLogPayload = {
  version: 1;
  // Most-recent-first per device. Bounded ring buffer on the runtime side; the
  // UI never assumes a full history.
  entriesByDeviceId: Record<string, SettingsUiDeviceLogEntry[]>;
};

export type SettingsUiPowerStatus = {
  headroomKw?: number;
  lastPowerUpdate?: number | null;
  priceLevel?: string | null;
  powerKnown?: boolean;
  hasLivePowerSample?: boolean;
  powerFreshnessState?: 'fresh' | 'stale_hold' | 'stale_fail_closed';
  capacityShortfall?: boolean;
  shortfallBudgetThresholdKw?: number;
  shortfallBudgetHeadroomKw?: number | null;
  // Instantaneous cap headroom — log/diagnostic parity only. Never derive an
  // over-cap alarm from this (the cap is an hourly-average ceiling); consume
  // the producer-resolved trajectory flag below instead.
  hardCapHeadroomKw?: number | null;
  // Producer-resolved "Above hard cap" trajectory verdict: projected this-hour
  // energy past the cap's hourly kWh (`lib/plan/pelsStatus.ts`).
  projectedOverHardCap?: boolean;
};

export type SettingsUiPowerPayload = {
  tracker: PowerTrackerState | null;
  status: SettingsUiPowerStatus | null;
  heartbeat: number | null;
  // Home-level "this home has solar surfaces" gate for the Usage tab's Solar
  // card (which cannot read the lazy-loaded devices payload). True only when
  // a tracked solar/PV device exists AND the power source is homey_energy —
  // on the flow source the power boundary rejects negative watts and carries
  // no generation field, so solar buckets can never fill and the card must
  // not promise data (see getSettingsUiPower). Optional: realtime status-only
  // pushes don't carry it — consumers treat absence as false and fall back to
  // the recorded solar buckets.
  hasManagedSolarDevice?: boolean;
  // Present only on a `?homeId=` read; absent keeps the whole-home payload
  // byte-identical (realtime pushes never carry it either). `unavailable` means
  // `tracker: null` / `status: null` are the empty shape, NOT a measured idle.
  homeScope?: SettingsUiHomeScope;
};

export type SettingsUiPricesPayload = {
  combinedPrices: unknown | null;
  electricityPrices: unknown | null;
  priceArea: string | null;
  gridTariffData: unknown | null;
  flowToday: unknown | null;
  flowTomorrow: unknown | null;
  homeyCurrency: string | null;
  homeyToday: unknown | null;
  homeyTomorrow: unknown | null;
};

export type SettingsUiDeviceDiagnosticsResponse = SettingsUiDeviceDiagnosticsPayload;

export type SettingsUiResetPowerStatsResponse = {
  power: SettingsUiPowerPayload;
  dailyBudget: DailyBudgetUiPayload | null;
};
