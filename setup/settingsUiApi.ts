import type Homey from 'homey';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetModelSettings,
  DailyBudgetUiPayload,
} from '../packages/contracts/src/dailyBudgetTypes';
import type {
  ResolvedDeferredObjectiveActivePlansV1,
} from '../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
} from '../packages/contracts/src/deferredObjectivePlanPreview';
import type { PowerTrackerState } from '../packages/contracts/src/powerTrackerTypes';
import type {
  SettingsUiStarvationRescueCreateResponse,
  SettingsUiStarvationRescueDevicesPayload,
  SettingsUiStarvationRescuePreviewResponse,
  StarvationRescueDevice,
  StarvationRescueRejectReason,
} from '../packages/contracts/src/starvationRescue';
import type { WidgetObjectiveWriteResult } from '../packages/contracts/src/widgetHostApi';
import {
  buildRescueCandidate,
  mapAppRescueReason,
  parseRescueRequest,
  RESCUE_DEADLINE_HORIZON_MS,
  resolveRescuableDeviceFromList,
} from '../packages/shared-domain/src/starvationRescueShared';
import { formatSmartTaskDeadlineLong } from '../packages/shared-domain/src/smartTaskDeadlineFormat';
import { scheduledHoursIncludeCurrentHour } from '../packages/shared-domain/src/planStarvation';
import { hasMaterialExhibitedExport } from '../packages/shared-domain/src/solar/exhibitedExport';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../lib/utils/settingsUiBootstrapKeys';
import { DEFERRED_OBJECTIVES_SETTINGS, POWER_TRACKER_STATE } from '../lib/utils/settingsKeys';
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
  SettingsUiPricesPayload,
  SettingsUiResetPowerStatsResponse,
} from '../packages/contracts/src/settingsUiApi';
import type {
  SettingsUiHomesPayload,
  SettingsUiHomesSaveRequest,
  SettingsUiHomesSaveResponse,
} from '../packages/contracts/src/settingsUiHomes';
import {
  findNestedSubHomeRoots,
  generateHomeId,
  HomeStoreWriteRefusedError,
  isValidSubHomeId,
  type SubHomeConfig,
} from '../lib/home/homeConfig';
import { createHomesStore } from './homeRegistryAdapter';
import { isMultiHomeEnabled } from './multiHomeFlag';
import type { TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { HomeMembershipDiagnostics, HomeMembershipService } from './homeMembership';
import { isObserveOnlyRoleClassKey } from '../lib/device/transport/managerHelpers';
import { normalizePowerSource } from '../lib/power/powerSource';
import type { WeatherAdvisorReadoutPayload } from '../packages/contracts/src/weatherAdvisorTypes';
import {
  getLatestDevicesForUiFromApp,
  getPlanSnapshotForUiFromHomey,
  getPowerTrackerForUiFromApp,
  getUiPickerDevicesFromApp,
  refreshSettingsUiDevicesForApp,
  refreshSettingsUiGridTariffForApp,
  refreshSettingsUiPricesForApp,
  resetSettingsUiPowerStatsForApp,
} from './settingsUiAppRuntime';

type SettingsUiApiApp = Homey.App & {
  getDailyBudgetUiPayload?: () => DailyBudgetUiPayload | null;
  recomputeDailyBudgetToday?: () => DailyBudgetUiPayload | null;
  previewDailyBudgetModel?: (settings: Partial<DailyBudgetModelSettings>) => DailyBudgetModelPreviewResponse;
  applyDailyBudgetModel?: (settings: Partial<DailyBudgetModelSettings>) => DailyBudgetUiPayload | null;
  getDeviceDiagnosticsUiPayload?: () => SettingsUiDeviceDiagnosticsResponse;
  getDeviceLogUiPayload?: () => SettingsUiDeviceLogPayload;
  getDeferredObjectivePlanHistoryUiPayload?: () => SettingsUiDeferredObjectivePlanHistoryPayload;
  getDeferredObjectiveActivePlansUiPayload?: () => ResolvedDeferredObjectiveActivePlansV1 | null;
  previewDeferredObjectivePlan?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => DeferredObjectivePlanPreviewEstimate;
  getWeatherAdvisorReadout?: () => Promise<WeatherAdvisorReadoutPayload | null>;
  // Budget-exempt rescue surface — the same app methods the starvation_rescue
  // widget calls. Optional like the rest (the app may be unwired during restart).
  getStarvedRescueDevices?: () => StarvationRescueDevice[];
  previewStarvationRescuePlan?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean };
  rescueDeviceWithBudgetExemption?: (
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ) => WidgetObjectiveWriteResult;
  // The multi-home membership cache. `AppContext` deliberately types this
  // member as the lib/home PORT (control surface only); this setup-internal
  // cast re-narrows to the concrete service the wiring assigned, because the
  // read-only `ui_homes` endpoint is the ONE sanctioned consumer of the
  // diagnostics view (per-device `source`). Optional like the rest:
  // unassigned during the boot window before `initHomeMembership` runs.
  homeMembership?: HomeMembershipService;
};

type ApiContext = {
  homey: Homey.App['homey'];
};

const getApp = (homey: Homey.App['homey']): SettingsUiApiApp | null => {
  if (!homey || typeof homey !== 'object') return null;
  return homey.app as SettingsUiApiApp;
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
const getRawSettingsUiDeviceCandidates = ({ homey }: ApiContext): TargetDeviceSnapshot[] => {
  const managed = getLatestDevicesForUiFromApp(homey) ?? [];
  const unmanagedEligible = getUiPickerDevicesFromApp(homey);
  return [...managed, ...unmanagedEligible];
};

const getSettingsUiPlan = ({ homey }: ApiContext): SettingsUiPlanSnapshot | null => (
  getPlanSnapshotForUiFromHomey(homey)
);

const getSettingsUiPower = ({ homey }: ApiContext): SettingsUiPowerPayload => {
  const tracker = getPowerTrackerForUiFromApp(homey)
    ?? (homey.settings.get(POWER_TRACKER_STATE) as PowerTrackerState | null);
  const status = homey.settings.get('pels_status') as {
    headroomKw?: number;
    lastPowerUpdate?: number | null;
    priceLevel?: string | null;
    powerKnown?: boolean;
    hasLivePowerSample?: boolean;
    powerFreshnessState?: 'fresh' | 'stale_hold' | 'stale_fail_closed';
  } | null;
  return {
    tracker: tracker && typeof tracker === 'object' ? tracker : null,
    status: status && typeof status === 'object' ? status : null,
    heartbeat: null,
    // Home-level "this home has solar surfaces" gate for the Usage tab's
    // Solar card (the device list is lazy-loaded, so the card can't read the
    // ui_devices flag). Requires BOTH a role-detected PV device (class-key
    // 'solarpanel') AND the homey_energy power source: on the flow source the
    // power boundary rejects negative watts and carries no generation field,
    // so the solar buckets can never fill — flagging such a home would render
    // an eternal "gathering" card that promises data that will never come
    // (terminology rule: flow homes get NO solar surfaces).
    hasManagedSolarDevice: normalizePowerSource(homey.settings.get('power_source')) === 'homey_energy'
      && getRawSettingsUiDeviceCandidates({ homey })
        .some((device) => device.deviceClass === 'solarpanel'),
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

export const getSettingsUiDevicesPayload = ({ homey }: ApiContext): SettingsUiDevicesPayload => {
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
    // flow source (see TODO + `docs/solar.md`). The flow-only harm — a dump load stranded
    // "Waiting for solar surplus" forever — is fixed at the producer instead (`toPlanDevice`
    // gates the runtime `surplusOnly` stamp to homey_energy), so the toggle is at worst inert
    // on flow, never destructive. Gating this flag to source-hide the surplus controls WITHOUT
    // hiding the export section needs a decoupled per-control gate — tracked in TODO.
    hasManagedSolarDevice: candidates.some((device) => device.deviceClass === 'solarpanel'),
    // Meter-only PV homes (a string inverter with no Homey solarpanel device) get no
    // `hasManagedSolarDevice` signal, yet the surplus-absorb engine keys off whole-home net
    // export, which they DO exhibit. Broaden the "Use solar surplus" toggle gate to them via a
    // stable, accumulated export-kWh signal. Source-gated to homey_energy: the flow power
    // boundary rejects negative watts, so a flow home's export families are always empty anyway.
    hasExhibitedExport: normalizePowerSource(homey.settings.get('power_source')) === 'homey_energy'
      && hasMaterialExhibitedExport(tracker && typeof tracker === 'object' ? tracker : null),
  };
};

export const getSettingsUiPlanPayload = ({ homey }: ApiContext): SettingsUiPlanPayload => ({
  plan: getSettingsUiPlan({ homey }),
});

// The full "config degraded" condition, as ONE predicate shared by the
// read payload (its `configDegraded` field → the UI's degraded copy) and the
// write seam (its refusal), so the two can never diverge. Degraded ⇔ no wired
// membership service (boot window) OR the last recompute classified EITHER
// persisted store (`homes_config` / `device_home_assignments`) `'suspect'`. A
// whole-value write composed while any of these holds could erase persisted
// areas — hence the write refuses on exactly the same condition the read reports.
const isHomesConfigDegraded = (diagnostics: HomeMembershipDiagnostics | undefined): boolean => (
  diagnostics === undefined || diagnostics.configDegraded
);

// Read-only multi-home view: the membership cache's diagnostics composed into
// the contracts mirror (`SettingsUiHomesPayload`). Before `initHomeMembership`
// runs (boot window) the payload is the honest empty single-home shape. Writes
// go through the `homes_config`/`device_home_assignments` settings keys, never
// through this endpoint.
export const getSettingsUiHomesPayload = ({ homey }: ApiContext): SettingsUiHomesPayload => {
  const multiHomeEnabled = isMultiHomeEnabled(homey.settings);
  if (!multiHomeEnabled) {
    // Flag off (the default in a release): the endpoint is trivially inert —
    // no homes, no membership, and crucially NO zone tree. The membership
    // service's inert recompute already empties homes/membership, but it keeps
    // the zone-tree cache warm for a flip-back; short-circuiting here means an
    // OFF install's read endpoint never emits that cached zone structure, so it
    // is byte-identical to the pre-multi-home world. Not degraded: with the
    // feature off there is no persisted config to vouch for.
    return {
      multiHomeEnabled: false,
      homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, configDegraded: false,
    };
  }
  const diagnostics = getApp(homey)?.homeMembership?.getDiagnostics();
  if (!diagnostics) {
    return {
      // Boot window: nothing can vouch for the persisted config, so the
      // payload is the empty single-home shape AND degraded — the UI must not
      // compose a whole-value homes_config write from this view.
      multiHomeEnabled,
      homes: [], membershipByDeviceId: {}, zoneTree: null, hasSubHomes: false, configDegraded: true,
    };
  }
  // Uniform copy discipline: shallow-copy ALL collection members so the
  // composed payload never aliases the service's live caches (a future
  // in-process consumer mutating the payload must not corrupt membership).
  return {
    multiHomeEnabled,
    homes: [...diagnostics.subHomes],
    membershipByDeviceId: { ...diagnostics.membershipByDeviceId },
    zoneTree: diagnostics.zoneTree === null ? null : { ...diagnostics.zoneTree },
    hasSubHomes: diagnostics.hasSubHomes,
    configDegraded: isHomesConfigDegraded(diagnostics),
  };
};

// ── ui_homes_save: the Multiple meters UI's ONLY write seam ────────────────
// Intent operations (upsert/delete of ONE area), never a client-composed
// whole list: the runtime re-reads the persisted config through the
// CLASSIFIED store reader, refuses when it classifies suspect (closing the
// UI's degraded-check TOCTOU server-side), applies the single op to the
// fresh list, and persists through the marker-first classified writer (which
// refuses implausible payloads). The app's single-threaded event loop
// serializes saves, and an op naming one area means a stale panel can never
// wipe the others.

const asSaveRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const toSaveNonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

type ParsedUpsertArea = Extract<SettingsUiHomesSaveRequest, { op: 'upsert' }>['area'];

/** Boundary parse of an upsert `area` payload; `null` = malformed. */
const parseUpsertArea = (value: unknown): ParsedUpsertArea | null => {
  const area = asSaveRecord(value);
  if (!area) return null;
  // A present-but-malformed homeId must refuse, never silently become a create.
  let homeId: string | undefined;
  if (area.homeId !== undefined) {
    if (typeof area.homeId !== 'string' || !isValidSubHomeId(area.homeId)) return null;
    homeId = area.homeId;
  }
  if (typeof area.name !== 'string') return null;
  const rootZoneId = toSaveNonEmptyString(area.rootZoneId);
  if (rootZoneId === null) return null;
  // Explicit null = no meter (the domain allows it); anything else must be a
  // non-empty string — absent/malformed refuses rather than coercing.
  const meterRaw = area.meterDeviceId;
  const meterDeviceId = meterRaw === null ? null : toSaveNonEmptyString(meterRaw);
  if (meterRaw !== null && meterDeviceId === null) return null;
  return {
    ...(homeId === undefined ? {} : { homeId }), name: area.name, rootZoneId, meterDeviceId,
  };
};

/** Boundary parse of the untrusted request body; `null` = malformed. */
const parseHomesSaveRequest = (body: unknown): SettingsUiHomesSaveRequest | null => {
  const record = asSaveRecord(body);
  if (!record) return null;
  if (record.op === 'delete') {
    const homeId = toSaveNonEmptyString(record.homeId);
    return homeId !== null && isValidSubHomeId(homeId) ? { op: 'delete', homeId } : null;
  }
  if (record.op !== 'upsert') return null;
  const area = parseUpsertArea(record.area);
  return area === null ? null : { op: 'upsert', area };
};

const applyHomesUpsert = (
  current: readonly SubHomeConfig[],
  area: Extract<SettingsUiHomesSaveRequest, { op: 'upsert' }>['area'],
): SubHomeConfig[] => {
  // Id allocation is the runtime's (create = absent id); an upsert with a
  // vanished id honestly re-adds the area — the UI's "Add again" semantics.
  const homeId = area.homeId ?? generateHomeId(current.map((entry) => entry.homeId));
  const entry: SubHomeConfig = {
    homeId, name: area.name, rootZoneId: area.rootZoneId, meterDeviceId: area.meterDeviceId,
  };
  return current.some((existing) => existing.homeId === homeId)
    ? current.map((existing) => (existing.homeId === homeId ? entry : existing))
    : [...current, entry];
};

// A meter area rooted at a zone-forest root would swallow the whole home and
// empty the Main home (the strict-subpart invariant). Checked only against a
// KNOWN tree — zone-data absence never blocks a save; a delete never roots.
const upsertRootsAtForestRoot = (
  homey: Homey.App['homey'],
  request: SettingsUiHomesSaveRequest,
): boolean => {
  if (request.op !== 'upsert') return false;
  const zoneTree = getApp(homey)?.homeMembership?.getDiagnostics().zoneTree ?? null;
  return zoneTree !== null && zoneTree[request.area.rootZoneId]?.parent === null;
};

// The COMPOSED upsert must keep sub-home root subtrees disjoint — the v1
// invariant `findNestedSubHomeRoots` enforces. Without this, two independently
// stale panels could persist nested or identical root zones, silently re-homing
// a third area's devices via deepest-root precedence (`lib/home/membership.ts`).
// The store's plausibility check only guards shape + unique ids, so the overlap
// gate lives here. Checked only against a KNOWN tree — zone-data absence never
// blocks a save (parity with `upsertRootsAtForestRoot`); a delete never
// introduces an overlap, so callers run this for upserts only.
const upsertNestsSubHomeRoots = (
  homey: Homey.App['homey'],
  next: readonly SubHomeConfig[],
): boolean => {
  const zoneTree = getApp(homey)?.homeMembership?.getDiagnostics().zoneTree ?? null;
  return zoneTree !== null && findNestedSubHomeRoots({ subHomes: [...next] }, zoneTree).length > 0;
};

export const saveSettingsUiHomesConfig = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiHomesSaveResponse => {
  // Feature flag OFF: the "Multiple meters" UI is hidden, so no legitimate
  // client reaches here — but a direct API call must NOT be able to create or
  // edit a meter area while the feature is disabled. Refuse before any parse
  // or store read, so homes_config is never mutated while off.
  if (!isMultiHomeEnabled(homey.settings)) return { ok: false, reason: 'disabled' };
  const request = parseHomesSaveRequest(body);
  if (request === null) return { ok: false, reason: 'invalid' };
  if (upsertRootsAtForestRoot(homey, request)) return { ok: false, reason: 'invalid' };
  // Refuse whenever the ui_homes read would report degraded — an unwired
  // membership service (boot window) OR EITHER persisted store `'suspect'` as
  // of the last recompute — not merely a suspect homes-store read: composing a
  // whole-value write over an unknown/stale config could erase areas. Shares
  // the read payload's predicate so the two gates can never diverge; the UI
  // maps this refusal to its degraded copy.
  if (isHomesConfigDegraded(getApp(homey)?.homeMembership?.getDiagnostics())) {
    return { ok: false, reason: 'degraded' };
  }
  const store = createHomesStore(homey);
  const read = store.read();
  // TOCTOU close: a FRESH classified read (the homes store can go suspect
  // between the last recompute and now). The persisted truth is unknown, and
  // applying an op over a guess could erase areas.
  if (read.state === 'suspect') return { ok: false, reason: 'degraded' };
  const current: readonly SubHomeConfig[] = read.state === 'present' ? read.value.subHomes : [];
  const next = request.op === 'delete'
    ? current.filter((area) => area.homeId !== request.homeId)
    : applyHomesUpsert(current, request.area);
  // An upsert must not nest or duplicate an existing area's root zone (a delete
  // never can) — validate the composed list against the known zone tree before
  // persisting.
  if (request.op === 'upsert' && upsertNestsSubHomeRoots(homey, next)) {
    return { ok: false, reason: 'invalid' };
  }
  try {
    store.write({ subHomes: next });
  } catch (error) {
    if (error instanceof HomeStoreWriteRefusedError) return { ok: false, reason: 'invalid' };
    throw error;
  }
  return { ok: true };
};

export const getSettingsUiPowerPayload = ({ homey }: ApiContext): SettingsUiPowerPayload => (
  getSettingsUiPower({ homey })
);

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

export const recomputeSettingsUiDailyBudget = ({ homey }: ApiContext): DailyBudgetUiPayload | null => {
  const app = getApp(homey);
  if (!app?.recomputeDailyBudgetToday) return null;
  // No try/catch: let exceptions bubble to the api.ts wrapper for logging.
  return app.recomputeDailyBudgetToday();
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

// ─── Overview device-card budget-exempt rescue ("Let it run now") ────────────
//
// The same bounded rescue the starvation_rescue widget offers, surfaced from the
// overview device card. These handlers run in the app process and reach the SAME
// app methods the widget calls (`getStarvedRescueDevices`,
// `previewStarvationRescuePlan`, `rescueDeviceWithBudgetExemption`), reusing the
// shared request/candidate/gating helpers so the two surfaces resolve the rescue
// identically. There is NO standing per-device toggle here — a budget exemption
// is always BOUNDED to a fresh deferred objective (≈ now+3h, until the device
// reaches its normal target), per feedback_hard_cap_is_physical.

const previewRescueReject = (
  reason: StarvationRescueRejectReason,
): SettingsUiStarvationRescuePreviewResponse => ({ ok: false, reason });

const createRescueReject = (
  reason: StarvationRescueRejectReason,
): SettingsUiStarvationRescueCreateResponse => ({ ok: false, reason });

// Resolve the requested device against the LIVE starved list. `homey.app` is
// optional during restart; a `null` list maps to `unavailable` in the shared
// resolver.
const resolveRescuableSettingsDevice = (app: SettingsUiApiApp | null, deviceId: string) => {
  const devices = typeof app?.getStarvedRescueDevices === 'function' ? app.getStarvedRescueDevices() : null;
  return resolveRescuableDeviceFromList(devices, deviceId);
};

// The device IDs the overview chip may offer the rescue on — the same gate the
// widget uses (budget-caused + task-free + a known target). Resolved from
// `getStarvedRescueDevices` so a shown chip's create call can never be rejected
// as not-rescuable.
export const getSettingsUiStarvationRescueDevices = (
  { homey }: ApiContext,
): SettingsUiStarvationRescueDevicesPayload => {
  const app = getApp(homey);
  const devices = typeof app?.getStarvedRescueDevices === 'function' ? app.getStarvedRescueDevices() : null;
  const rescuableDeviceIds = (devices ?? [])
    .filter((device) => resolveRescuableDeviceFromList([device], device.deviceId).ok)
    .map((device) => device.deviceId);
  return { rescuableDeviceIds };
};

export const previewSettingsUiStarvationRescue = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiStarvationRescuePreviewResponse => {
  const request = parseRescueRequest(body);
  if (!request) return previewRescueReject('invalid_request');
  const app = getApp(homey);
  if (typeof app?.previewStarvationRescuePlan !== 'function') return previewRescueReject('unavailable');

  const rescuable = resolveRescuableSettingsDevice(app, request.deviceId);
  if (!rescuable.ok) return previewRescueReject(rescuable.reason);

  const nowMs = Date.now();
  const timeZone = homey.clock.getTimezone();
  // A rescue is always a fresh task (task-having devices are excluded), so the
  // deadline is simply the now+3h rescue horizon — the fresh candidate IS what
  // persists (preview ≡ persist).
  const candidate = buildRescueCandidate(rescuable.targetTemperatureC, nowMs + RESCUE_DEADLINE_HORIZON_MS);
  const { estimate, deadlineAtMs } = app.previewStarvationRescuePlan(request.deviceId, candidate);
  return {
    ok: true,
    deadlineAtMs,
    deadlineLabel: formatSmartTaskDeadlineLong(deadlineAtMs, nowMs, timeZone),
    estimate,
  };
};

export const createSettingsUiStarvationRescue = (
  { homey, body }: ApiContext & { body?: unknown },
): SettingsUiStarvationRescueCreateResponse => {
  const request = parseRescueRequest(body);
  if (!request) return createRescueReject('invalid_request');
  const app = getApp(homey);
  if (typeof app?.rescueDeviceWithBudgetExemption !== 'function') return createRescueReject('unavailable');

  // Re-check the guardrail at create time against the LIVE list: a row that
  // recovered (or whose cause changed) between preview and confirm is rejected
  // rather than silently granted a budget exemption.
  const rescuable = resolveRescuableSettingsDevice(app, request.deviceId);
  if (!rescuable.ok) return createRescueReject(rescuable.reason);

  // Persist the EXACT deadline the preview resolved (echoed back), or a fresh
  // near-term horizon when none was echoed (a plain confirm without a preview).
  // Either way the deadline must be strictly future AND within the rescue horizon.
  const nowMs = Date.now();
  const deadlineAtMs = request.deadlineAtMs ?? nowMs + RESCUE_DEADLINE_HORIZON_MS;
  if (deadlineAtMs <= nowMs || deadlineAtMs > nowMs + RESCUE_DEADLINE_HORIZON_MS) {
    return createRescueReject('deadline_passed');
  }
  const candidate = buildRescueCandidate(rescuable.targetTemperatureC, deadlineAtMs);
  const result = app.rescueDeviceWithBudgetExemption(request.deviceId, candidate);
  if (!result.ok) return createRescueReject(mapAppRescueReason(result.reason));
  // Resolve the success flash against the JUST-PERSISTED plan at THIS moment
  // (a pure re-derivation, no persist); absent the preview method, fall back to
  // the honest-conservative "not running now".
  const post = app.previewStarvationRescuePlan?.(request.deviceId, candidate);
  return {
    ok: true,
    runsCurrentHour: post ? scheduledHoursIncludeCurrentHour(post.estimate.scheduledHours, nowMs) : false,
  };
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
