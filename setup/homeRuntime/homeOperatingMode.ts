/**
 * Per-home operating-mode wiring (multi-home): the ONE accessor every
 * sub-home-facing reader of the active mode resolves through, so no surface is
 * left on the global mode by accident.
 *
 * Storage: `operating_mode:<homeId>` (now a `HOME_SCOPABLE_BASE_KEYS` member).
 * Resolution: the pure `resolveHomeOperatingMode` chain — per-home value →
 * global (main) mode — with the pinned mode constrained to the global
 * `mode_device_targets` key set so the planner's `[mode] || {}` lookup can
 * never collapse a pinned mode to empty targets (the stuck-cold regression
 * guard). The mode-targets and priority BLOBS stay global by design
 * (mode-name-keyed; membership partitions device ids disjointly) — only the
 * ACTIVE mode is per home.
 *
 * The accessor also carries this home's priority resolver: priorities are
 * ranked per mode, so a home on its own mode must rank devices by that mode
 * (`resolveDevicePriority`), not by main's.
 *
 * Logging is edge-triggered per accessor (one per bundle): a transition of the
 * effective mode logs `home_operating_mode_changed` naming the home, a
 * refused pinned mode logs `home_operating_mode_unconfigured`, a
 * malformed pin (non-string persisted value) logs
 * `home_operating_mode_pin_malformed`, and a suspect pin read logs
 * `home_operating_mode_read_failed` / `home_operating_mode_read_suspect` while
 * the accessor holds a last-known pin or keeps following the current global
 * mode when no pin was known — each once per distinct fault. Reads between
 * transitions stay silent, so live closures can resolve on every plan cycle
 * without log spam.
 */
import type { AppContext } from '../../lib/app/appContext';
import type { HomeId } from '../../lib/utils/settingsKeys';
import {
  resolveDevicePriority,
  resolveHomeOperatingMode,
  type HomeOperatingModeFault,
  type HomeOperatingModeResolution,
} from '../../lib/utils/capacityHelpers';
import { normalizeError } from '../../lib/utils/errorUtils';
import {
  homeScopedSettingsKey,
  MAIN_HOME_ID,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';

export type HomeOperatingModeAccessor = {
  /** This home's effective operating mode (per-home value → global default). */
  getOperatingMode: () => string;
  /** Device priority under this home's OWN effective mode. */
  getPriorityForDevice: (deviceId: string) => number;
};

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

/**
 * Resolve as if unpinned (pure — no settings read): the global-mode fallback
 * used when a suspect read leaves no last-known value to hold.
 */
const resolveUnpinned = (ctx: AppContext): HomeOperatingModeResolution => (
  resolveHomeOperatingMode({
    perHomeModeRaw: undefined,
    globalMode: ctx.operatingMode,
    resolveAlias: (name) => ctx.resolveModeName(name),
    modeDeviceTargets: ctx.modeDeviceTargets,
  })
);

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
 * One sub-home's live operating-mode accessor. Constructed once per capacity
 * bundle; every read re-resolves against the current settings/ctx state, so a
 * suffixed write, a global mode change, or a mode-targets edit is picked up by
 * the next plan cycle without any push wiring beyond the rebuild fan-out.
 */
/** One edge-trigger key per DISTINCT fault (reason + payload), null when clean. */
const faultLogKey = (fault: HomeOperatingModeFault | null): string | null => {
  if (fault === null) return null;
  return fault.reason === 'unconfigured_mode'
    ? `unconfigured_mode:${fault.requestedMode}`
    : `malformed_pin:${fault.valueType}`;
};

const logFault = (
  ctx: AppContext,
  homeId: HomeId,
  fault: HomeOperatingModeFault,
  fallbackMode: string,
): void => {
  if (fault.reason === 'unconfigured_mode') {
    ctx.getStructuredLogger('homes')?.warn({
      event: 'home_operating_mode_unconfigured',
      homeId,
      requestedMode: fault.requestedMode,
      fallbackMode,
      detail: 'pinned mode has no mode_device_targets record; following the global mode '
        + 'instead of planning with empty targets',
    });
    return;
  }
  ctx.getStructuredLogger('homes')?.warn({
    event: 'home_operating_mode_pin_malformed',
    homeId,
    valueType: fault.valueType,
    fallbackMode,
    detail: 'operating_mode:<homeId> holds a malformed non-string value; following the '
      + 'global mode fail-safe until the pin is rewritten or cleared',
  });
};

const logReadFailure = (
  ctx: AppContext,
  homeId: HomeId,
  error: unknown,
  fallbackMode: string,
): void => {
  ctx.getStructuredLogger('homes')?.warn({
    event: 'home_operating_mode_read_failed',
    homeId,
    fallbackMode,
    err: normalizeError(error),
    detail: 'operating_mode:<homeId> settings read threw; holding the last-known '
      + 'pinned mode, or following the current global mode when no pin was known, '
      + 'until a read succeeds',
  });
};

const logSuspectRead = (
  ctx: AppContext,
  homeId: HomeId,
  reason: Exclude<HomeOperatingModeReadSuspectReason, 'read_failed'>,
  fallbackMode: string,
): void => {
  ctx.getStructuredLogger('homes')?.warn({
    event: 'home_operating_mode_read_suspect',
    homeId,
    reason,
    fallbackMode,
    detail: 'operating_mode:<homeId> returned ambiguous absence evidence; holding '
      + 'the last-known pinned mode, or following the current global mode when '
      + 'no pin was known, until a healthy read proves the key absent or present',
  });
};

/** One edge-triggered fault emission per resolve: suspect read OR resolver fault. */
const logResolveFault = (
  ctx: AppContext,
  homeId: HomeId,
  outcome: HomeOperatingModeReadOutcome,
  fallbackMode: string,
): void => {
  if (outcome.state === 'suspect') {
    if (outcome.reason === 'read_failed') {
      logReadFailure(ctx, homeId, outcome.error, fallbackMode);
    } else {
      logSuspectRead(ctx, homeId, outcome.reason, fallbackMode);
    }
    return;
  }
  if (outcome.resolution.fault !== null) {
    logFault(ctx, homeId, outcome.resolution.fault, fallbackMode);
  }
};

/**
 * The contained resolution for a suspect pin read. A last-known PIN holds its
 * fixed mode, because falling back on one flaky read would swing the area's
 * targets. A last-known global follower instead keeps following the CURRENT
 * global mode: holding its old effective value would strand a silent-meter
 * area on an obsolete mode after a global mode change.
 */
const heldResolution = (
  ctx: AppContext,
  lastKnown: { mode: string; source: 'per_home' | 'global' } | null,
): HomeOperatingModeResolution => (
  lastKnown?.source === 'per_home'
    ? { mode: lastKnown.mode, source: lastKnown.source, fault: null }
    : resolveUnpinned(ctx)
);

export const createHomeOperatingModeAccessor = (
  ctx: AppContext,
  homeId: HomeId,
): HomeOperatingModeAccessor => {
  let lastLogged: { mode: string; source: 'per_home' | 'global'; faultKey: string | null } | null = null;
  const resolve = (): HomeOperatingModeResolution => {
    const outcome = resolveForHome(ctx, homeId);
    // Suspect read: the persisted pin truth is UNKNOWN, so hold the last-known
    // effective mode when it came from a pin — flipping to the global fallback
    // on one flaky read would swing a pinned area's targets and back (the same
    // transient-read rule that keeps bundles running on a 'suspect'
    // homes-config read). A known global follower still follows the CURRENT
    // global mode; otherwise this failed read could strand a silent-meter area
    // on the old global mode indefinitely. Before the first successful read
    // there is nothing to hold, so resolve as unpinned too.
    const resolution = outcome.state === 'resolved'
      ? outcome.resolution
      : heldResolution(ctx, lastLogged);
    const faultKey = outcome.state === 'suspect'
      ? `suspect:${outcome.reason}`
      : faultLogKey(resolution.fault);
    if (lastLogged?.mode !== resolution.mode || lastLogged?.source !== resolution.source) {
      ctx.getStructuredLogger('homes')?.info({
        event: 'home_operating_mode_changed',
        homeId,
        mode: resolution.mode,
        previousMode: lastLogged?.mode ?? null,
        source: resolution.source,
      });
    }
    if (faultKey !== null && faultKey !== lastLogged?.faultKey) {
      logResolveFault(ctx, homeId, outcome, resolution.mode);
    }
    lastLogged = { mode: resolution.mode, source: resolution.source, faultKey };
    return resolution;
  };
  return {
    getOperatingMode: () => resolve().mode,
    getPriorityForDevice: (deviceId) => (
      resolveDevicePriority(ctx.capacityPriorities, resolve().mode, deviceId)
    ),
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
  | { state: 'resolved'; mode: string | null }
  | { state: 'unavailable' };

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
  if (
    membership
    && (
      !membership.isOwnershipReady()
      || (!allowPendingOwnershipGeneration && membership.hasPendingOwnershipGeneration())
    )
  ) {
    return { state: 'unavailable' };
  }
  const homeId = membership?.getHomeIdForDevice(deviceId) ?? MAIN_HOME_ID;
  if (homeId === MAIN_HOME_ID) {
    const raw = ctx.homey.settings.get(OPERATING_MODE_SETTING) as unknown;
    return { state: 'resolved', mode: typeof raw === 'string' && raw.trim() ? raw : null };
  }
  const outcome = resolveForHome(ctx, homeId);
  // A suspect pin read stays UNKNOWN to the caller — never the global mode.
  // The bundle accessor can hold its last-known effective mode; this stateless
  // reader cannot, and its consumer persists a value derived from the mode, so
  // a global-mode fallback would freeze a wrong-mode default for a pinned area
  // (later refreshes keep the entry that is already there). The home's own
  // accessor surfaces the fault on its next resolve; no logging here, by
  // design — a snapshot-refresh pass must not emit events.
  if (outcome.state === 'suspect' || outcome.resolution.fault !== null) {
    return { state: 'unavailable' };
  }
  const { mode } = outcome.resolution;
  return { state: 'resolved', mode: mode.trim() ? mode : null };
};
