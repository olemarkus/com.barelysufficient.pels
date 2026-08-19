import type Homey from 'homey';
import type {
  SettingsUiHomesSaveRefusal,
  SettingsUiHomesSaveRequest,
  SettingsUiHomesSaveResponse,
} from '../packages/contracts/src/settingsUiHomes';
import {
  findMainMeterCollision,
  findNestedSubHomeRoots,
  hasUniqueSubHomeMeters,
  HOME_CONFIG_ACTIVATION_VERSION,
  type HomeConfig,
  type SubHomeConfig,
  type ZoneTree,
} from '../lib/home/homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID, POWER_SOURCE } from '../lib/utils/settingsKeys';
import {
  findHomeAreaNameRejection,
  HOME_AREA_MAX_COUNT,
} from '../packages/shared-domain/src/homeAreaConfigRules';
import { createHomesStore } from './homeRegistryAdapter';
import { readMainMeterSelection } from './mainMeterSettings';
import { readConfiguredPowerSource } from './powerSourceSettings';

type MainMeterSaveRequest = Extract<SettingsUiHomesSaveRequest, { op: 'set_main_meter' }>;
type PowerSourceSaveRequest = Extract<SettingsUiHomesSaveRequest, { op: 'set_power_source' }>;
type AreaMutationRequest = Exclude<SettingsUiHomesSaveRequest, MainMeterSaveRequest | PowerSourceSaveRequest>;

/**
 * Multi-home activation as the membership service latched it, passed in rather
 * than re-resolved: `HomeMembershipDiagnostics.runtimeActive` is the producer's
 * answer and its contract says consumers must not re-read the retired legacy
 * flag (`setup/multiHomeActivation.ts`). `unavailable` is the boot window, when
 * no service is wired and the answer is genuinely unknown.
 */
export type MultiHomeActivationRead =
  | { state: 'resolved'; runtimeActive: boolean }
  | { state: 'unavailable' };

/**
 * The producer-latched answer to "can the whole-home meter be named?"
 * (`HomeMembershipDiagnostics.mainMeterArrangement`): `identified` when a read
 * proved an id-bearing whole-home meter, `idless_aggregate_only` when the
 * report's only cumulative item carries no id AND no other id-bearing meter
 * item exists to name instead, `unknown` before any proof.
 * Passed in like activation, never re-derived from a live poll here.
 */
export type MainMeterArrangement = 'unknown' | 'identified' | 'idless_aggregate_only';

/**
 * Cross-store meter ownership guard for a freshly composed area list, plus the
 * requirement that once ANY meter area exists the Main home names its own
 * meter. Automatic cannot prove which of several whole-home candidates belongs
 * to Main. Requiring an explicit selection prevents a valid saved configuration
 * from ever assigning Automatic's sampled candidate to a meter area as well.
 * The settings UI already nudges (`HOMES_MAIN_METER_NOTICE`); this is the config
 * invariant behind the nudge.
 *
 * The Flow source is refused outright before that requirement is even asked:
 * meter areas and the Flow power source are mutually exclusive (a Flow power
 * reading carries no meter identity, so an area gets no samples and is never
 * limited). `savePowerSourceSelection` enforces the same exclusion from the
 * other side. The refusal order is deliberate: on Flow the whole-home meter
 * picker is hidden, so `main_meter_required` would name a control the owner
 * cannot reach — the source refusal is the one with an actionable remedy.
 *
 * No activation gate is needed on this path: every upsert commits
 * `activationVersion`, so a save through here always leaves multi-home running.
 */
const findMeterOwnershipRefusal = (
  homey: Homey.App['homey'],
  subHomes: readonly SubHomeConfig[],
  mainMeterArrangement: MainMeterArrangement,
): SettingsUiHomesSaveRefusal | null => {
  if (!hasUniqueSubHomeMeters(subHomes)) return { ok: false, reason: 'invalid' };
  const powerSource = readConfiguredPowerSource(homey.settings);
  // A suspect source read cannot decide whether the save is allowed at all
  // (an upsert always results in at least one area), and guessing either way
  // is a wrong answer: refuse and let the owner retry.
  if (powerSource.state === 'suspect') return { ok: false, reason: 'degraded' };
  if (powerSource.value === 'flow') return { ok: false, reason: 'homey_energy_required' };
  const mainMeter = readMainMeterSelection(homey.settings);
  // Unavailable = the persisted selection could not be read, which is a
  // degraded store, not a bad payload. Never guess Automatic from it.
  if (mainMeter.state === 'unavailable') return { ok: false, reason: 'degraded' };
  if (findMainMeterCollision(mainMeter.meterDeviceId, subHomes) !== null) {
    return { ok: false, reason: 'invalid' };
  }
  if (subHomes.length === 0 || mainMeter.meterDeviceId !== null) return null;
  // On a home whose whole-home reading is a PROVEN id-less aggregate, the
  // main_meter_required remedy can never be satisfied — the picker has no
  // whole-home meter to offer. Refuse honestly instead of pointing at it.
  // `unknown` keeps the ordinary remedy: only a latched proof selects the
  // honest-state copy, never a boot window or an SDK miss.
  return mainMeterArrangement === 'idless_aggregate_only'
    ? { ok: false, reason: 'meter_unnameable' }
    : { ok: false, reason: 'main_meter_required' };
};

/** Whether an area upsert would swallow the whole known zone forest. */
export const areaRootsAtForestRoot = (
  request: AreaMutationRequest,
  zoneTree: ZoneTree | null,
): boolean => {
  if (request.op !== 'upsert') return false;
  return zoneTree !== null && zoneTree[request.area.rootZoneId]?.parent === null;
};

/**
 * Every invariant an area upsert must satisfy once its resulting config is
 * composed; `null` means the write is savable. Returns the typed refusal
 * rather than a bare boolean so the settings UI can name the one thing to fix
 * instead of "couldn't save".
 *
 * Meter ownership, the area count and root disjointness are properties of the
 * whole list; the name rules judge `upserted` alone (see
 * `findHomeAreaNameRejection`), so a legacy name the owner cannot see never
 * blocks an unrelated area's edit.
 */
export const findComposedHomeInvariantViolation = (
  homey: Homey.App['homey'],
  params: {
    /** The area list the write would persist. */
    subHomes: readonly SubHomeConfig[];
    /** The one entry being written, as it appears in `subHomes`. */
    upserted: SubHomeConfig;
    /** Whether this upsert adds an area rather than replacing one. */
    growsList: boolean;
    /** Producer-latched nameability of the whole-home meter. */
    mainMeterArrangement: MainMeterArrangement;
    zoneTree: ZoneTree | null;
  },
): SettingsUiHomesSaveRefusal | null => {
  const {
    subHomes, upserted, growsList, mainMeterArrangement, zoneTree,
  } = params;
  const meterRefusal = findMeterOwnershipRefusal(homey, subHomes, mainMeterArrangement);
  if (meterRefusal !== null) return meterRefusal;
  // The cap bounds GROWTH, so it never blocks repairing a config that is
  // already over it. Nothing capped `homes_config` before this seam did, and an
  // over-cap install that could not rename or re-meter an area without first
  // deleting one would be a dead end the cap buys nothing for.
  if (growsList && subHomes.length > HOME_AREA_MAX_COUNT) {
    return { ok: false, reason: 'area_limit_reached', maxCount: HOME_AREA_MAX_COUNT };
  }
  const nameRejection = findHomeAreaNameRejection({
    name: upserted.name,
    otherNames: subHomes
      .filter(({ homeId }) => homeId !== upserted.homeId)
      .map(({ name }) => name),
  });
  if (nameRejection !== null) return { ok: false, ...nameRejection };
  return zoneTree !== null && findNestedSubHomeRoots({ subHomes: [...subHomes] }, zoneTree).length > 0
    ? { ok: false, reason: 'invalid' }
    : null;
};

/**
 * Whether the freshly read config's areas are RUNNING, for the two saves that
 * must not proceed while they are (Automatic, and the Flow source). A saved
 * pre-GA config that multi-home is deliberately holding dormant is not
 * running and must not block either save.
 *
 * The activation MARKER travels in the same fresh read as `subHomes`, so an
 * upsert that just activated this config is visible here even while the
 * membership recompute it queued is still pending — the latched snapshot
 * would still say "not running" in that window, and consulting it first
 * would let the save persist moments before the area controllers start.
 *
 * No marker: dormant, or activated only through the retired legacy flag.
 * That discrimination is the membership service's latched answer; `unknown`
 * refuses rather than guesses, because the legacy flag's own read fails
 * closed to `false`, which HERE would read as "not running" and would
 * silently permit exactly the save the caller exists to refuse.
 */
const classifyAreasRunning = (
  config: HomeConfig,
  activation: MultiHomeActivationRead,
): 'running' | 'dormant' | 'unknown' => {
  if (config.subHomes.length === 0) return 'dormant';
  if (config.activationVersion === HOME_CONFIG_ACTIVATION_VERSION) return 'running';
  if (activation.state === 'unavailable') return 'unknown';
  return activation.runtimeActive ? 'running' : 'dormant';
};

/**
 * Validate + persist Main's selection in one synchronous server turn. Sharing
 * the ui_homes_save intent seam with area mutations means either concurrent
 * arrival order observes the first owner and refuses the second.
 */
export const saveMainMeterSelection = (
  homey: Homey.App['homey'],
  request: MainMeterSaveRequest,
  activation: MultiHomeActivationRead,
): SettingsUiHomesSaveResponse => {
  const read = createHomesStore(homey).read();
  if (read.state === 'suspect') return { ok: false, reason: 'degraded' };
  const config = read.state === 'present' ? read.value : { subHomes: [] };
  const { subHomes } = config;
  // The same requirement the area path enforces, from the other side: going
  // back to Automatic while meter areas are RUNNING would leave no proven
  // physical meter owner for the Main home. No power-source gate here, unlike
  // the area path: this endpoint is only reachable from the Whole-home meter
  // picker, which renders on the Homey Energy source alone.
  //
  // Only this branch consults activation, so picking an explicit meter — the
  // remedy every other refusal names — can never itself be blocked.
  if (request.meterDeviceId === null) {
    const running = classifyAreasRunning(config, activation);
    if (running === 'unknown') return { ok: false, reason: 'degraded' };
    if (running === 'running') return { ok: false, reason: 'main_meter_required' };
  }
  const collision = findMainMeterCollision(request.meterDeviceId, subHomes);
  if (collision !== null) {
    return { ok: false, reason: 'meter_in_use', otherName: collision.name };
  }
  homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, request.meterDeviceId);
  return { ok: true };
};

/**
 * Validate + persist the power source in the same serialized server turn as
 * area mutations, so "save an area" and "switch to Flow" cannot both land.
 * The exclusion the area path enforces, from the other side: a Flow reading
 * carries no meter identity, so RUNNING meter areas would silently stop
 * receiving samples the moment the source flips. Dormancy discrimination is
 * `classifyAreasRunning`, shared with the Automatic refusal.
 *
 * Switching TO Homey Energy never consults the homes store: it is the
 * direction every refusal's remedy lives in, and for a legacy config whose
 * areas were saved under Flow it is the only road back to a working setup.
 */
export const savePowerSourceSelection = (
  homey: Homey.App['homey'],
  request: PowerSourceSaveRequest,
  activation: MultiHomeActivationRead,
): SettingsUiHomesSaveResponse => {
  if (request.source === 'flow') {
    const read = createHomesStore(homey).read();
    if (read.state === 'suspect') return { ok: false, reason: 'degraded' };
    const config = read.state === 'present' ? read.value : { subHomes: [] };
    const running = classifyAreasRunning(config, activation);
    if (running === 'unknown') return { ok: false, reason: 'degraded' };
    if (running === 'running') return { ok: false, reason: 'homey_energy_required' };
  }
  homey.settings.set(POWER_SOURCE, request.source);
  return { ok: true };
};
