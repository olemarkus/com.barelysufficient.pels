import type Homey from 'homey';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetModelSettings,
  DailyBudgetUiRead,
} from '../packages/contracts/src/dailyBudgetTypes';
import type { PowerTrackerState } from '../packages/contracts/src/powerTrackerTypes';
import { hasMaterialExhibitedExport } from '../packages/shared-domain/src/solar/exhibitedExport';
import { SETTINGS_UI_BOOTSTRAP_KEYS } from '../lib/utils/settingsUiBootstrapKeys';
import { DEFERRED_OBJECTIVES_SETTINGS, MAIN_HOME_ID } from '../lib/utils/settingsKeys';
import {
  SettingsUiHomeScopeAdapter,
  type ResolvedSubHomeScope,
} from './settingsUiHomeScope';
import { readAllObjectives } from '../lib/objectives/deferredObjectives/objectiveStore';
import type { DeferredObjectiveSettingsV1 } from '../packages/contracts/src/deferredObjectiveSettings';
import { readPelsHost, type PelsHost } from '../lib/app/pelsHost';
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
  SettingsUiPriceSourcePayloads,
  SettingsUiPricesPayload,
  SettingsUiResetPowerStatsResponse,
  SettingsUiDeviceSnapshot,
  SettingsUiBatteryState,
} from '../packages/contracts/src/settingsUiApi';
import { readObservedStateOfCharge } from '../lib/observer/observedDeviceStateProjection';
import type { ObservedStateOfChargeRead } from '../lib/observer/observedDeviceStateProjection';
import type {
  DecoratedDeviceSnapshot,
  ProjectedObservedDeviceState,
  StateOfChargeObservedProbe,
} from '../packages/contracts/src/types';
import { hasObservedStateOfCharge } from '../packages/shared-domain/src/stateOfChargeObservedState';
import { hasSolarProductionCandidate } from '../lib/device/solarPresence';
import { readChargerPhasePresetsFromHomey } from '../lib/device/settingsUiDeviceReads';
import { hasPowerMeasurement } from '../lib/power/lastTotalPower';
import {
  projectCapacityPeakForUi,
  projectPowerTrackerForUi,
  resolvePowerReadingsForUi,
} from '../lib/power/trackerUiProjection';
import type { WeatherAdvisorReadout } from '../packages/contracts/src/weatherAdvisorTypes';
import {
  appNotReadyError,
  classifyPowerStatusRead,
  readPlanStatusForUi,
  resetPowerStatsForUi,
  type PowerMeasurementEvidence,
} from './settingsUiAppRuntime';

/**
 * What the settings UI is told before the price coordinator is wired, or while
 * the app is: nothing stored.
 */
export const NO_PRICE_SOURCE_PAYLOADS: SettingsUiPriceSourcePayloads = {
  flowToday: null,
  flowTomorrow: null,
  homeyCurrency: null,
  homeyToday: null,
  homeyTomorrow: null,
  powerhourCurrency: null,
  powerhourToday: null,
  powerhourTomorrow: null,
};

/**
 * The daily budget while the app is not wired — the same "nothing computed" the
 * service reports, so callers get one member to render rather than two
 * spellings of nothing.
 */
const NOT_READY_DAILY_BUDGET: DailyBudgetUiRead = { kind: 'unavailable' };

/**
 * The whole-home power payload while the app is not wired: no history, no
 * measurement, and every capacity read unavailable.
 */
const NOT_READY_POWER_PAYLOAD: SettingsUiPowerPayload = {
  tracker: {},
  readings: { state: 'never' },
  status: { state: 'unavailable', reason: 'no_measurement' },
  capacityPeak: { state: 'unavailable' },
  capacityScalars: { state: 'unavailable' },
  hardCapConfiguration: { state: 'unavailable' },
  hasManagedSolarDevice: false,
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

// The raw candidate list BEFORE the battery/solar filter: runtime devices joined
// from DeviceReads metadata and Observer state, plus unmanaged-but-eligible
// picker devices from SettingsUiDeviceReads. Home batteries ('battery') and PV
// ('solarpanel') ride the runtime half here; callers decide whether to expose
// or merely detect them.
/**
 * The observed fields `/ui_devices` refreshes from the observer projection.
 *
 * An explicit list, not a spread of the whole projection, because the payload
 * is the DECORATED snapshot and two of the projection's fields are decoration
 * outputs rather than raw observations:
 *
 * - `binaryControl` — `decorateSnapshotWithDeviceControl` RESOLVES it from the
 *   selected rung for a STEPPED LOAD (`resolveObservedSteppedOn`,
 *   `setup/appDeviceControlHelpers.ts`). A stepped
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
  'evCharging',
  'evChargingObservedAtMs',
  'evChargingState',
  'lastFreshDataMs',
  'lastLocalWriteMs',
  'lastUpdated',
] as const satisfies readonly (keyof ProjectedObservedDeviceState)[];



const resolveLiveObservedFields = (
  device: DecoratedDeviceSnapshot,
): readonly (keyof ProjectedObservedDeviceState)[] => (
  device.controlModel === 'stepped_load'
    ? LIVE_OBSERVED_FIELDS
    : [...LIVE_OBSERVED_FIELDS, 'binaryControl']
);

const pickLiveObservedFields = (
  observed: ProjectedObservedDeviceState,
  fields: readonly (keyof ProjectedObservedDeviceState)[],
): Partial<DecoratedDeviceSnapshot> => Object.fromEntries(
  fields
    .filter((field) => observed[field] !== undefined)
    .map((field) => [field, observed[field]]),
);

/**
 * The state of charge, projected to the level.
 *
 * An absent read means the OBSERVER has none — no projection entry, or an entry
 * carrying no charge — so it falls through to the stored parse, which is how a
 * picker row (never in the projection, by design) keeps the level from its cached
 * parse. Both paths emit the same shape.
 */
const resolveStateOfCharge = (
  device: DecoratedDeviceSnapshot & StateOfChargeObservedProbe,
  read: ObservedStateOfChargeRead,
): SettingsUiDeviceSnapshot['stateOfCharge'] => {
  if (read.kind === 'observed') return read.value;
  return hasObservedStateOfCharge(device) ? { level: device.stateOfCharge.level } : undefined;
};

/**
 * Builds the device list `/ui_devices` serves — once, in one pass.
 *
 * It used to be four sequential maps over the whole list (associated cars, the
 * live-observed overlay, priorities, the resolved state of charge), each
 * allocating a fresh object per device. Nothing named the assembled thing, so
 * what the list WAS could only be learned by reading four functions and inferring
 * that their order did not matter — and adding a fifth field looked like adding a
 * fifth pass.
 *
 * Only priorities need the list as a list, because ranking is relative; they are
 * resolved up front and applied with everything else. The observer projection is
 * consulted ONCE per device — the state-of-charge read takes the record rather
 * than the id, where two id-keyed reads used to pay for the same lookup twice.
 *
 * This is API-layer assembly, so it lives with the endpoint it serves rather than
 * in `lib/`: the settings-UI payload is a CONSUMER of the domain, not part of it.
 * It sits in `setup/` only because the API layer has no home of its own yet —
 * see `notes/state-management/snapshot-decomposition.md` § "The API layer has no
 * home".
 */
const buildSettingsUiDeviceList = (
  host: PelsHost,
  devices: readonly (DecoratedDeviceSnapshot & StateOfChargeObservedProbe)[],
): SettingsUiDeviceSnapshot[] => {
  if (devices.length === 0) return [];
  const priorities = host.getModePrioritiesForUi(devices.map((device) => device.id));
  return devices.map((device) => {
    // The live observed record and car association, never the stored copy: the
    // stored device snapshot is rebuilt on the device poll, so its observed half
    // is up to one poll interval behind, and the car association is resolved per
    // call by the transport so a plug-in shows within the probe's settle.
    const observed = host.getObservedRecord(device.id);
    const associatedCar = host.deviceManager?.getAssociatedCar(device.id);
    const stateOfCharge = resolveStateOfCharge(device, readObservedStateOfCharge(observed));
    return {
      ...device,
      // Two absences are deliberately no-ops rather than writes, because neither
      // is a reading PELS took: a device with no projection entry keeps its
      // stored snapshot (permanent for an unmanaged PICKER row, which the
      // projection drops), and a field the projection omits keeps its stored
      // value rather than being blanked.
      ...(observed ? pickLiveObservedFields(observed, resolveLiveObservedFields(device)) : {}),
      ...(associatedCar ? { associatedCar } : {}),
      ...(stateOfCharge ? { stateOfCharge } : {}),
      ...readSettingsUiBatteryState(host, device),
      priority: priorities.getPriority(device.id),
    };
  });
};

/**
 * A listed device's home-battery facts, as the battery control owner answers
 * them; the owner answers `not_battery` for every other device. Devices are
 * listed only after the owner is built, so a missing owner is a not-ready read,
 * never a guess.
 */
const readSettingsUiBatteryState = (
  host: PelsHost,
  device: Pick<DecoratedDeviceSnapshot, 'id'>,
): SettingsUiBatteryState => {
  const owner = host.batteryControl;
  if (!owner) throw appNotReadyError('Battery control');
  return {
    batteryControl: owner.readControlCapability(device.id),
    batteryTakenOver: owner.wasTakenOver(device.id),
  };
};

const getRawSettingsUiDeviceCandidates = (host: PelsHost): SettingsUiDeviceSnapshot[] => (
  buildSettingsUiDeviceList(host, [...host.getSettingsUiManagedDevices(), ...host.getUiPickerDevices()])
);

// The stepped branch of the decorator is the only one that resolves
// `binaryControl`, and it is the only branch that stamps this control model —
// so this is the exact condition under which the stored value is a decision
// rather than an observation.
// The listed fields the projection actually carries, as a patch. A field the
// projection omits is left out rather than written as `undefined`, so the
// stored value carries forward instead of being blanked.
/** The whole-home plan, or none while the app is not wired. */
const getSettingsUiPlan = (homey: ApiContext['homey']): SettingsUiPlanSnapshot | null => (
  readPelsHost(homey)?.getLatestPlanSnapshotForUi() ?? null
);

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
 * rows. The live latch is itself restored across an ordinary restart
 * (`hydratePowerTracker`) — that is the planner's own restored-sample policy,
 * and the open gate then publishes a status promptly.
 * What this classification closes is the truly gated home: first-ever boot,
 * post-meter-swap, or a corrupt tracker restore, where no status of this run
 * exists to serve.
 */
const classifyMainPowerStatus = (host: PelsHost): SettingsUiPowerStatusRead => classifyPowerStatusRead(
  latchEvidence(hasPowerMeasurement(host.powerTracker)),
  readPlanStatusForUi(host, MAIN_HOME_ID),
);

const getSettingsUiPower = (host: PelsHost): SettingsUiPowerPayload => {
  // The tracker keeps the persisted fallback: it carries usage HISTORY
  // (buckets, daily totals, solar families) whose consumers age it themselves
  // (stale-data banner, solar-now staleness gate). Liveness claims ride the
  // classified `status` read only.
  const tracker: PowerTrackerState = host.powerTracker;
  return {
    tracker: projectPowerTrackerForUi(tracker, Date.now()),
    readings: resolvePowerReadingsForUi(tracker),
    status: classifyMainPowerStatus(host),
    capacityScalars: { state: 'resolved', scalars: host.getCapacityScalars() },
    hardCapConfiguration: host.readHardCapConfiguration(),
    capacityPeak: projectCapacityPeakForUi(host.getCurrentMonthCapacityPeakKw()),
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
    hasManagedSolarDevice: hasSolarProductionCandidate(host.getSettingsUiManagedDevices()),
  };
};

/** A settings value that is a string, or the absence the payload reports as `null`. */
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const getSettingsUiPrices = ({ homey }: ApiContext): SettingsUiPricesPayload => {
  const host = readPelsHost(homey);
  const priceArea = stringOrNull(homey.settings.get('price_area'));
  if (!host) {
    return {
      combinedPrices: null,
      priceArea,
      ...NO_PRICE_SOURCE_PAYLOADS,
      pvForecastSource: { kind: 'unknown' },
      homeyPriceFormula: { kind: 'unknown' },
      powerhourSource: { kind: 'unknown' },
      priceOptimizationSetup: { state: 'unavailable' },
      priceSetup: { state: 'unavailable' },
    };
  }
  // The settings-UI client (`normalizeCombinedPrices`, `ui/combinedPrices.ts`) accepts
  // both the legacy V1 `{ prices: [...] }` and V2 `{ days: {...} }` shapes,
  // so the stored value is forwarded as-is. A first read through the
  // combined-prices reader (daily-budget service, plan service) migrates V1 to
  // V2 in place; later bootstrap calls then see V2 here.
  return {
    combinedPrices: host.getCombinedPricesForUi(),
    priceArea,
    ...host.getPriceSourcePayloadsForUi(),
    pvForecastSource: host.getPvForecastSourceUiStatus(),
    homeyPriceFormula: host.getHomeyPriceFormulaUiStatus(),
    powerhourSource: host.getPowerhourSourceUiStatus(),
    priceOptimizationSetup: host.readPriceOptimizationSetup(),
    priceSetup: host.readPriceSetup(),
  };
};

const buildEmptyDeviceDiagnosticsPayload = (): SettingsUiDeviceDiagnosticsResponse => ({
  generatedAt: Date.now(),
  windowDays: 21,
  diagnosticsByDeviceId: {},
});

export const buildSettingsUiBootstrap = async ({ homey }: ApiContext): Promise<SettingsUiBootstrap> => {
  const host = readPelsHost(homey);
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
    dailyBudget: host ? host.getDailyBudgetUiPayload() : NOT_READY_DAILY_BUDGET,
    deferredObjectiveActivePlans: host ? host.getDeferredObjectiveActivePlansUiPayload() : null,
    plan: getSettingsUiPlan(homey),
    power: host ? getSettingsUiPower(host) : NOT_READY_POWER_PAYLOAD,
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
// Values come from the read port + that home's own status in the registry;
// nothing here rebuilds, refreshes or actuates. The helpers accept only a
// parser-resolved scope, so no untrusted string can reach them.

const UNAVAILABLE_PLAN_PAYLOAD: SettingsUiPlanPayload = {
  plan: null, homeScope: { state: 'unavailable' },
};
const UNAVAILABLE_POWER_PAYLOAD: SettingsUiPowerPayload = {
  tracker: {},
  readings: { state: 'never' },
  status: { state: 'unavailable', reason: 'home_scope_unavailable' },
  capacityPeak: { state: 'unavailable' },
  capacityScalars: { state: 'unavailable' },
  hardCapConfiguration: { state: 'unavailable' },
  homeScope: { state: 'unavailable' },
};
const UNAVAILABLE_DEVICES_PAYLOAD: SettingsUiDevicesPayload = {
  devices: [], chargerPhasePresets: { state: 'unavailable' }, homeScope: { state: 'unavailable' },
};

const planPayloadForHome = (
  host: PelsHost,
  scope: ResolvedSubHomeScope,
): SettingsUiPlanPayload => {
  const reading = new SettingsUiHomeScopeAdapter(host).readRuntime(scope);
  if (!reading) return UNAVAILABLE_PLAN_PAYLOAD;
  return { plan: reading.plan, homeScope: { state: 'resolved', homeId: scope.homeId } };
};

const powerPayloadForHome = (
  host: PelsHost,
  scope: ResolvedSubHomeScope,
): SettingsUiPowerPayload => {
  const homeScope = new SettingsUiHomeScopeAdapter(host);
  const reading = homeScope.readRuntime(scope);
  if (!reading) return UNAVAILABLE_POWER_PAYLOAD;
  // Unwired or provisional membership refuses the WHOLE payload, exactly as
  // the devices composer does, so `homeScope: resolved` always means every
  // field is this home's truth — an absent solar flag never has to carry a
  // second meaning (the contract's documented absence case is the realtime
  // status-only push).
  const members = homeScope.filterDevicesForHome(scope, getRawSettingsUiDeviceCandidates(host));
  if (members === null) return UNAVAILABLE_POWER_PAYLOAD;
  // That home's own live status, out of the app's registry — the same read
  // main's unsuffixed path makes.
  const statusRead = readPlanStatusForUi(host, scope.homeId);
  // No `power_source` read here any more: with production reaching both sources,
  // nothing in this payload depends on which one is configured, so reading it
  // purely to classify its failure would fence a home out of its own payload
  // over a setting the payload does not use.
  //
  // Same read-boundary classification as the whole-home composer, against this
  // home's OWN live tracker — the identical predicate its bundle's plan-build
  // gate asks (`createPlanService` wires the gate per scope). A gated sub-home
  // (its area meter never reported this run) has published nothing and is
  // served nothing. The unavailable arm was refused above, so only
  // `resolved`/`absent` reach the classifier.
  return {
    tracker: projectPowerTrackerForUi(reading.powerTracker, Date.now()),
    readings: resolvePowerReadingsForUi(reading.powerTracker),
    status: classifyPowerStatusRead(latchEvidence(hasPowerMeasurement(reading.powerTracker)), statusRead),
    capacityPeak: projectCapacityPeakForUi(reading.currentMonthCapacityPeakKw),
    capacityScalars: { state: 'resolved', scalars: reading.diagnostics.capacityScalars },
    // Sub-home diagnostics expose running scalars but not persisted key
    // provenance; absence must remain unavailable rather than be guessed.
    hardCapConfiguration: { state: 'unavailable' },
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
  host: PelsHost,
  scope: ResolvedSubHomeScope,
): SettingsUiDevicesPayload => {
  const homeScope = new SettingsUiHomeScopeAdapter(host);
  const reading = homeScope.readRuntime(scope);
  if (reading === null) return UNAVAILABLE_DEVICES_PAYLOAD;
  // Device→home attribution is what makes a per-home list true; without a
  // wired, non-provisional membership service there is no honest list, only an
  // unfiltered, empty or previous-generation one.
  const members = homeScope.filterDevicesForHome(scope, getRawSettingsUiDeviceCandidates(host));
  if (members === null) return UNAVAILABLE_DEVICES_PAYLOAD;
  return {
    // A meter area's battery and solar devices are telemetry only: PELS does
    // not control a battery outside the Main home.
    devices: members.filter((device) => !device.isBatteryOrSolar),
    // Keyed by device id and consulted only for a device the owner is looking
    // at, so the whole-home map serves a sub-home unchanged: a charger outside
    // this home is never looked up here.
    chargerPhasePresets: readChargerPhasePresetsFromHomey(homey),
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
  // An app that is not wired serves no home's list.
  const host = readPelsHost(homey);
  return host ? devicesPayloadForHome(homey, host, scope) : UNAVAILABLE_DEVICES_PAYLOAD;
};

const getWholeHomeDevicesPayload = ({ homey }: ApiContext): SettingsUiDevicesPayload => {
  const host = readPelsHost(homey);
  if (!host) {
    return {
      devices: [],
      chargerPhasePresets: readChargerPhasePresetsFromHomey(homey),
      hasManagedSolarDevice: false,
      hasExhibitedExport: false,
      surplusPoolReachable: false,
    };
  }
  const candidates = getRawSettingsUiDeviceCandidates(host);
  return {
    // A Main-home battery is an ordinary managed device the owner can see and
    // switch; a solar device and a meter area's battery ride the backend
    // snapshot for telemetry only.
    devices: new SettingsUiHomeScopeAdapter(host).filterWholeHomeDevices(candidates),
    chargerPhasePresets: readChargerPhasePresetsFromHomey(homey),
    // A solar/PV device is always read and excluded from `devices`, so its presence
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
    hasExhibitedExport: hasMaterialExhibitedExport(host.powerTracker),
    // Whether the surplus ENGINE can act, which the two flags above do not
    // answer: both of them also unlock the export-price section, which needs no
    // surplus pool. Same predicate the runtime producer gates the `surplusOnly`
    // stamp on (`lib/planInput/projectPlanInputDevice.ts`), so the toggle is offered
    // exactly where enabling it does something.
    surplusPoolReachable: host.isSurplusPoolReachable(),
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
  if (scope.state === 'whole_home') return { plan: getSettingsUiPlan(homey) };
  if (scope.state === 'rejected') return UNAVAILABLE_PLAN_PAYLOAD;
  const host = readPelsHost(homey);
  return host ? planPayloadForHome(host, scope) : UNAVAILABLE_PLAN_PAYLOAD;
};

export const getSettingsUiPowerPayload = (
  { homey, query }: HomeScopedApiContext,
): SettingsUiPowerPayload => {
  const scope = SettingsUiHomeScopeAdapter.parseRequestedScope(query);
  const host = readPelsHost(homey);
  if (scope.state === 'whole_home') return host ? getSettingsUiPower(host) : NOT_READY_POWER_PAYLOAD;
  if (scope.state === 'rejected') return UNAVAILABLE_POWER_PAYLOAD;
  return host ? powerPayloadForHome(host, scope) : UNAVAILABLE_POWER_PAYLOAD;
};

export const getSettingsUiPricesPayload = ({ homey }: ApiContext): SettingsUiPricesPayload => (
  getSettingsUiPrices({ homey })
);

export const getSettingsUiDeviceDiagnosticsPayload = ({ homey }: ApiContext): SettingsUiDeviceDiagnosticsResponse => {
  const host = readPelsHost(homey);
  if (!host) return buildEmptyDeviceDiagnosticsPayload();
  // No try/catch: let exceptions bubble to the api.ts wrapper so the client
  // sees the real failure and the cause lands in `/tmp/pels` via app.error.
  // Returning an empty payload here would silently strip diagnostics from the
  // device-detail page without any explanation.
  return host.getDeviceDiagnosticsUiPayload();
};

export const getSettingsUiDeviceLogPayload = ({ homey }: ApiContext): SettingsUiDeviceLogPayload => {
  const host = readPelsHost(homey);
  if (!host) return { version: 1, entriesByDeviceId: {} };
  // No try/catch: let exceptions bubble to the api.ts wrapper so the client
  // sees the real failure and the cause lands in `/tmp/pels` via app.error.
  return host.getDeviceLogUiPayload();
};

export const getSettingsUiDeferredObjectivePlanHistoryPayload = (
  { homey }: ApiContext,
): SettingsUiDeferredObjectivePlanHistoryPayload => {
  const host = readPelsHost(homey);
  if (!host) return { version: 1, entriesByDeviceId: {} };
  // No try/catch: let exceptions bubble to the api.ts wrapper. Swallowing
  // here used to render the Smart tasks past-tasks list and the deadline-plan
  // history tab as empty when the recorder threw, hiding the failure.
  return host.getDeferredObjectivePlanHistoryUiPayload();
};

// Serve the current objectives assembled from per-device keys. The settings UI's
// `loadDeferredObjectiveSettings` reads this instead of the legacy
// `deferred_objectives` blob — the blob is consumed by the boot migration, so
// the direct-load (bootstrap-failure fallback) path would otherwise show empty
// Smart tasks. Mirrors the assembled value `buildSettingsUiBootstrap` injects.
export const getSettingsUiDeferredObjectiveSettingsPayload = (
  { homey }: ApiContext,
): DeferredObjectiveSettingsV1 => readAllObjectives(homey.settings);

// 1-line delegation to the app's readout assembler; `inactive` when the app is
// not wired (restart window) or the feature flag is off.
export const getSettingsUiWeatherAdvisorReadout = async (
  { homey }: ApiContext,
): Promise<WeatherAdvisorReadout> => {
  const host = readPelsHost(homey);
  return host ? host.getWeatherAdvisorReadout() : { kind: 'inactive' };
};

export const refreshSettingsUiDevices = async ({ homey }: ApiContext): Promise<SettingsUiDevicesPayload> => {
  const host = readPelsHost(homey);
  if (!host) throw appNotReadyError('Refresh devices');
  await host.refreshTargetDevicesSnapshot();
  return getSettingsUiDevicesPayload({ homey });
};

export const refreshSettingsUiPrices = async ({ homey }: ApiContext): Promise<SettingsUiPricesPayload> => {
  const coordinator = readPelsHost(homey)?.priceCoordinator;
  if (!coordinator) throw appNotReadyError('Refresh prices');
  await coordinator.refreshSpotPrices(true);
  return getSettingsUiPricesPayload({ homey });
};

export const refreshSettingsUiGridTariff = async ({ homey }: ApiContext): Promise<SettingsUiPricesPayload> => {
  const coordinator = readPelsHost(homey)?.priceCoordinator;
  if (!coordinator) throw appNotReadyError('Refresh grid tariff');
  await coordinator.refreshGridTariffData(true);
  return getSettingsUiPricesPayload({ homey });
};

export const resetSettingsUiPowerStats = async ({ homey }: ApiContext): Promise<SettingsUiResetPowerStatsResponse> => {
  const host = readPelsHost(homey);
  if (!host) throw appNotReadyError('Reset power stats');
  resetPowerStatsForUi(host);
  return {
    power: getSettingsUiPower(host),
    dailyBudget: host.getDailyBudgetUiPayload(),
  };
};

/** `GET /daily_budget` — the plain read the Budget surface polls. */
export const getSettingsUiDailyBudget = ({ homey }: ApiContext): DailyBudgetUiRead => (
  readPelsHost(homey)?.getDailyBudgetUiPayload() ?? NOT_READY_DAILY_BUDGET
);

export const previewSettingsUiDailyBudgetModel = (
  { homey, body }: ApiContext & { body?: unknown },
): DailyBudgetModelPreviewResponse => {
  const host = readPelsHost(homey);
  if (!host) throw new Error('Daily budget preview is unavailable while the app is starting.');
  return host.previewDailyBudgetModel(asDailyBudgetModelSettings(body));
};

export const applySettingsUiDailyBudgetModel = (
  { homey, body }: ApiContext & { body?: unknown },
): DailyBudgetUiRead => {
  const host = readPelsHost(homey);
  if (!host) throw new Error('Daily budget cannot be applied while the app is starting.');
  return host.applyDailyBudgetModel(asDailyBudgetModelSettings(body));
};

export const logSettingsUiMessage = ({ homey, body }: ApiContext & { body?: unknown }): { ok: boolean } => {
  const host = readPelsHost(homey);
  if (!isValidLogRequest(body)) {
    host?.error('Settings UI log API called without a valid payload');
    return { ok: false };
  }

  const message = formatSettingsUiMessage(body);
  if (body.level === 'error') {
    host?.error(message, new Error(body.detail || body.message));
  } else if (body.level === 'warn') {
    host?.log(`Warning: ${message}`);
  } else {
    host?.log(message);
  }

  return { ok: true };
};
