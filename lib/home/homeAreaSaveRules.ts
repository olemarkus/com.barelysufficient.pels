/**
 * What makes an area upsert savable: the rules a write through `ui_homes_save`
 * must satisfy once its resulting config is composed, answered as the typed
 * refusal the settings UI names the remedy for. The save seam
 * (`setup/settingsUiHomesApi.ts`) parses the request, refuses while the config
 * is degraded, and commits; the decision is made here, with the module that
 * owns home config.
 */
import type {
  SettingsUiHomesSaveRefusal,
  SettingsUiHomesSaveRequest,
} from '../../packages/contracts/src/settingsUiHomes';
import {
  findHomeAreaNameRejection,
  HOME_AREA_MAX_COUNT,
} from '../../packages/shared-domain/src/homeAreaConfigRules';
import type { ConfiguredPowerSourceRead } from '../ports/configuredPowerSource';
import {
  findMainMeterCollision,
  findNestedSubHomeRoots,
  generateHomeId,
  hasUniqueSubHomeMeters,
  type SubHomeConfig,
  type ZoneTree,
} from './homeConfig';
import { readMainMeterSelection, type MainMeterSelectionSettings } from './mainMeterSelection';

/** The area an upsert request names, as the save seam parsed it. */
export type AreaUpsertRequest = Extract<SettingsUiHomesSaveRequest, { op: 'upsert' }>['area'];

/** An area upsert composed onto the persisted list. */
export type ComposedAreaUpsert = {
  /** The area list the write would persist. */
  subHomes: SubHomeConfig[];
  /** The one entry being written, as it appears in `subHomes`. */
  upserted: SubHomeConfig;
  /** Whether this upsert adds an area rather than replacing one. */
  growsList: boolean;
};

/**
 * Apply one upsert to the persisted list. Id allocation is the runtime's
 * (create = absent id); an upsert with a vanished id honestly re-adds the area
 * — the UI's "Add again" semantics.
 */
export const composeAreaUpsert = (
  current: readonly SubHomeConfig[],
  area: AreaUpsertRequest,
): ComposedAreaUpsert => {
  const homeId = area.homeId ?? generateHomeId(current.map((entry) => entry.homeId));
  const upserted: SubHomeConfig = {
    homeId, name: area.name, rootZoneId: area.rootZoneId, meterDeviceId: area.meterDeviceId,
  };
  const replacesExisting = current.some((existing) => existing.homeId === homeId);
  return {
    upserted,
    subHomes: replacesExisting
      ? current.map((existing) => (existing.homeId === homeId ? upserted : existing))
      : [...current, upserted],
    growsList: !replacesExisting,
  };
};

/** Whether an area upsert would swallow the whole known zone forest. */
export const isAreaRootAtForestRoot = (
  area: AreaUpsertRequest,
  zoneTree: ZoneTree | null,
): boolean => zoneTree !== null && zoneTree[area.rootZoneId]?.parent === null;

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
 * limited). The power-source save enforces the same exclusion from the other
 * side. The refusal order is deliberate: on Flow the whole-home meter picker is
 * hidden, so `main_meter_required` would name a control the owner cannot
 * reach — the source refusal is the one with an actionable remedy.
 *
 * No activation gate is needed on this path: every upsert commits
 * `activationVersion`, so a save through here always leaves multi-home running.
 */
const findMeterOwnershipRefusal = (
  subHomes: readonly SubHomeConfig[],
  settings: MainMeterSelectionSettings,
  readPowerSource: () => ConfiguredPowerSourceRead,
): SettingsUiHomesSaveRefusal | null => {
  if (!hasUniqueSubHomeMeters(subHomes)) return { ok: false, reason: 'invalid' };
  const powerSource = readPowerSource();
  // A suspect source read cannot decide whether the save is allowed at all
  // (an upsert always results in at least one area), and guessing either way
  // is a wrong answer: refuse and let the owner retry.
  if (powerSource.state === 'suspect') return { ok: false, reason: 'degraded' };
  if (powerSource.value === 'flow') return { ok: false, reason: 'homey_energy_required' };
  const mainMeter = readMainMeterSelection(settings);
  if (mainMeter.state === 'resolved') {
    return findMainMeterCollision(mainMeter.meterDeviceId, subHomes) !== null
      ? { ok: false, reason: 'invalid' }
      : null;
  }
  // `unavailable` covers both a legacy Automatic install whose owner has not
  // picked a meter yet (the boot-time sole-meter adoption fills it when
  // Homey Energy lists exactly one whole-home meter) and a transient read
  // miss of a configured meter. The picker remedy is actionable in both —
  // re-picking shows the truth on a transient miss — where a `degraded`
  // "try again" would loop forever on the persistent legacy shape.
  return { ok: false, reason: 'main_meter_required' };
};

/**
 * Every invariant an area upsert must satisfy once its resulting config is
 * composed; `null` means the write is savable. Returns the typed refusal
 * rather than a bare boolean so the settings UI can name the one thing to fix
 * instead of "couldn't save".
 *
 * Meter ownership and the area count are properties of the whole list; the
 * name rules judge `upserted` alone (see `findHomeAreaNameRejection`), so a
 * legacy name the owner cannot see never blocks an unrelated area's edit.
 * Root disjointness judges only the pairs `upserted` is part of, for the same
 * reason: two saved areas can come to nest when a zone moves in the Homey app,
 * which the runtime tolerates, and that pair must not refuse a third area's
 * rename.
 *
 * The meter rules read Main's meter selection through `settings` and the
 * configured power source through `readPowerSource`, each only once the rules
 * before it have passed.
 */
export const findAreaUpsertRefusal = (
  upsert: ComposedAreaUpsert,
  zoneTree: ZoneTree | null,
  settings: MainMeterSelectionSettings,
  readPowerSource: () => ConfiguredPowerSourceRead,
): SettingsUiHomesSaveRefusal | null => {
  const { subHomes, upserted, growsList } = upsert;
  const meterRefusal = findMeterOwnershipRefusal(subHomes, settings, readPowerSource);
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
  if (zoneTree === null) return null;
  const upsertedOverlaps = findNestedSubHomeRoots({ subHomes }, zoneTree).some(
    ({ outerHomeId, innerHomeId }) => outerHomeId === upserted.homeId || innerHomeId === upserted.homeId,
  );
  return upsertedOverlaps ? { ok: false, reason: 'invalid' } : null;
};
