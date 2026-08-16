import {
  SETTINGS_UI_HOMES_PATH,
  type SettingsUiHomesPayload,
} from '../../../contracts/src/settingsUiHomes.ts';
import {
  composeHomeBadgeLabel,
  composeHomeBadgeTooltip,
} from '../../../shared-domain/src/homesManagementCopy.ts';
import { resolveHomeAreaDisplayName } from '../../../shared-domain/src/homeNames.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { setTooltip } from './tooltips.ts';

/**
 * Meter-area home badges for the Devices list and device-detail context.
 *
 * Neither list can carry the badge in its own payload: `SettingsUiDeviceListItem`
 * has no home field and its render is synchronous. Membership therefore
 * arrives out of band from `ui_homes` and is retained as a resolved index.
 * Modes uses `homeScope.ts` instead because it intentionally filters by owner.
 *
 * Gated on `runtimeActive`: `ui_homes` diagnostics describe SAVED configuration
 * even while the control port is held all-main (a pre-GA config the owner has
 * not re-saved). `getHomeIdForDevice` returns Main for every device in that
 * posture, so badging areas would state something the runtime is not doing.
 */

type HomeBadgeIndex = {
  /** Sub-home id → the owner's own name for that meter area. */
  areaNameByHomeId: Record<string, string>;
  /** Device id → the sub-home that owns it. Absent ⇒ the Main home. */
  areaHomeIdByDeviceId: Record<string, string>;
};

/** No active meter area ⇒ no badges at all (the single-home install). */
const NO_BADGES: HomeBadgeIndex = { areaNameByHomeId: {}, areaHomeIdByDeviceId: {} };

let index: HomeBadgeIndex = NO_BADGES;

// Monotonic refresh id. The device-list fetch (`getTargetDevices`) and a
// `homes_config`/`device_home_assignments` notification can start overlapping
// `ui_homes` reads, and they may settle out of order — an older answer landing
// last would overwrite the newer index and badge rows from a stale membership
// view. Same pattern as `rosterGeneration` in `homeScope.ts`.
let refreshGeneration = 0;

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const asArray = (value: unknown): readonly unknown[] | null => (
  Array.isArray(value) ? value as readonly unknown[] : null
);

const asNonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

/**
 * Sub-home id → display name. The id must be usable, but the NAME goes through
 * the canonical blank-name rule instead of a validity gate: persisted areas may
 * legitimately carry an empty or whitespace-only name (`normalizeSubHome`
 * accepts any string), and the terminology contract says every such area reads
 * "Meter area" — dropping it would silently strip a valid area's badge, and
 * admitting raw whitespace would render an invisible label.
 */
const resolveAreaNames = (homes: readonly unknown[]): Record<string, string> => {
  const names: Record<string, string> = {};
  homes.forEach((entry) => {
    const home = asRecord(entry);
    const homeId = asNonEmptyString(home?.homeId);
    const name = home?.name;
    if (homeId !== null && typeof name === 'string') {
      names[homeId] = resolveHomeAreaDisplayName(name);
    }
  });
  return names;
};

/**
 * Semantic result of one `ui_homes` read: only a `resolved` read may reshape
 * the module's badge index; `unavailable` keeps the last-good one.
 */
type HomeBadgeRead =
  | { status: 'resolved'; index: HomeBadgeIndex }
  | { status: 'unavailable' };

/**
 * Boundary resolution of the untrusted `ui_homes` read. A membership entry
 * naming a home the payload does not list is dropped rather than badged with
 * an id — the device then reads as Main home, which is what an unresolvable
 * membership means for the meter it counts against.
 */
export const resolveHomeBadgeRead = (payload: unknown): HomeBadgeRead => {
  const record = asRecord(payload);
  // A degraded snapshot (`configDegraded`) is the runtime saying it cannot
  // vouch for what it served: `homes`/membership may be a stale or empty cache
  // while real meter areas are still persisted. Trusting it would re-badge
  // every device as Main home — the same lie as a failed read, so it gets the
  // same abandon-grace (keep the last-good index). Only a literal `false` is a
  // vouch: a junk or flagless payload is not an affirmation of health. Same
  // rule as the roster resolver in `homeScope.ts`.
  if (record === null || record.configDegraded !== false) return { status: 'unavailable' };
  const { runtimeActive, hasSubHomes } = record;
  // A payload vouched healthy but MISSING a flag (or carrying a non-boolean
  // one) is partial/malformed — version skew or a truncated serve, not an
  // affirmation that no areas are active. Resolving it would clear every badge,
  // so it gets the same abandon-grace as the degraded path above.
  if (typeof runtimeActive !== 'boolean' || typeof hasSubHomes !== 'boolean') {
    return { status: 'unavailable' };
  }
  // Vouched-for reads the runtime is intentionally not badging: a held pre-GA
  // config (`runtimeActive` false) or a single-home install. These RESOLVE to
  // the empty index — clearing stale badges is correct here.
  if (!runtimeActive || !hasSubHomes) {
    return { status: 'resolved', index: NO_BADGES };
  }
  // Past this point the flags AFFIRM active meter areas, so the collections
  // that carry them have to be there. A missing/non-array `homes` or a
  // missing/non-object `membershipByDeviceId` is a truncated or version-skewed
  // serve, not a home without areas: the first would clear every badge and the
  // second would re-badge every device as Main home, both from data the payload
  // never actually carried. Same abandon-grace as the malformed-flag path.
  const homes = asArray(record.homes);
  const membership = asRecord(record.membershipByDeviceId);
  if (homes === null || membership === null) return { status: 'unavailable' };
  const areaNameByHomeId = resolveAreaNames(homes);
  // `hasSubHomes` promised at least one area and not one entry survived
  // resolution — the collection contradicts its own flags, which is the same
  // defect as a missing one, so it keeps the last-good index rather than
  // clearing every badge.
  if (Object.keys(areaNameByHomeId).length === 0) return { status: 'unavailable' };
  const areaHomeIdByDeviceId: Record<string, string> = {};
  Object.entries(membership).forEach(([deviceId, entry]) => {
    const homeId = asNonEmptyString(asRecord(entry)?.homeId);
    // Own-key guard: an inherited-property id ('constructor', …) must read as
    // an unlisted home, never resolve Object.prototype machinery.
    if (homeId !== null && Object.hasOwn(areaNameByHomeId, homeId)) {
      areaHomeIdByDeviceId[deviceId] = homeId;
    }
  });
  return { status: 'resolved', index: { areaNameByHomeId, areaHomeIdByDeviceId } };
};

/**
 * Refetch the membership view. Never rejects and never blanks the index on a
 * failed or degraded read: a transient failure must not silently re-badge
 * every device as Main home. Device loading deliberately does not await this
 * optional metadata request; it repaints the badge-bearing lists when the
 * refresh settles.
 */
export const refreshHomeBadges = async (): Promise<void> => {
  refreshGeneration += 1;
  const generation = refreshGeneration;
  try {
    const read = resolveHomeBadgeRead(await callApi<SettingsUiHomesPayload>('GET', SETTINGS_UI_HOMES_PATH));
    // A newer refresh started while this one was in flight; its answer wins.
    // Applying this stale one could repaint badges from a pre-edit membership.
    if (generation !== refreshGeneration) return;
    // `unavailable` (degraded or junk payload) keeps the last-good index —
    // the same abandon-grace as the failed-read path below. Not logged: the
    // boot window legitimately serves a degraded snapshot on every load.
    if (read.status === 'resolved') index = read.index;
  } catch (error) {
    await logSettingsError('Failed to load meter areas for device badges', error, 'homeBadges');
  }
};

/**
 * Whether the device belongs to a meter area per the last-good membership
 * index. Gates the device-detail honest states (diagnostics + activity log are
 * the MAIN home's recorders, so an area device would otherwise serve an empty
 * payload that reads as healthy). Inherits the index's own gating: a held
 * pre-GA config or a single-home install resolves every device to `false`.
 */
export const isDeviceInMeterArea = (deviceId: string): boolean => (
  // Own-key guard as in `resolveHomeBadge`: an inherited-property device id
  // must read as Main home, never resolve Object.prototype machinery.
  Object.prototype.hasOwnProperty.call(index.areaHomeIdByDeviceId, deviceId)
);

type HomeBadge = { label: string; tooltip: string };

/** `null` ⇒ this install badges nothing (no meter area is in use). */
export const resolveHomeBadge = (deviceId: string): HomeBadge | null => {
  if (Object.keys(index.areaNameByHomeId).length === 0) return null;
  // Own-key guard again: a device id colliding with an inherited property must
  // read as Main home, not resolve Object.prototype machinery.
  const homeId = Object.prototype.hasOwnProperty.call(index.areaHomeIdByDeviceId, deviceId)
    ? index.areaHomeIdByDeviceId[deviceId]
    : null;
  const areaName = homeId === null ? null : index.areaNameByHomeId[homeId];
  return { label: composeHomeBadgeLabel(areaName), tooltip: composeHomeBadgeTooltip(areaName) };
};

/**
 * Append the device's home badge to a row's name cell; a no-op on a
 * single-home install, so neither list changes shape until an area is in use.
 * A quiet outline chip — structural metadata, not a state signal — bounded by
 * `.pels-home-badge` because an area name is unbounded user input.
 */
export const appendHomeBadge = (container: HTMLElement, deviceId: string): void => {
  const badge = resolveHomeBadge(deviceId);
  if (badge === null) return;
  const chip = document.createElement('span');
  chip.className = 'plan-chip pels-home-badge';
  chip.dataset.tone = 'outline';
  chip.textContent = badge.label;
  setTooltip(chip, badge.tooltip);
  container.appendChild(chip);
};
