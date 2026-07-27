/**
 * The INPUTS behind the aggregate simulation posture: how the saved homes
 * roster is classified, how one meter area's simulation flag is read, and how
 * a refresh's reads merge over the last-good snapshot. All boundary work —
 * every function here either resolves untrusted persisted state into a typed
 * result or reads one through the settings channel, and none of it touches the
 * DOM. The banner and Settings-hub chip that render the result live in
 * `capacity.ts`, which owns the refresh orchestration and the scope claim.
 *
 * Split out of `capacity.ts` so the capacity/limits panel keeps its form
 * concerns and this classification layer can be read (and tested) on its own.
 */

import { getSetting } from './homey.ts';
import type { MeterAreaSimulationEntry } from './state.ts';
import {
  CAPACITY_DRY_RUN,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  homeScopedSettingsKey,
  MAIN_HOME_ID,
  PELS_STATUS,
} from '../../../contracts/src/settingsKeys.ts';
import { logSettingsError } from './logging.ts';

export type HomesConfigScopeRead = {
  status: 'resolved';
  config: unknown;
  initializedMarker: unknown;
} | {
  status: 'unavailable';
};

export const resolveHasMeterAreas = (read: HomesConfigScopeRead): boolean | null => {
  if (read.status === 'unavailable') return null;
  const { config, initializedMarker } = read;
  if (config === null || config === undefined) {
    const markerAbsent = initializedMarker === null || initializedMarker === undefined;
    return markerAbsent ? false : null;
  }
  if (typeof config !== 'object' || Array.isArray(config)) return null;
  const subHomes = (config as { subHomes?: unknown }).subHomes;
  return Array.isArray(subHomes) ? subHomes.length > 0 : null;
};

/**
 * The scope claim to hold when the ROSTER read is unavailable. `false` — "this
 * install has no meter areas" — is a vouched claim only a resolved roster may
 * make. A suspect blob whose `subHomes` happens to be empty
 * (`{ activationVersion: 2, subHomes: [] }`) is unclassifiable WHOLESALE, yet
 * its empty array reads as a legitimate empty roster here and would send the
 * banner down its no-areas branch: with Main live that hides the one warning
 * naming the simulating area the caller's snapshot just retained, while the
 * hub chip keeps saying `Partly on` from that same snapshot. So a `false` off
 * a suspect read keeps the last-good claim instead. `true` and `null` are
 * adopted — both keep the cautious Main-scoped copy, so neither can overclaim.
 */
export const resolveRetainedScopeClaim = (
  lastGood: boolean | null,
  read: HomesConfigScopeRead,
): boolean | null => {
  const claim = resolveHasMeterAreas(read);
  return claim === false ? lastGood : claim;
};

export type ActiveMeterArea = { homeId: string; name: string };

// Domain validity for an area id, mirroring the runtime's `isValidSubHomeId`
// (duplicated at the architecture boundary — same rule set as homeScope.ts's
// roster classifier): never the Main sentinel, no `':'` (the separator the
// suffixed `capacity_dry_run:<id>` key rides on), never a prototype-colliding
// key. An entry failing it could never have been runtime-written.
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isValidAreaId = (value: string): boolean => (
  value.length > 0 && value !== MAIN_HOME_ID && !value.includes(':') && !DANGEROUS_RECORD_KEYS.has(value)
);

// Per-entry plausibility, mirroring the runtime's `isPlausibleSubHomeEntry`
// (`lib/home/homeConfig.ts`; duplicated at the architecture boundary like
// `isValidAreaId` above): a record with a valid area id, a string name, a
// non-empty `rootZoneId`, and an absent-or-non-empty `meterDeviceId`. The
// posture only displays id+name, but an entry malformed in ANY required
// field marks the WHOLE roster unclassifiable — see `resolveActiveMeterAreas`.
// The meter identity is carried out (normalized to flat-null absence, the
// runtime's shape) so the roster-level meter-uniqueness rule can see it.
const asPlausibleAreaEntry = (
  raw: unknown,
): (ActiveMeterArea & { meterDeviceId: string | null }) | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { homeId, name, rootZoneId, meterDeviceId } = raw as {
    homeId?: unknown; name?: unknown; rootZoneId?: unknown; meterDeviceId?: unknown;
  };
  if (typeof homeId !== 'string' || !isValidAreaId(homeId)) return null;
  if (typeof name !== 'string') return null;
  if (typeof rootZoneId !== 'string' || rootZoneId.length === 0) return null;
  if (meterDeviceId === undefined || meterDeviceId === null) {
    return { homeId, name, meterDeviceId: null };
  }
  if (typeof meterDeviceId !== 'string' || meterDeviceId.length === 0) return null;
  return { homeId, name, meterDeviceId };
};

/**
 * Discriminated roster resolution. `unavailable` marks a roster nobody can
 * vouch for this refresh — a transiently rejecting read, or a persisted blob
 * the runtime's own store classifies suspect — and the caller keeps its
 * last-good snapshot (the abandon-grace convention, distinct from a RESOLVED
 * empty roster, which legitimately clears it).
 */
export type ActiveMeterAreasRead = {
  status: 'resolved';
  areas: ActiveMeterArea[];
} | {
  status: 'unavailable';
};

const UNAVAILABLE_ROSTER: ActiveMeterAreasRead = { status: 'unavailable' };

/**
 * The GA-activated meter areas in the saved roster. A held pre-GA config
 * (plausible, but no `activationVersion`) RESOLVES to none: its devices still
 * belong to the Main home, so its per-area flags must not enter the
 * simulation posture. An absent config (never written) resolves to none the
 * same way. Suspect state is `unavailable` instead — one implausible entry,
 * a duplicate area id, or a meter shared across areas marks the roster
 * unclassifiable WHOLESALE, matching the runtime's
 * `isPlausibleHomesConfigBlob` (which enforces `hasUniqueSubHomeMeters` too):
 * a partially corrupt roster must never resolve to a quietly smaller one that
 * drops an area from the simulation posture, nor wipe the last-good snapshot
 * the caller holds.
 */
export const resolveActiveMeterAreas = (read: HomesConfigScopeRead): ActiveMeterAreasRead => {
  if (read.status === 'unavailable') return UNAVAILABLE_ROSTER;
  const { config } = read;
  if (config === null || config === undefined) return { status: 'resolved', areas: [] };
  if (typeof config !== 'object' || Array.isArray(config)) return UNAVAILABLE_ROSTER;
  const { activationVersion, subHomes } = config as { activationVersion?: unknown; subHomes?: unknown };
  if (activationVersion !== undefined && activationVersion !== 1) return UNAVAILABLE_ROSTER;
  if (!Array.isArray(subHomes)) return UNAVAILABLE_ROSTER;
  const resolved: ActiveMeterArea[] = [];
  const assignedMeterIds = new Set<string>();
  for (const entry of subHomes) {
    const area = asPlausibleAreaEntry(entry);
    if (area === null || resolved.some((prior) => prior.homeId === area.homeId)) {
      return UNAVAILABLE_ROSTER;
    }
    if (area.meterDeviceId !== null) {
      if (assignedMeterIds.has(area.meterDeviceId)) return UNAVAILABLE_ROSTER;
      assignedMeterIds.add(area.meterDeviceId);
    }
    resolved.push({ homeId: area.homeId, name: area.name });
  }
  return { status: 'resolved', areas: activationVersion === 1 ? resolved : [] };
};

export const readHomesConfigScope = async (
  readSetting: (key: string) => Promise<unknown> = getSetting,
): Promise<HomesConfigScopeRead> => {
  const [configRead, markerRead] = await Promise.allSettled([
    readSetting(HOMES_CONFIG),
    readSetting(HOMES_CONFIG_INITIALIZED),
  ]);
  if (configRead.status === 'rejected' || markerRead.status === 'rejected') {
    return { status: 'unavailable' };
  }
  return {
    status: 'resolved',
    config: configRead.value,
    initializedMarker: markerRead.value,
  };
};

/**
 * One area flag read, discriminated at the settings boundary. `resolved` is a
 * written boolean. `absent` is a genuinely unset key — trustworthy evidence,
 * but WHAT it means depends on history: the runtime adapter resolves every
 * non-boolean (absence included) to its last-good `dryRun`
 * (`setup/capacitySettingsStoreAdapter.ts`), and only a bundle with no history
 * boots into the dry-run-TRUE default. `unavailable` is a transient read
 * failure or a malformed persisted value — exactly what the runtime's own
 * store refuses to adopt — so the caller keeps the area's last resolved
 * posture instead of announcing a simulation the runtime isn't doing, or a
 * control it isn't exercising.
 *
 * That last-good lives in the RUNNING bundle, which outlives every WebView:
 * a reload starts with no UI history at all, so neither non-boolean arm can
 * be read as the boot default on its own. Both therefore carry
 * `runtimeSimulating` — the runtime's own effective posture for the area —
 * so the merge below can ask the bundle instead of guessing.
 */
export type AreaSimulationFlagRead = {
  status: 'resolved';
  simulating: boolean;
} | {
  status: 'absent';
  runtimeSimulating: boolean | null;
} | {
  status: 'unavailable';
  runtimeSimulating: boolean | null;
};

/**
 * The runtime's own effective posture for one meter area, read from the
 * `pels_status:<homeId>` blob its plan writer persists. `dryRunEffective` is
 * the membership-gated switch the bundle actually acts on — the same field
 * the area's Limits card prefers over the persisted intent — so it answers
 * the one question an unset or malformed flag leaves open: is that RUNNING
 * bundle simulating? Every absence is `null` (no claim, never a fabricated
 * one): no blob written yet, a blob predating the field, junk, or a rejected
 * read.
 */
const readAreaRuntimeSimulating = async (homeId: string): Promise<boolean | null> => {
  try {
    const raw = await getSetting(homeScopedSettingsKey(PELS_STATUS, homeId));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const { dryRunEffective } = raw as { dryRunEffective?: unknown };
    return typeof dryRunEffective === 'boolean' ? dryRunEffective : null;
  } catch (caught) {
    await logSettingsError('Failed to read a meter-area runtime posture', caught, 'capacity');
    return null;
  }
};

export const readAreaSimulationFlag = async (homeId: string): Promise<AreaSimulationFlagRead> => {
  let raw: unknown;
  try {
    raw = await getSetting(homeScopedSettingsKey(CAPACITY_DRY_RUN, homeId));
  } catch (caught) {
    await logSettingsError('Failed to read a meter-area simulation flag', caught, 'capacity');
    // A REJECTED read is the settings channel itself failing; asking it for
    // the status blob would just fail again (and log twice). The malformed
    // and unset paths below are a working channel with nothing to say, so
    // those do consult the runtime.
    return { status: 'unavailable', runtimeSimulating: null };
  }
  if (typeof raw === 'boolean') return { status: 'resolved', simulating: raw };
  const runtimeSimulating = await readAreaRuntimeSimulating(homeId);
  return raw === null || raw === undefined
    ? { status: 'absent', runtimeSimulating }
    : { status: 'unavailable', runtimeSimulating };
};

/**
 * One refresh's roster + flag reads merged over the previous snapshot.
 * Exported pure for tests. A non-boolean read keeps the area's last resolved
 * value first — the runtime adapter's own rule (`typeof dryRun === 'boolean'
 * ? dryRun : fallback.dryRun`), and the abandon-grace convention: one unset
 * or bad read must never flip the posture to "everything is live", overclaim
 * `On`, or drop the only warning naming a simulating area.
 *
 * With NO history the runtime's own published posture answers next. Every
 * WebView reload starts there while the bundle holding the runtime's last-good
 * keeps running, so an area that was switched live before its flag was unset
 * must not be repainted as simulating just because this WebView is new.
 *
 * Only when the runtime is silent too do the two non-boolean reads part ways:
 * `absent` is trustworthy never-written evidence and takes the runtime's
 * dry-run-TRUE boot default (a fresh area nobody has switched live, whose
 * bundle has published nothing yet), while `unavailable` carries an explicit
 * unknown (`null`), which blocks both absolute posture claims. Matching is by
 * `homeId` so a rename keeps its last-good value while adopting the new name.
 */
export const mergeMeterAreaSimulation = (
  activeAreas: readonly ActiveMeterArea[],
  flags: ReadonlyArray<AreaSimulationFlagRead>,
  previous: readonly MeterAreaSimulationEntry[],
): MeterAreaSimulationEntry[] => activeAreas.map((area, index) => {
  const read = flags[index] ?? { status: 'unavailable' as const, runtimeSimulating: null };
  if (read.status === 'resolved') {
    return { homeId: area.homeId, name: area.name, simulating: read.simulating };
  }
  const lastGood = previous.find((entry) => entry.homeId === area.homeId)?.simulating ?? null;
  const bootDefault = read.status === 'absent' ? true : null;
  return {
    homeId: area.homeId,
    name: area.name,
    simulating: lastGood ?? read.runtimeSimulating ?? bootDefault,
  };
});
