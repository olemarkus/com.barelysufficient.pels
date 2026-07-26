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
  type SubHomeConfig,
  type ZoneTree,
} from '../lib/home/homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../lib/utils/settingsKeys';
import {
  findHomeAreaNameRejection,
  HOME_AREA_MAX_COUNT,
} from '../packages/shared-domain/src/homeAreaConfigRules';
import { createHomesStore } from './homeRegistryAdapter';
import { readMainMeterSelection } from './mainMeterSettings';
import { readConfiguredPowerSource } from './powerSourceSettings';

type MainMeterSaveRequest = Extract<SettingsUiHomesSaveRequest, { op: 'set_main_meter' }>;
type AreaMutationRequest = Exclude<SettingsUiHomesSaveRequest, MainMeterSaveRequest>;

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
 * meter. On Automatic a Homey Energy home reads the combined total of every
 * meter as the Main home's, so Main home devices would be limited by an area's
 * usage. The settings UI already nudges (`HOMES_MAIN_METER_NOTICE`); this is
 * the config invariant behind the nudge.
 *
 * Deliberately gated on the Homey Energy power source, because that is the
 * only source where a whole-home meter selection exists at all: the picker is
 * hidden on the Flow source, so demanding it there would be a refusal with no
 * control to act on. (The Flow source has its own, separate problem with
 * areas: a Flow power reading carries no meter identity, so an area gets no
 * samples. That exclusion is tracked in TODO.md, not papered over here.)
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
  const mainMeter = readMainMeterSelection(homey.settings);
  // Unavailable = the persisted selection could not be read, which is a
  // degraded store, not a bad payload. Never guess Automatic from it.
  if (mainMeter.state === 'unavailable') return { ok: false, reason: 'degraded' };
  if (findMainMeterCollision(mainMeter.meterDeviceId, subHomes) !== null) {
    return { ok: false, reason: 'invalid' };
  }
  if (subHomes.length === 0 || mainMeter.meterDeviceId !== null) return null;
  const powerSource = readConfiguredPowerSource(homey.settings);
  // A suspect source read cannot decide whether the requirement applies, and
  // guessing either way is a wrong answer: refuse and let the owner retry.
  if (powerSource.state === 'suspect') return { ok: false, reason: 'degraded' };
  if (powerSource.value !== 'homey_energy') return null;
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
  // back to Automatic while meter areas are RUNNING would make the Main home
  // read every area's meter as its own. A saved pre-GA config that multi-home
  // is deliberately holding dormant is not running, and its combined total is
  // simply the whole home, so it must not block Automatic. No power-source
  // gate here, unlike the area path: this endpoint is only reachable from the
  // Whole-home meter picker, which renders on the Homey Energy source alone.
  //
  // Only this branch consults activation, so picking an explicit meter — the
  // remedy every other refusal names — can never itself be blocked.
  if (request.meterDeviceId === null && subHomes.length > 0) {
    // The activation MARKER travels in the same fresh read as `subHomes`, so
    // an upsert that just activated this config is visible here even while the
    // membership recompute it queued is still pending — the latched snapshot
    // would still say "not running" in that window, and consulting it first
    // would let Automatic persist moments before the area controllers start.
    if (config.activationVersion === HOME_CONFIG_ACTIVATION_VERSION) {
      return { ok: false, reason: 'main_meter_required' };
    }
    // No marker: dormant, or activated only through the retired legacy flag.
    // That discrimination is the membership service's latched answer; unknown
    // activation refuses rather than guesses, because the legacy flag's own
    // read fails closed to `false`, which HERE would read as "not running" and
    // would silently permit exactly the save this exists to refuse.
    if (activation.state === 'unavailable') return { ok: false, reason: 'degraded' };
    if (activation.runtimeActive) return { ok: false, reason: 'main_meter_required' };
  }
  const collision = findMainMeterCollision(request.meterDeviceId, subHomes);
  if (collision !== null) {
    return { ok: false, reason: 'meter_in_use', otherName: collision.name };
  }
  homey.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, request.meterDeviceId);
  return { ok: true };
};
