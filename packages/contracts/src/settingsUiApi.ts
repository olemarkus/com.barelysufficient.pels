import type { DailyBudgetUiPayload } from './dailyBudgetTypes.js';
import type { ResolvedDeferredObjectiveActivePlansV1 } from './deferredObjectiveActivePlans.js';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from './deferredObjectivePlanHistory.js';
import type { SettingsUiDeviceDiagnosticsPayload } from './deviceDiagnosticsTypes.js';
import type { PowerTrackerState } from './powerTrackerTypes.js';
import type {
  DecoratedDeviceSnapshot,
  EvChargingState,
  SettingsUiLogEntry,
} from './types.js';
import type {
  DeviceOverviewSnapshot,
  DeviceOverviewSteppedLoad,
  DeviceOverviewStrings,
} from '../../shared-domain/src/deviceOverview.js';

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
  'temperature_control_disabled_devices',
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

// One starved state, no cause bucket. The flat `capacity | budget` split was
// removed 2026-08-04: it was a momentary snapshot of whichever constraint bound
// on the last accumulation tick, so it flipped mid-hold, and every surface that
// branched on it (badge, widget chip, row copy, and the rescue gate) flipped with
// it. The granular `DeviceDiagnosticsStarvationCountingCause` — which does carry
// real diagnostic value — is unaffected and still reaches device detail and the
// `device_starvation_*` logs.
// `startedAtMs` was removed 2026-08-07: nothing in `lib/`, `setup/` or
// `packages/` ever read it. The surfaces that show a hold's age render
// `accumulatedMs` (the time actually spent starved), which is not the same
// quantity — an episode start says nothing about how much of it counted.
export type SettingsUiPlanDeviceStarvation = {
  isStarved: boolean;
  accumulatedMs: number;
};

// The stepped cluster is declared in shared-domain, on `DeviceOverviewSnapshot`
// itself, because it is that shape's stepped DISCRIMINANT (presence = stepped).
// Aliased here so the settings-UI keeps its familiar name. It cannot be defined
// in this file: `settingsUiApi` imports `DeviceOverviewSnapshot` from
// shared-domain, so the dependency only runs one way.
export type SettingsUiPlanSteppedLoadState = DeviceOverviewSteppedLoad;

/**
 * NO `[key: string]: unknown` index signature — same reasoning as
 * `SettingsUiPlanDeviceSnapshot` below, which carries the full rationale. This
 * shape lost several fixture-only fields (`hardLimitKw`, a duplicate of
 * `hardCapLimitKw`; `powerKnown`) that only compiled because the signature
 * accepted anything.
 */
export type SettingsUiPlanMetaSnapshot = {
  /**
   * `null` = no meter reading this cycle. Required-but-nullable: the capacity
   * guard holds `null` until its meter's first sample and again after an
   * in-place meter swap, so absence is real — but "the producer did not send
   * it" is not a state a consumer should have to tell apart from it.
   */
  totalKw: number | null;
  softLimitKw: number;
  capacitySoftLimitKw: number;
  /** `null` = no daily budget axis this cycle. Always emitted. */
  budgetPaceKw: number | null;
  projectedExemptKw: number | null;
  softLimitSource: 'capacity' | 'daily';
  headroomKw: number;
  powerFreshnessState: 'fresh' | 'stale_hold' | 'stale_fail_closed';
  /** From `capacitySettings.limitKw` — a plain number, never absent or null. */
  hardCapLimitKw: number;
  usedKWh: number;
  hourBudgetKWh: number;
  minutesRemaining: number;
  /**
   * The managed side always resolves; the background side is the whole-home
   * total minus it, so it is `null` exactly when there is no reading. The
   * asymmetry is `splitControlledUsageKw`'s, stated in its own comment — it is
   * not two spellings of the same absence.
   */
  controlledKw: number;
  uncontrolledKw: number | null;
  /** Genuinely absent until the hour has bucket data. */
  hourControlledKWh?: number;
  hourUncontrolledKWh?: number;
  /** Genuinely absent before the power tracker's first timestamp. */
  lastPowerUpdateMs?: number;
};

/**
 * NO `[key: string]: unknown` index signature, deliberately. It used to carry
 * one, and that made every field removal on this wire type unenforceable: a
 * consumer kept compiling against a field the producer no longer emits, so a
 * dead read survived a passing typecheck (the atomic-temperature-facet
 * migration left exactly such a read behind in `PlanOverview.tsx`). It also hid
 * the reverse — `carChargingState` travelled on the wire and was READ by the
 * EV card text while this contract never declared it. Every field the producer
 * emits is declared here; a new one is a deliberate edit, not an accident.
 */
export type SettingsUiPlanDeviceSnapshot = DeviceOverviewSnapshot & {
  id: string;
  name: string;
  deviceClass?: string;
  budgetExempt?: boolean;
  /**
   * The device's one boost decision, as the planner made it
   * (`resolveBoostActive`, `lib/plan/planBoost.ts`). There is no kind behind it
   * and no per-axis pair on this wire: a tank's temperature and a car's battery
   * percentage are the same quantity in different units, so "which axis" is not
   * a question the plan can answer or the snapshot should carry. The card's
   * hover wording is the view's to choose, from the device facets beside this
   * field.
   *
   * REQUIRED, like `controllable` and `available` beside it and for the same
   * reason: the producer writes it for every device, so an absent value would be
   * a third state on the wire for a two-state fact, and every consumer would pay
   * for it with the same `=== true` collapse.
   *
   * Deliberately NOT added to `isPlanDeviceSnapshot`, unlike those two. That
   * guard rejects the WHOLE snapshot when any single device fails it
   * (`parsePlanSnapshot` returns `null`), which is the right severity for facts
   * the UI cannot describe PELS's behaviour without — and far too blunt for a
   * status chip. A payload missing this should cost one absent chip, not every
   * device card on the Overview.
   */
  boostActive: boolean;
  // True when a surplus-absorb lift is the binding cause of this device's planned target
  // (raised to self-consume solar). Drives the "Raised to use your solar power" reason line.
  surplusAbsorbActive?: boolean;
  /**
   * The charging state of the CAR associated with this charger (distinct from
   * the charger's own `evChargingState` on `DeviceOverviewSnapshot`). Read by
   * the stepped/EV card text to say what the car is doing rather than only what
   * PELS commanded.
   */
  carChargingState?: EvChargingState;
  stateKind?: string;
  stateTone?: string;
  starvation?: SettingsUiPlanDeviceStarvation;
  pendingTargetCommand?: SettingsUiPlanPendingTargetCommand;
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
  // net export, also get the control. Source-blind: both power sources report signed net,
  // so a flow home exhibits export on exactly the same evidence as a Homey Energy one.
  hasExhibitedExport?: boolean;
  // True when this home's solar-surplus pool can EVER be non-zero — it has
  // recorded ANY grid export, or its curtailment estimator can contribute
  // (`resolveSurplusPoolReachable`). Gates the per-device "Use solar surplus"
  // toggle, which is not merely inert without it: the runtime declines to stamp
  // the posture on an unreachable pool (else the standing hold keeps the device
  // OFF forever), so a toggle offered here would switch on and do nothing.
  //
  // Its export bar is strictly WEAKER than `hasExhibitedExport`'s 1 kWh
  // materiality floor, and deliberately so: the question is whether the feed can
  // express export at all, which one negative sample settles. Do not collapse
  // the two flags together — the floor would black this out for the first ~20
  // minutes of a home's first sunny afternoon.
  //
  // Distinct from the two flags above, and all three are needed. Solar presence
  // and export history unlock the export-PRICE section, which needs no pool at
  // all; only this one says the surplus ENGINE can act. A flow home whose Flow
  // predates signed watts has solar, no export, and no reachable pool.
  //
  // Optional for the same reason as its neighbours: an `unavailable` scoped read
  // omits it rather than fabricating `false`.
  surplusPoolReachable?: boolean;
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
  powerNowKw?: number | null;
  /** Back-compat for external `pels_status` readers; derived from `powerNowKw`. */
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

/**
 * Why a power-status read carries no live status. Every arm is one specific,
 * producer- or seam-owned cause — no catch-all:
 *
 * - `no_measurement` — the home's measurement gate is shut: its live tracker
 *   holds no measurement latch for this home's meter (first-ever boot, an
 *   in-place meter swap cleared it, or a corrupt tracker restore). The latch
 *   is durable on purpose: an ordinary restart of an ever-measured home
 *   restores it (the planner's restored-sample policy) and stays `live`,
 *   with the running planner rewriting the blob promptly. When this arm DOES
 *   resolve, any persisted `pels_status` blob describes a previous era and
 *   must not be served as live — the blob itself is preserved untouched
 *   (`setup/powerMeasurementGate.ts`).
 * - `no_status_recorded` — a measurement exists but no parsable `pels_status`
 *   blob has been committed yet (first plan not yet written).
 * - `home_scope_unavailable` — the `?homeId=` read could not be served; the
 *   payload is the empty shape and its `homeScope` block says the same.
 * - `read_failed` — the WebView-side transport adapter could not obtain or
 *   validate a payload at all (the Homey API bridge is an untrusted transport;
 *   the client classifies its own failed read once, at that seam).
 */
export type SettingsUiPowerStatusUnavailableReason =
  | 'no_measurement'
  | 'no_status_recorded'
  | 'home_scope_unavailable'
  | 'read_failed';

/**
 * The classified result of reading the home's `pels_status`. The producer
 * (`getSettingsUiPower` / `powerPayloadForHome`, setup/settingsUiApi.ts)
 * resolves it at the read boundary: `live` means the running planner vouches
 * for the blob (the home's measurement gate is open, so the blob is maintained
 * by THIS run); `unavailable` means no live status claim exists and the reason
 * arm says exactly why. Consumers branch on `state` and never re-derive
 * liveness from blob fields such as `powerFreshnessState`.
 */
export type SettingsUiPowerStatusRead =
  | { readonly state: 'live'; readonly status: SettingsUiPowerStatus }
  | { readonly state: 'unavailable'; readonly reason: SettingsUiPowerStatusUnavailableReason };

export type SettingsUiPowerPayload = {
  tracker: PowerTrackerState | null;
  status: SettingsUiPowerStatusRead;
  heartbeat: number | null;
  // Runtime-authoritative Main-home simulation posture. The persisted
  // `capacity_dry_run` key may be absent while the running app deliberately
  // retains its last-good value, so a freshly opened WebView must not infer a
  // boot default from settings absence. Present only on whole-home reads;
  // scoped reads get their effective posture from the scoped status blob.
  mainDryRunEffective?: boolean;
  // Runtime-authoritative Main-home capacity scalars. Like dry-run above, the
  // running adapter retains these values when a persisted key is absent or
  // malformed; a WebView reload must render and preserve the same values.
  mainCapacityScalars?: {
    limitKw: number;
    marginKw: number;
  };
  // Home-level "this home has PRODUCTION surfaces" gate for the Usage tab's
  // Solar card (which cannot read the lazy-loaded devices payload). True only
  // when a tracked solar/PV device exists AND the active source delivers a
  // production reading (`deliversProductionSignal`) — without one the
  // generation buckets can never fill and the card must not promise data (see
  // getSettingsUiPower). EXPORT is a separate axis and is not gated by this
  // flag. Optional: realtime status-only pushes don't carry it — consumers
  // treat absence as false and fall back to the recorded solar buckets.
  hasManagedSolarDevice?: boolean;
  // Present only on a `?homeId=` read; absent keeps the whole-home payload
  // byte-identical (realtime pushes never carry it either). `unavailable` means
  // `tracker: null` / the unavailable status arm are the empty shape, NOT a
  // measured idle.
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
