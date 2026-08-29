import type Homey from 'homey';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetModelSettings,
  DailyBudgetUiPayload,
} from '../packages/contracts/src/dailyBudgetTypes';
import type {
  ResolvedDeferredObjectiveActivePlansV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';
import type { PowerTrackerState } from '../packages/contracts/src/powerTrackerTypes';
import { hasMaterialExhibitedExport } from '../packages/shared-domain/src/solar/exhibitedExport';
import { resolveSurplusPoolReachable } from '../packages/shared-domain/src/solar/surplusPoolReachable';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../lib/utils/settingsUiBootstrapKeys';
import { DEFERRED_OBJECTIVES_SETTINGS, POWER_TRACKER_STATE } from '../lib/utils/settingsKeys';
import {
  SettingsUiHomeScopeAdapter,
  type ResolvedSubHomeScope,
} from './settingsUiHomeScope';
import { readAllObjectives } from '../lib/objectives/deferredObjectives/objectiveStore';
import type { DeferredObjectiveSettingsV1 } from '../lib/objectives/deferredObjectives/settings';
import type {
  SettingsUiBootstrap,
  SettingsUiDeferredObjectivePlanHistoryPayload,
  SettingsUiDeviceDiagnosticsResponse,
  SettingsUiDeviceLogPayload,
  SettingsUiDevicesPayload,
  SettingsUiLogRequest,
  SettingsUiPlanPayload,
  SettingsUiPlanSnapshot,
  SettingsUiPowerPayload,
  SettingsUiPowerStatusRead,
  SettingsUiPricesPayload,
  SettingsUiResetPowerStatsResponse,
} from '../packages/contracts/src/settingsUiApi';
import type {
  DecoratedDeviceSnapshot,
  ProjectedObservedDeviceState,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import { isObserveOnlyRoleClassKey } from '../lib/device/transport/managerHelpers';
import { hasSolarProductionCandidate } from '../lib/device/solarPresence';
import { hasPowerMeasurement } from '../lib/power/lastTotalPower';
import type { WeatherAdvisorReadoutPayload } from '../packages/contracts/src/weatherAdvisorTypes';
import {
  asPowerStatusBlobRead,
  classifyPowerStatusRead,
  type PowerMeasurementEvidence,
  getAssociatedCarForUiFromApp,
  getLatestDevicesForUiFromApp,
  getModeCatalogForUiFromApp,
  getObservedStateForUiFromApp,
  getPlanSnapshotForUiFromHomey,
  getCurtailmentCanContributeForUiFromApp,
  getPowerTrackerForUiFromApp,
  getUiPickerDevicesFromApp,
  refreshSettingsUiDevicesForApp,
  refreshSettingsUiGridTariffForApp,
  refreshSettingsUiPricesForApp,
  resetSettingsUiPowerStatsForApp,
} from './settingsUiAppRuntime';
import { rankModeDevices } from '../packages/shared-domain/src/modeCatalogResolution';

type SettingsUiApiApp = Homey.App & {
  capacityDryRun?: unknown;
  capacitySettings?: unknown;
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
  previewDailyBudgetModel?: (settings: Partial<DailyBudgetModelSettings>) => DailyBudgetModelPreviewResponse;
  applyDailyBudgetModel?: (settings: Partial<DailyBudgetModelSettings>) => DailyBudgetUiPayload | null;
  getDeviceDiagnosticsUiPayload?: () => SettingsUiDeviceDiagnosticsResponse;
  getDeviceLogUiPayload?: () => SettingsUiDeviceLogPayload;
  getDeferredObjectivePlanHistoryUiPayload?: () => SettingsUiDeferredObjectivePlanHistoryPayload;
  getDeferredObjectiveActivePlansUiPayload?: () => ResolvedDeferredObjectiveActivePlansV1 | null;
  getWeatherAdvisorReadout?: () => Promise<WeatherAdvisorReadoutPayload | null>;
};

type ApiContext = {
  homey: Homey.App['homey'];
};

/**
 * The three read endpoints that accept an optional `?homeId=`. `query` is the
 * raw inbound bag; `settingsUiHomeScope` owns its complete classification.
 * Optional so every in-process caller (bootstrap, refresh endpoints, tests)
 * keeps the whole-home behaviour without naming it.
 */
type HomeScopedApiContext = ApiContext & { query?: unknown };

const getApp = (homey: Homey.App['homey']): SettingsUiApiApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app;
};

const pickSettings = (
  homey: Homey.App['homey'],
  keys: readonly string[],
): Record<string, unknown> => Object.fromEntries(
  keys.map((key) => [key, homey.settings.get(key) as unknown]),
);

const formatSettingsUiMessage = (entry: SettingsUiLogRequest) => {
  const context = entry.context ? ` (${entry.context})` : '';
  const detail = entry.detail ? ` - ${entry.detail}` : '';
  return `Settings UI${context}: ${entry.message}${detail}`;
};

const isValidLogRequest = (value: unknown): value is SettingsUiLogRequest => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SettingsUiLogRequest>;
  return typeof entry.level === 'string' && typeof entry.message === 'string';
};

const asDailyBudgetModelSettings = (value: unknown): Partial<DailyBudgetModelSettings> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const body = value as Partial<DailyBudgetModelSettings>;
  return {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    dailyBudgetKWh: typeof body.dailyBudgetKWh === 'number' && Number.isFinite(body.dailyBudgetKWh)
      ? body.dailyBudgetKWh
      : undefined,
    priceShapingEnabled: typeof body.priceShapingEnabled === 'boolean' ? body.priceShapingEnabled : undefined,
    controlledUsageWeight: typeof body.controlledUsageWeight === 'number' && Number.isFinite(body.controlledUsageWeight)
      ? body.controlledUsageWeight
      : undefined,
    priceShapingFlexShare: typeof body.priceShapingFlexShare === 'number' && Number.isFinite(body.priceShapingFlexShare)
      ? body.priceShapingFlexShare
      : undefined,
  };
};

// The raw candidate list BEFORE the observe-only filter: the force-managed snapshot
// (`latestTargetSnapshot`) plus the unmanaged-but-eligible picker devices. Auto-tracked
// observe-only role devices (home batteries → 'battery', PV → 'solarpanel') ride the
// managed half here; callers decide whether to expose or merely detect them.
const getRawSettingsUiDeviceCandidates = ({ homey }: ApiContext): DecoratedDeviceSnapshot[] => {
  const managed = getLatestDevicesForUiFromApp(homey) ?? [];
  const unmanagedEligible = getUiPickerDevicesFromApp(homey);
  return withResolvedPriorities(
    homey,
    withLiveObservedState(homey, withAssociatedCars(homey, [...managed, ...unmanagedEligible])),
  );
};

/**
 * Stamp each device's rank through the mode catalog owner.
 *
 * Priority is a property of a SET, not of a device: it is meaningful only
 * relative to the other devices being ranked. The transport used to stamp it
 * per device while parsing, where no set exists, so its only possible answer for
 * a device nobody had ranked was a shared default — and with nothing configured
 * every device carried the same number, leaving the Overview's order to fall out
 * of the snapshot array. Resolving here, over the set this payload is about,
 * gives the strict 1..N the owner guarantees.
 */
const withResolvedPriorities = (
  homey: Homey.App['homey'],
  devices: DecoratedDeviceSnapshot[],
): DecoratedDeviceSnapshot[] => {
  const catalog = getModeCatalogForUiFromApp(homey);
  const ranks = rankModeDevices(
    devices.map((device) => device.id),
    (deviceId) => catalog.priorities[catalog.operatingMode]?.[deviceId],
  );
  return devices.map((device) => ({ ...device, priority: ranks[device.id] }));
};

/**
 * The observed fields `/ui_devices` refreshes from the observer projection.
 *
 * An explicit list, not a spread of the whole projection, because the payload
 * is the DECORATED snapshot and two of the projection's fields are decoration
 * outputs rather than raw observations:
 *
 * - `binaryControl` — `decorateSnapshotWithDeviceControl` RESOLVES it from the
 *   selected rung for a STEPPED LOAD (`resolveSteppedLoadCurrentOn`). A stepped
 *   device whose raw on/off axis is on while its resolved rung is the off step
 *   is correctly `{ on: false }` after decoration; overlaying the raw value
 *   would put the resolved answer back to the un-resolved one. That is the only
 *   branch that resolves it, so for every OTHER device the stored value is the
 *   same raw observation the projection holds, only older — and the principal
 *   on/off axis is exactly what this seam exists to keep current. Hence the
 *   per-device list below rather than a blanket exclusion.
 * - `reportedStepId` — the decorator normalizes it for a stepped load and
 *   clears it outright for a temperature-control-disabled device, which is
 *   `binary_power` by then. Both branches own it, so it is never refreshed.
 *
 * `id` and `name` are the join keys and are the descriptor's, not an
 * observation; they are never overlaid.
 *
 * Keeping this a list rather than an exclusion set is the point: a field is
 * refreshed only once someone has decided it is raw-observed, so a decoration
 * added later cannot be silently clobbered by this seam.
 */
const LIVE_OBSERVED_FIELDS = [
  'available',
  'targets',
  'binaryControlObservation',
  'measuredPowerKw',
  'measuredPowerObservedAtMs',
  'temperature',
  'stateOfCharge',
  'evCharging',
  'evChargingObservedAtMs',
  'evChargingState',
  'lastFreshDataMs',
  'lastLocalWriteMs',
  'lastUpdated',
] as const satisfies readonly (keyof ProjectedObservedDeviceState)[];

/**
 * Refreshes each device's observed state from the observer projection that owns
 * it.
 *
 * Same read-time treatment, and the same reason, as `withAssociatedCars` below:
 * `latestTargetSnapshot` is rebuilt on `SNAPSHOT_REFRESH_MINUTE_INTERVALS`
 * (:25/:55), so the observed values it carries are up to half an hour old while
 * the settings UI re-reads this payload continuously.
 *
 * Two absences are deliberately no-ops rather than writes, because neither is a
 * reading PELS took:
 *
 * - a device with no projection entry keeps its stored snapshot. For a managed
 *   device that means "not observed yet" (boot). It is also the permanent state
 *   of an unmanaged PICKER device: the projection is fed from the committed
 *   runtime snapshot, which drops unmanaged devices, so picker rows are served
 *   from their cached parse and are NOT refreshed here. See `TODO.md`.
 * - a field the projection does not carry keeps its stored value, rather than
 *   being blanked to `undefined`.
 */
const withLiveObservedState = (
  homey: ApiContext['homey'],
  devices: DecoratedDeviceSnapshot[],
): DecoratedDeviceSnapshot[] => devices.map((device) => {
  const observed = getObservedStateForUiFromApp(homey, device.id);
  return observed
    ? { ...device, ...pickLiveObservedFields(observed, resolveLiveObservedFields(device)) }
    : device;
});

// The stepped branch of the decorator is the only one that resolves
// `binaryControl`, and it is the only branch that stamps this control model —
// so this is the exact condition under which the stored value is a decision
// rather than an observation.
const resolveLiveObservedFields = (
  device: DecoratedDeviceSnapshot,
): readonly (keyof ProjectedObservedDeviceState)[] => (
  device.controlModel === 'stepped_load'
    ? LIVE_OBSERVED_FIELDS
    : [...LIVE_OBSERVED_FIELDS, 'binaryControl']
);

// The listed fields the projection actually carries, as a patch. A field the
// projection omits is left out rather than written as `undefined`, so the
// stored value carries forward instead of being blanked.
const pickLiveObservedFields = (
  observed: ProjectedObservedDeviceState,
  fields: readonly (keyof ProjectedObservedDeviceState)[],
): Partial<DecoratedDeviceSnapshot> => Object.fromEntries(
  fields
    .filter((field) => observed[field] !== undefined)
    .map((field) => [field, observed[field]]),
);

/**
 * Decorates each device with the car associated with it right now, resolved from
 * live probe state at READ time.
 *
 * Deliberately not a transport snapshot field: the association changes on the
 * realtime feed within seconds of a plug edge, while snapshots are rebuilt only
 * at :25/:55 and are replaced wholesale by every device re-parse — so a stored
 * copy would be absent most of the time and up to half an hour stale after
 * unplugging. `getAssociatedCar` answers `undefined` for every device that is
 * not a charger with both an eligibility set and a live session.
 */
const withAssociatedCars = (
  homey: ApiContext['homey'],
  devices: TargetDeviceSnapshot[],
): DecoratedDeviceSnapshot[] => devices.map((device) => {
  const associatedCar = getAssociatedCarForUiFromApp(homey, device.id);
  return associatedCar ? { ...device, associatedCar } : device;
});

const getSettingsUiPlan = ({ homey }: ApiContext): SettingsUiPlanSnapshot | null => (
  getPlanSnapshotForUiFromHomey(homey)
);

const resolveMainCapacityScalars = (
  value: unknown,
): SettingsUiPowerPayload['mainCapacityScalars'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { limitKw, marginKw } = value as { limitKw?: unknown; marginKw?: unknown };
  if (typeof limitKw !== 'number' || !Number.isFinite(limitKw)) return undefined;
  if (typeof marginKw !== 'number' || !Number.isFinite(marginKw)) return undefined;
  return { limitKw, marginKw };
};

/**
 * The pull composers' evidence, from the same predicate the home's plan-build
 * gate asks of the same live tracker (`PowerMeasurementGate.isOpen` ⇔
 * `hasPowerMeasurement(getPowerTracker())`): a latch is what makes the stored
 * blob a live claim. A home whose gate is shut builds no plan, so nothing this
 * run rewrites the persisted blob — serving it as live would show the PREVIOUS
 * run's watts and available power labelled `'fresh'` for as long as the home
 * stays unmeasured. The gate's refusal is correct and the blob is deliberately
 * PRESERVED; only what this read CLAIMS about it changes. One classifier for
 * every producer — both composers here and the realtime push
 * (`classifyPowerStatusRead`, setup/settingsUiAppRuntime.ts).
 */
const latchEvidence = (measured: boolean): PowerMeasurementEvidence => (
  measured ? { state: 'latched' } : { state: 'none' }
);

/**
 * The whole-home classification asks the LIVE tracker, never the persisted
 * `POWER_TRACKER_STATE` fallback. The live latch is itself restored across an
 * ordinary restart (`loadPowerTracker`) — that is the planner's own
 * restored-sample policy, and the open gate then rewrites the blob promptly.
 * What this classification closes is the truly gated home: first-ever boot,
 * post-meter-swap, or a corrupt tracker restore, where nothing this run will
 * vouch for the stored blob.
 */
const classifyMainPowerStatus = (homey: ApiContext['homey']): SettingsUiPowerStatusRead => {
  const liveTracker = getPowerTrackerForUiFromApp(homey);
  return classifyPowerStatusRead(
    latchEvidence(liveTracker !== null && hasPowerMeasurement(liveTracker)),
    asPowerStatusBlobRead(homey.settings.get('pels_status')),
  );
};

const getSettingsUiPower = ({ homey }: ApiContext): SettingsUiPowerPayload => {
  const app = getApp(homey);
  const mainCapacityScalars = resolveMainCapacityScalars(app?.capacitySettings);
  // The tracker keeps the persisted fallback: it carries usage HISTORY
  // (buckets, daily totals, solar families) whose consumers age it themselves
  // (stale-data banner, solar-now staleness gate). Liveness claims ride the
  // classified `status` read only.
  const tracker = getPowerTrackerForUiFromApp(homey)
    ?? (homey.settings.get(POWER_TRACKER_STATE) as PowerTrackerState | null);
  return {
    tracker: tracker && typeof tracker === 'object' ? tracker : null,
    status: classifyMainPowerStatus(homey),
    heartbeat: null,
    ...(typeof app?.capacityDryRun === 'boolean'
      ? { mainDryRunEffective: app.capacityDryRun }
      : {}),
    ...(mainCapacityScalars ? { mainCapacityScalars } : {}),
    // Home-level "this home has PRODUCTION surfaces" gate for the Usage tab's
    // Solar card (the device list is lazy-loaded, so the card can't read the
    // ui_devices flag). A role-detected PV device is now the whole condition:
    // production is read from the Homey Energy report on BOTH power sources —
    // directly on the homey_energy poll, and via the companion poll on flow — so
    // there is no longer a configuration in which a solar home's generation
    // buckets can never fill.
    //
    // Gated on the TRACKED devices only, deliberately: that is the same set the
    // generation poll gates its SDK call on (`createGenerationPollSource`), so
    // this flag can never promise a card whose buckets nothing will fill. The
    // ui_devices flag below keeps the wider picker-inclusive set — it unlocks
    // the export-price section, which needs no production reading at all.
    hasManagedSolarDevice: hasSolarProductionCandidate(getLatestDevicesForUiFromApp(homey) ?? []),
  };
};

const getSettingsUiPrices = ({ homey }: ApiContext): SettingsUiPricesPayload => {
  const priceArea = homey.settings.get('price_area') as unknown;
  const homeyCurrency = homey.settings.get('homey_prices_currency') as unknown;
  // The settings-UI client (`deadlinePlanData.getCombinedPrices`) accepts
  // both the legacy V1 `{ prices: [...] }` and V2 `{ days: {...} }` shapes,
  // so the raw persisted value is forwarded as-is. A first read through the
  // combined-prices reader (daily-budget service, plan service) migrates V1 to
  // V2 in place; later bootstrap calls then see V2 here.
  return {
    combinedPrices: homey.settings.get('combined_prices') as unknown ?? null,
    electricityPrices: homey.settings.get('electricity_prices') as unknown ?? null,
    priceArea: typeof priceArea === 'string' ? priceArea : null,
    gridTariffData: homey.settings.get('nettleie_data') as unknown ?? null,
    flowToday: homey.settings.get('flow_prices_today') as unknown ?? null,
    flowTomorrow: homey.settings.get('flow_prices_tomorrow') as unknown ?? null,
    homeyCurrency: typeof homeyCurrency === 'string' ? homeyCurrency : null,
    homeyToday: homey.settings.get('homey_prices_today') as unknown ?? null,
    homeyTomorrow: homey.settings.get('homey_prices_tomorrow') as unknown ?? null,
  };
};

const buildEmptyDeviceDiagnosticsPayload = (): SettingsUiDeviceDiagnosticsResponse => ({
  generatedAt: Date.now(),
  windowDays: 21,
  diagnosticsByDeviceId: {},
});

export const buildSettingsUiBootstrap = async ({ homey }: ApiContext): Promise<SettingsUiBootstrap> => {
  const app = getApp(homey);
  return {
    settings: {
      ...pickSettings(homey, SETTINGS_UI_BOOTSTRAP_KEYS),
      // Objectives now live in per-device keys, so the raw `deferred_objectives`
      // blob `pickSettings` reads above is no longer authoritative (the boot
      // migration consumes it). Serve the assembled V1 map under the same key:
      // the deadline views read `bootstrap.settings.deferred_objectives`, and
      // `applySettingsPatch` primes the settings cache that
      // `loadDeferredObjectiveSettings`'s `getSetting` then hits — so this one
      // override fixes both UI read paths without a separate endpoint.
      [DEFERRED_OBJECTIVES_SETTINGS]: readAllObjectives(homey.settings),
    },
    dailyBudget: app?.getDailyBudgetUiPayload?.() ?? null,
    deferredObjectiveActivePlans: app?.getDeferredObjectiveActivePlansUiPayload?.() ?? null,
    plan: getSettingsUiPlan({ homey }),
    power: getSettingsUiPower({ homey }),
    prices: getSettingsUiPrices({ homey }),
  };
};

// Whether this home has solar surfaces, from ITS candidate list. Shared by the
// whole-home and per-home composers so the two can never diverge; the two
// endpoints keep their historical source gating (ui_power gates on
// homey_energy, ui_devices deliberately does not — see each field's contract).
// ── `?homeId=` composers ────────────────────────────────────────────────────
// Each returns the empty shape plus an `unavailable` scope when the sub-home
// cannot be served, so a consumer can never mistake the emptiness for a
// measurement — the solar flags are OMITTED there, never fabricated `false`.
// Values come from the read port + that home's own suffixed `pels_status`;
// nothing here rebuilds, refreshes or actuates. The helpers accept only a
// parser-resolved scope, so no untrusted string can reach them.

const UNAVAILABLE_PLAN_PAYLOAD: SettingsUiPlanPayload = {
  plan: null, homeScope: { state: 'unavailable' },
};
const UNAVAILABLE_POWER_PAYLOAD: SettingsUiPowerPayload = {
  tracker: null,
  status: { state: 'unavailable', reason: 'home_scope_unavailable' },
  heartbeat: null,
  homeScope: { state: 'unavailable' },
};
const UNAVAILABLE_DEVICES_PAYLOAD: SettingsUiDevicesPayload = {
  devices: [], homeScope: { state: 'unavailable' },
};

const planPayloadForHome = (
  homey: Homey.App['homey'],
  scope: ResolvedSubHomeScope,
): SettingsUiPlanPayload => {
  const reading = new SettingsUiHomeScopeAdapter(homey).readRuntime(scope);
  if (!reading) return UNAVAILABLE_PLAN_PAYLOAD;
  return { plan: reading.plan, homeScope: { state: 'resolved', homeId: scope.homeId } };
};

const powerPayloadForHome = (
  homey: Homey.App['homey'],
  scope: ResolvedSubHomeScope,
): SettingsUiPowerPayload => {
  const homeScope = new SettingsUiHomeScopeAdapter(homey);
  const reading = homeScope.readRuntime(scope);
  if (!reading) return UNAVAILABLE_POWER_PAYLOAD;
  // Unwired or provisional membership refuses the WHOLE payload, exactly as
  // the devices composer does, so `homeScope: resolved` always means every
  // field is this home's truth — an absent solar flag never has to carry a
  // second meaning (the contract's documented absence case is the realtime
  // status-only push).
  const members = homeScope.filterDevicesForHome(scope, getRawSettingsUiDeviceCandidates({ homey }));
  if (members === null) return UNAVAILABLE_POWER_PAYLOAD;
  // A thrown status read (transient Homey store failure) is unavailable too:
  // it is not "no status committed yet", and a resolved payload built from it
  // could be cached for the session.
  const statusRead = homeScope.readStatus(scope);
  if (statusRead.state === 'unavailable') return UNAVAILABLE_POWER_PAYLOAD;
  // No `power_source` read here any more: with production reaching both sources,
  // nothing in this payload depends on which one is configured, so reading it
  // purely to classify its failure would fence a home out of its own payload
  // over a setting the payload does not use.
  //
  // Same read-boundary classification as the whole-home composer, against this
  // home's OWN live tracker — the identical predicate its bundle's plan-build
  // gate asks (`createPlanService` wires the gate per scope). A gated sub-home
  // (its area meter never reported this run) keeps its suffixed blob but is
  // never served it as live. The thrown-read arm was refused above, so only
  // `resolved`/`absent` reach the classifier.
  return {
    tracker: reading.powerTracker,
    status: classifyPowerStatusRead(latchEvidence(hasPowerMeasurement(reading.powerTracker)), statusRead),
    heartbeat: null,
    // Always false when scoped to a SUB-HOME, even when that home owns a solar
    // device. The flag promises production DATA, not the presence of a panel,
    // and a sub-home's `generationBuckets` can never fill: its bundle is built
    // deliberately without the PV/curtailment taps and without an
    // `observedHomePower` to co-sample from (`createHomeCapacityBundle.ts`),
    // because a sub-home meter's net W is not the home's grid power. Reporting
    // true here would show a Solar card that stays permanently at zero.
    hasManagedSolarDevice: false,
    homeScope: { state: 'resolved', homeId: scope.homeId },
  };
};

const devicesPayloadForHome = (
  homey: Homey.App['homey'],
  scope: ResolvedSubHomeScope,
): SettingsUiDevicesPayload => {
  const homeScope = new SettingsUiHomeScopeAdapter(homey);
  const reading = homeScope.readRuntime(scope);
  if (reading === null) return UNAVAILABLE_DEVICES_PAYLOAD;
  // Device→home attribution is what makes a per-home list true; without a
  // wired, non-provisional membership service there is no honest list, only an
  // unfiltered, empty or previous-generation one.
  const members = homeScope.filterDevicesForHome(scope, getRawSettingsUiDeviceCandidates({ homey }));
  if (members === null) return UNAVAILABLE_DEVICES_PAYLOAD;
  return {
    devices: members.filter((device) => !isObserveOnlyRoleClassKey(device.deviceClass)),
    hasManagedSolarDevice: hasSolarProductionCandidate(members),
    // Source-blind: export is whatever this home's accrued export families say
    // it is. Both sources report signed net, so a flow home exports on exactly
    // the same evidence as a Homey Energy one.
    hasExhibitedExport: hasMaterialExhibitedExport(reading.powerTracker),
    // Always false when scoped to a SUB-HOME, and all three of its bundle's
    // bindings say so independently: `getInferredSurplusKw: () => null`, the
    // posture fence (`surplusPostureEnabled: false`), and — load-bearing for the
    // TEMPERATURE lift, which the first two do not touch —
    // `getPriceOptimizationSettings: () => ({})`, which empties the willing set.
    // Neither surplus modality can act there, so offering the toggle would
    // promise an engine switched off by construction.
    surplusPoolReachable: false,
    homeScope: { state: 'resolved', homeId: scope.homeId },
  };
};

export const getSettingsUiDevicesPayload = (
  { homey, query }: HomeScopedApiContext,
): SettingsUiDevicesPayload => {
  const scope = SettingsUiHomeScopeAdapter.parseRequestedScope(query);
  if (scope.state === 'whole_home') return getWholeHomeDevicesPayload({ homey });
  if (scope.state === 'rejected') return UNAVAILABLE_DEVICES_PAYLOAD;
  return devicesPayloadForHome(homey, scope);
};

const getWholeHomeDevicesPayload = ({ homey }: ApiContext): SettingsUiDevicesPayload => {
  const candidates = getRawSettingsUiDeviceCandidates({ homey });
  const tracker = getPowerTrackerForUiFromApp(homey)
    ?? (homey.settings.get(POWER_TRACKER_STATE) as PowerTrackerState | null);
  return {
    // Auto-tracked observe-only role devices are force-managed in the backend snapshot for
    // telemetry, but the user never opted into managing them and cannot control them — they
    // leak into the `managed` list with a misleading no-op "Manage" toggle, so drop them from
    // the user-facing device list. The BACKEND snapshot + telemetry stay untouched; they earn
    // a proper tracked / EMS view later.
    devices: candidates.filter((device) => !isObserveOnlyRoleClassKey(device.deviceClass)),
    // A solar/PV device is tracked observe-only and excluded from `devices`, so its presence
    // is the only home-level signal the settings UI gets that the home has solar. The
    // normalized class-key for any role-detected PV is 'solarpanel' (`resolveDeviceClassKey`).
    // NOT source-gated: this flag also unlocks the export-price *settings* section (via
    // `resolveHomeExhibitsSolar`), whose fixed feed-in amount is deliberately usable on the
    // flow source (`docs/solar.md`). The ui_power flag now resolves identically — production
    // reaches both sources — so the two no longer diverge.
    hasManagedSolarDevice: hasSolarProductionCandidate(candidates),
    // Meter-only PV homes (a string inverter with no Homey solarpanel device) get no
    // `hasManagedSolarDevice` signal, yet the surplus-absorb engine keys off whole-home net
    // export, which they DO exhibit. Broaden the "Use solar surplus" toggle gate to them via a
    // stable, accumulated export-kWh signal. Source-blind: both sources report signed net, so
    // a flow home exhibits export on exactly the same evidence as a Homey Energy one.
    hasExhibitedExport: hasMaterialExhibitedExport(tracker && typeof tracker === 'object' ? tracker : null),
    // Whether the surplus ENGINE can act, which the two flags above do not
    // answer: both of them also unlock the export-price section, which needs no
    // surplus pool. Same predicate the runtime producer gates the `surplusOnly`
    // stamp on (`setup/appInit/toPlanDevice.ts`), so the toggle is offered
    // exactly where enabling it does something.
    surplusPoolReachable: resolveSurplusPoolReachable({
      tracker: tracker && typeof tracker === 'object' ? tracker : null,
      curtailmentCanContribute: getCurtailmentCanContributeForUiFromApp(homey),
    }),
  };
};

// ── The three `?homeId=`-aware endpoints ────────────────────────────────────
// One dispatch shape each: an absent id returns the historical payload with NO
// `homeScope` member, so the whole-home response — the one a single-home
// install and every whole-home surface reads — stays byte-identical. A refused
// id (`''`, `'main'`, `':'`-bearing, prototype-colliding, non-string) never
// reaches a settings read; it returns the empty shape marked `unavailable`,
// which is also what an unknown or unwired sub-home returns.

export const getSettingsUiPlanPayload = (
  { homey, query }: HomeScopedApiContext,
): SettingsUiPlanPayload => {
  const scope = SettingsUiHomeScopeAdapter.parseRequestedScope(query);
  if (scope.state === 'whole_home') return { plan: getSettingsUiPlan({ homey }) };
  if (scope.state === 'rejected') return UNAVAILABLE_PLAN_PAYLOAD;
  return planPayloadForHome(homey, scope);
};

export const getSettingsUiPowerPayload = (
  { homey, query }: HomeScopedApiContext,
): SettingsUiPowerPayload => {
  const scope = SettingsUiHomeScopeAdapter.parseRequestedScope(query);
  if (scope.state === 'whole_home') return getSettingsUiPower({ homey });
  if (scope.state === 'rejected') return UNAVAILABLE_POWER_PAYLOAD;
  return powerPayloadForHome(homey, scope);
};

export const getSettingsUiPricesPayload = ({ homey }: ApiContext): SettingsUiPricesPayload => (
  getSettingsUiPrices({ homey })
);

export const getSettingsUiDeviceDiagnosticsPayload = ({ homey }: ApiContext): SettingsUiDeviceDiagnosticsResponse => {
  const app = getApp(homey);
  if (!app?.getDeviceDiagnosticsUiPayload) {
    return buildEmptyDeviceDiagnosticsPayload();
  }
  // No try/catch: let exceptions bubble to the api.ts wrapper so the client
  // sees the real failure and the cause lands in `/tmp/pels` via app.error.
  // Returning an empty payload here would silently strip diagnostics from the
  // device-detail page without any explanation.
  return app.getDeviceDiagnosticsUiPayload();
};

export const getSettingsUiDeviceLogPayload = ({ homey }: ApiContext): SettingsUiDeviceLogPayload => {
  const app = getApp(homey);
  if (!app?.getDeviceLogUiPayload) {
    return { version: 1, entriesByDeviceId: {} };
  }
  // No try/catch: let exceptions bubble to the api.ts wrapper so the client
  // sees the real failure and the cause lands in `/tmp/pels` via app.error.
  return app.getDeviceLogUiPayload();
};

export const getSettingsUiDeferredObjectivePlanHistoryPayload = (
  { homey }: ApiContext,
): SettingsUiDeferredObjectivePlanHistoryPayload => {
  const app = getApp(homey);
  if (!app?.getDeferredObjectivePlanHistoryUiPayload) {
    return { version: 1, entriesByDeviceId: {} };
  }
  // No try/catch: let exceptions bubble to the api.ts wrapper. Swallowing
  // here used to render the Smart tasks past-tasks list and the deadline-plan
  // history tab as empty when the recorder threw, hiding the failure.
  return app.getDeferredObjectivePlanHistoryUiPayload();
};

// Serve the current objectives assembled from per-device keys. The settings UI's
// `loadDeferredObjectiveSettings` reads this instead of the legacy
// `deferred_objectives` blob — the blob is consumed by the boot migration, so
// the direct-load (bootstrap-failure fallback) path would otherwise show empty
// Smart tasks. Mirrors the assembled value `buildSettingsUiBootstrap` injects.
export const getSettingsUiDeferredObjectiveSettingsPayload = (
  { homey }: ApiContext,
): DeferredObjectiveSettingsV1 => readAllObjectives(homey.settings);

// 1-line delegation to the app's readout assembler; null when the app method
// is not wired (old runtime) or the feature flag is off.
export const getSettingsUiWeatherAdvisorReadout = async (
  { homey }: ApiContext,
): Promise<WeatherAdvisorReadoutPayload | null> => {
  const app = getApp(homey);
  if (!app?.getWeatherAdvisorReadout) return null;
  return app.getWeatherAdvisorReadout();
};

export const refreshSettingsUiDevices = async ({ homey }: ApiContext): Promise<SettingsUiDevicesPayload> => {
  await refreshSettingsUiDevicesForApp(homey);
  return getSettingsUiDevicesPayload({ homey });
};

export const refreshSettingsUiPrices = async ({ homey }: ApiContext): Promise<SettingsUiPricesPayload> => {
  await refreshSettingsUiPricesForApp(homey);
  return getSettingsUiPricesPayload({ homey });
};

export const refreshSettingsUiGridTariff = async ({ homey }: ApiContext): Promise<SettingsUiPricesPayload> => {
  await refreshSettingsUiGridTariffForApp(homey);
  return getSettingsUiPricesPayload({ homey });
};

export const resetSettingsUiPowerStats = async ({ homey }: ApiContext): Promise<SettingsUiResetPowerStatsResponse> => {
  const app = getApp(homey);
  await resetSettingsUiPowerStatsForApp(homey);
  return {
    power: getSettingsUiPower({ homey }),
    dailyBudget: app?.getDailyBudgetUiPayload?.() ?? null,
  };
};

export const previewSettingsUiDailyBudgetModel = (
  { homey, body }: ApiContext & { body?: unknown },
): DailyBudgetModelPreviewResponse | null => {
  const app = getApp(homey);
  if (!app?.previewDailyBudgetModel) return null;
  return app.previewDailyBudgetModel(asDailyBudgetModelSettings(body));
};

export const applySettingsUiDailyBudgetModel = (
  { homey, body }: ApiContext & { body?: unknown },
): DailyBudgetUiPayload | null => {
  const app = getApp(homey);
  if (!app?.applyDailyBudgetModel) return null;
  return app.applyDailyBudgetModel(asDailyBudgetModelSettings(body));
};

export const logSettingsUiMessage = ({ homey, body }: ApiContext & { body?: unknown }): { ok: boolean } => {
  const app = getApp(homey);
  if (!isValidLogRequest(body)) {
    app?.error?.('Settings UI log API called without a valid payload');
    return { ok: false };
  }

  const message = formatSettingsUiMessage(body);
  if (body.level === 'error') {
    app?.error?.(message, new Error(body.detail || body.message));
  } else if (body.level === 'warn') {
    app?.log?.(`Warning: ${message}`);
  } else {
    app?.log?.(message);
  }

  return { ok: true };
};
