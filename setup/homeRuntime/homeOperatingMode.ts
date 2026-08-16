/**
 * The stateless, owner-aware device-support operating-mode reader.
 *
 * Main uses the historical unsuffixed catalog. Initialized meter areas own
 * suffixed aliases, priorities, targets, and active mode; before initialization
 * they deliberately follow Main as a compatibility fallback. Registered bundles
 * read the active mode through `HomeModeCatalog`; this module serves the
 * owner-aware device-support resolver used outside a registered bundle.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import {
  resolveHomeOperatingMode,
  type HomeOperatingModeResolution,
} from '../../lib/utils/capacityHelpers';
import {
  homeScopedSettingsKey,
  MAIN_HOME_ID,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { readPersistedHomeModeCatalog } from './homeModeCatalog';

/**
 * The pin read classified AT this adapter boundary. A thrown read, a fulfilled
 * `undefined` for an existing key, or a store-wide empty `getKeys()` result is
 * typed as suspect rather than absence. Only a healthy non-empty key list that
 * omits the pin proves a genuine unpin. An escaping/misclassified read could
 * abort the mode-change fan-out or rebuild a silent-meter area on global
 * targets indefinitely.
 */
type HomeOperatingModeReadSuspectReason =
  | 'read_failed'
  | 'missing_existing_key'
  | 'empty_key_list'
  | 'malformed_key_list';

type HomeOperatingModeReadOutcome =
  | { state: 'resolved'; resolution: HomeOperatingModeResolution }
  | { state: 'suspect'; reason: 'read_failed'; error: unknown }
  | {
    state: 'suspect';
    reason: Exclude<HomeOperatingModeReadSuspectReason, 'read_failed'>;
  };

const resolveForHome = (ctx: AppContext, homeId: HomeId): HomeOperatingModeReadOutcome => {
  const settingsKey = homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId);
  let perHomeModeRaw: unknown;
  try {
    perHomeModeRaw = ctx.homey.settings.get(settingsKey);
  } catch (error) {
    return { state: 'suspect', reason: 'read_failed', error };
  }
  // `null` remains the historical explicit absence value. `undefined` is
  // ambiguous in Homey's SDK: it can mean either an unwritten key or a
  // transient fulfilled miss for an existing key, so resolve it against the
  // live key list before handing absence inward.
  if (perHomeModeRaw === undefined) {
    let keysRaw: unknown;
    try {
      keysRaw = ctx.homey.settings.getKeys();
    } catch (error) {
      return { state: 'suspect', reason: 'read_failed', error };
    }
    if (!Array.isArray(keysRaw) || !keysRaw.every((key) => typeof key === 'string')) {
      return { state: 'suspect', reason: 'malformed_key_list' };
    }
    if (keysRaw.length === 0) return { state: 'suspect', reason: 'empty_key_list' };
    if (keysRaw.includes(settingsKey)) {
      return { state: 'suspect', reason: 'missing_existing_key' };
    }
  }
  return {
    state: 'resolved',
    resolution: resolveHomeOperatingMode({
      perHomeModeRaw,
      globalMode: ctx.operatingMode,
      resolveAlias: (name) => ctx.resolveModeName(name),
      modeDeviceTargets: ctx.modeDeviceTargets,
    }),
  };
};

/**
 * The device-scoped resolution, classified at this adapter: either the active
 * mode governing the device (`null` = no mode configured, a real domain
 * absence) or an explicit `unavailable` when the governing mode cannot be
 * known — ownership is provisional, the pin could not be read, or the pin is
 * temporarily unconfigured during a rename. The discriminant is NOT
 * decoration — this reader is stateless, so it has no last-known value to
 * hold, and its consumer PERSISTS what it derives. Substituting the global
 * mode here would be an unrecoverable wrong-mode write; the consumer must
 * decide, and skip.
 */
export type DeviceOperatingModeOutcome =
  | { state: 'resolved'; mode: string | null; homeId: HomeId; catalogHomeId: HomeId }
  | { state: 'unavailable' };

export const resolveHomeIdForModeCatalogSeed = (
  ctx: AppContext,
  deviceId: string,
): HomeId | null => {
  const membership = ctx.homeMembership;
  if (!membership) return MAIN_HOME_ID;
  return membership.isOwnershipReady() && !membership.hasPendingOwnershipGeneration()
    ? membership.getHomeIdForDevice(deviceId)
    : null;
};

const isDeviceOwnershipUnavailable = (
  membership: AppContext['homeMembership'],
  allowPendingOwnershipGeneration: boolean,
): boolean => Boolean(
  membership
  && (
    !membership.isOwnershipReady()
    || (!allowPendingOwnershipGeneration && membership.hasPendingOwnershipGeneration())
  ),
);

/**
 * The active mode governing ONE DEVICE, for device-keyed readers outside the
 * bundles (today: the overshoot default seed in `setup/appDeviceSupport.ts`).
 * Main-home devices keep that reader's historical classification byte-for-byte
 * (the RAW unsuffixed setting, un-aliased, non-blank or `null`); a sub-home
 * device resolves through the same chain its bundle plans with. Stateless on
 * purpose — no transition latch, no logging: a snapshot-refresh pass must not
 * emit mode-transition events.
 *
 * OWNERSHIP FIRST: the first device snapshot can commit before the detached
 * zone-tree fetch. Until membership reports a committed generation,
 * `getHomeIdForDevice` deliberately answers Main for an area device. Treating
 * that provisional attribution as truth would seed the global-mode default
 * permanently, so the producer returns `unavailable` until ownership settles.
 */
export const resolveOperatingModeForDevice = (
  ctx: AppContext,
  deviceId: string,
  membershipOverride?: AppContext['homeMembership'],
  allowPendingOwnershipGeneration = false,
): DeviceOperatingModeOutcome => {
  const membership = membershipOverride ?? ctx.homeMembership;
  if (isDeviceOwnershipUnavailable(membership, allowPendingOwnershipGeneration)) {
    return { state: 'unavailable' };
  }
  const homeId = membership?.getHomeIdForDevice(deviceId) ?? MAIN_HOME_ID;
  if (homeId === MAIN_HOME_ID) {
    let raw: unknown;
    try {
      raw = ctx.homey.settings.get(OPERATING_MODE_SETTING) as unknown;
    } catch {
      return { state: 'unavailable' };
    }
    return {
      state: 'resolved',
      mode: typeof raw === 'string' && raw.trim() ? raw : null,
      homeId,
      catalogHomeId: homeId,
    };
  }
  const catalog = readPersistedHomeModeCatalog(ctx, homeId);
  if (catalog.state === 'unavailable') return { state: 'unavailable' };
  if (catalog.state === 'resolved') {
    return {
      state: 'resolved',
      mode: catalog.snapshot.operatingMode,
      homeId,
      catalogHomeId: homeId,
    };
  }
  const outcome = resolveForHome(ctx, homeId);
  // A suspect pin read stays UNKNOWN to the caller — never the global mode.
  // The bundle accessor can hold its last-known effective mode; this stateless
  // reader cannot, and its consumer persists a value derived from the mode, so
  // a global-mode fallback would freeze a wrong-mode default for a pinned area
  // (later refreshes keep the entry that is already there). No logging here,
  // by design — a snapshot-refresh pass must not emit events — and nothing
  // else logs a pin fault either, so an `unconfigured_mode` or `malformed_pin`
  // pin is silent apart from the skipped seed. `HomeModeCatalog` is what a
  // registered bundle reads, and it reports its own unavailability
  // (`home_mode_catalog_unavailable`).
  if (outcome.state === 'suspect' || outcome.resolution.fault !== null) {
    return { state: 'unavailable' };
  }
  const { mode } = outcome.resolution;
  return {
    state: 'resolved',
    mode: mode.trim() ? mode : null,
    homeId,
    catalogHomeId: MAIN_HOME_ID,
  };
};
