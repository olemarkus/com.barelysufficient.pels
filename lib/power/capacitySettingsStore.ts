/**
 * Domain-owned read boundary for the capacity scalar settings block
 * (`capacity_limit_kw`, `capacity_margin_kw`, `capacity_dry_run`, and
 * `capacity_period_minutes`, and independent Main-home grid/capacity enablement). Consumers
 * depend on this type, never on `homey.settings` — the interface does not
 * expose the SDK, so capacity code cannot read or normalise the persisted
 * scalars itself. This module implements the reader over the SDK-free
 * `SettingsPort`; setup only supplies that port.
 *
 * A store instance is scoped to one home at construction time: the main home
 * reads the historical unsuffixed keys, any other home reads home-suffixed
 * keys (`homeScopedSettingsKey` in `lib/utils/settingsKeys.ts`).
 *
 * `readHardCapConfiguration` resolves whether the hard-cap key has ever been
 * written from `getKeys()`, independently of every scalar `get()`. `read` is
 * junk-tolerant per field: a missing/non-finite numeric scalar or
 * non-boolean dry-run flag resolves to the caller-supplied last-good snapshot.
 * The period's absence is different: an unlisted key is an install that never
 * wrote the setting and may use the compatibility default, while a listed key
 * whose value is absent/malformed is a failed SDK read
 * (`notes/persisted-settings-state.md`: absence is only trustworthy from the key
 * list). That distinction keeps a transient startup miss from silently changing
 * 15-minute control into hourly control for the life of the process.
 *
 * The listed period and the Main-home control switches (Capacity limit, and
 * the grid import switch with its threshold) share one policy for such a read
 * — a malformed period, a non-boolean switch, or the grid switch on with a
 * missing or invalid threshold:
 *
 * - Until this store has ACCEPTED a well-formed value for the field, the read is
 *   `unavailable`. At boot the caller's last-good is the app's hard-coded
 *   default, a posture the owner never set, so nothing is carried from it: the
 *   safe boot posture (simulation) stands, and the read is asked again.
 * - Once a value has been accepted, the malformed field carries it, alone, and
 *   the rest of the block still resolves: a malformed grid pair must not freeze
 *   dry run or a hard-cap edit behind it. The read is `retained`, and asked
 *   again for `MALFORMED_READ_RETRY_WINDOW_MS` after the first malformed read —
 *   long enough for a failed read to heal. A value that is persistently
 *   malformed (only an external settings write produces one; the settings UI
 *   never writes it) would otherwise spin a retry every second forever. Past
 *   the window the carried value stands, without a retry, until an explicit
 *   write of one of these keys (`noteWrite`) opens a fresh window: a correction
 *   whose first read misses is still asked again.
 */

/**
 * Identifier of a home, re-exported for capacity consumers. Single source of
 * truth in `lib/utils/settingsKeys.ts` (shared with the `lib/home` domain —
 * one identity type, no peer import; the main home is `MAIN_HOME_ID` there).
 */
import type { HomeId } from '../utils/settingsKeys';
import type {
  CapacityPeriodMinutes,
  CapacityScalarSettings,
} from '../../packages/contracts/src/capacitySettings';
import type { SettingsUiHardCapConfigurationRead } from '../../packages/contracts/src/settingsUiApi';
import {
  isCapacityPeriodMinutes,
  resolveCapacityPeriodMinutes,
} from '../../packages/shared-domain/src/settings/capacityPeriod';
import {
  resolveCapacityEnabledSetting,
  resolveGridImportLimitSetting,
  type PowerLimitControlRead,
} from '../../packages/shared-domain/src/settings/powerLimits';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { TimerRegistry } from '../utils/timerRegistry';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_ENABLED,
  GRID_IMPORT_ENABLED,
  GRID_IMPORT_LIMIT_KW,
  MAIN_HOME_ID,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  homeScopedSettingsKey,
} from '../utils/settingsKeys';

export type { HomeId } from '../utils/settingsKeys';

export type CapacityScalarSettingsRead =
  | { state: 'resolved'; value: CapacityScalarSettings }
  /**
   * The block resolved, but the period or a Main-home control did not read back
   * well-formed and carries the value this store last accepted for it. Applied
   * like `resolved`. `askAgain` while the store still expects the read to heal
   * (`scheduleCapacitySettingsReadRetry`); once the window is spent the carried
   * value stands — which is not a recovery, so it is never `resolved`.
   */
  | { state: 'retained'; value: CapacityScalarSettings; askAgain: boolean }
  | { state: 'unavailable' };


/**
 * How long after the first malformed read of a field it is asked again: about
 * half a minute of one-second retries. A policy bound, not a measured one —
 * long enough for a transient SDK miss to heal, short enough that a
 * persistently malformed value costs a bounded number of reloads. Measured in
 * time, not reads, because other settings handlers read the block too.
 */
const MALFORMED_READ_RETRY_WINDOW_MS = 30_000;

/** The keys whose explicit write opens a fresh retry window (base keys; a meter area's are suffixed). */
const CARRIED_FIELD_KEYS: ReadonlySet<string> = new Set([
  CAPACITY_ENABLED,
  GRID_IMPORT_ENABLED,
  GRID_IMPORT_LIMIT_KW,
  CAPACITY_PERIOD_MINUTES,
]);

/** A field's value as this read resolved it, or the read could not produce one. */
type FieldRead<T> = PowerLimitControlRead<T>;

/** A carried field: the value this store last handed out, or none yet (boot). */
type AcceptedField<T> = { state: 'none' } | { state: 'accepted'; value: T };

const NOTHING_ACCEPTED: { state: 'none' } = { state: 'none' };

/**
 * The fields this store carries, each on its own: the Capacity limit switch,
 * the grid import pair (switch and threshold, usable only together) and the
 * period. A malformed one never holds back another's well-formed write.
 */
type CarriedFields<T extends 'read' | 'accepted'> = {
  capacityEnabled: T extends 'read' ? FieldRead<boolean> : AcceptedField<boolean>;
  gridImportLimitKw: T extends 'read' ? FieldRead<number | null> : AcceptedField<number | null>;
  periodMinutes: T extends 'read' ? FieldRead<CapacityPeriodMinutes> : AcceptedField<CapacityPeriodMinutes>;
};

/**
 * A meter area has no switches of its own (Main-home MVP): capacity control
 * on and no grid limit, accepted from the start. Only its period is read.
 */
const METER_AREA_CAPACITY_ENABLED: AcceptedField<boolean> = { state: 'accepted', value: true };
const METER_AREA_GRID_IMPORT_LIMIT: AcceptedField<number | null> = { state: 'accepted', value: null };
const METER_AREA_SWITCHES_READ: Pick<CarriedFields<'read'>, 'capacityEnabled' | 'gridImportLimitKw'> = {
  capacityEnabled: { state: 'resolved', value: true },
  gridImportLimitKw: { state: 'resolved', value: null },
};

/**
 * The Main-home switches as read, each on its own. A never-written key takes
 * its install default (Capacity limit on, grid import off); a listed one is
 * read as it stands, malformed or not.
 */
function readMainHomeSwitches(
  settings: SettingsPort,
  keys: readonly string[],
): Pick<CarriedFields<'read'>, 'capacityEnabled' | 'gridImportLimitKw'> {
  return {
    capacityEnabled: resolveCapacityEnabledSetting(
      keys.includes(CAPACITY_ENABLED) ? settings.get(CAPACITY_ENABLED) : true,
    ),
    gridImportLimitKw: resolveGridImportLimitSetting(
      keys.includes(GRID_IMPORT_ENABLED) ? settings.get(GRID_IMPORT_ENABLED) : false,
      settings.get(GRID_IMPORT_LIMIT_KW),
    ),
  };
}

/**
 * The period as read: a never-written key takes the compatibility default
 * (`fallbackMinutes`, the caller's running period); a listed one must read
 * back 15 or 60.
 */
function readPeriodMinutes(
  periodMinutes: unknown,
  listed: boolean,
  fallbackMinutes: CapacityPeriodMinutes,
): FieldRead<CapacityPeriodMinutes> {
  if (listed && !isCapacityPeriodMinutes(periodMinutes)) return { state: 'malformed' };
  return { state: 'resolved', value: resolveCapacityPeriodMinutes(periodMinutes, fallbackMinutes) };
}

/** A resolved field, or the accepted value it carries; none when nothing was ever accepted. */
function carryField<T>(read: FieldRead<T>, accepted: AcceptedField<T>): AcceptedField<T> {
  return read.state === 'resolved' ? { state: 'accepted', value: read.value } : accepted;
}

/**
 * Read access to the capacity scalars for the home the store was constructed
 * for. See the module contract above for per-field fallback policy.
 *
 * The last-good provider is bound at construction, next to the homeId, so the
 * home↔fallback pairing is fixed at the wiring site — a caller can never hand
 * one home's values to another home's store at read time. The provider is a
 * wiring-owned closure over already-validated state (the guarded snapshot for
 * the main home; a sub-home's own defaults for sub-homes — never another
 * home's live values) and must therefore always yield finite scalars.
 */
export type CapacitySettingsStore = {
  read(): CapacityScalarSettingsRead;
  /**
   * An explicit settings write of `baseKey` landed. A write of the period or a
   * Main-home control key opens a fresh retry window for a malformed read of
   * it, and answers true; any other key is ignored. Called through the
   * reloader (`CapacitySettingsReloader.noteWritten` / `reloadAfterWrite`),
   * which also re-reads the block.
   */
  noteWrite(baseKey: string): boolean;
  readHardCapConfiguration(): SettingsUiHardCapConfigurationRead;
};

const CAPACITY_SCALAR_KEYS: ReadonlySet<string> = new Set([
  CAPACITY_ENABLED,
  GRID_IMPORT_ENABLED,
  GRID_IMPORT_LIMIT_KW,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_DRY_RUN,
  CAPACITY_PERIOD_MINUTES,
]);

export const isCapacityScalarSettingKey = (key: string): boolean => CAPACITY_SCALAR_KEYS.has(key);

/** Settings-backed capacity reader; setup supplies the SDK-free port and owns no interpretation. */
export function createCapacitySettingsStore(
  settings: SettingsPort,
  homeId: HomeId,
  lastGood: () => CapacityScalarSettings,
): CapacitySettingsStore {
  // What this store last handed out for each carried field; none at boot for a
  // Main-home field, which is what keeps a malformed boot read `unavailable`.
  const isMain = homeId === MAIN_HOME_ID;
  let accepted: CarriedFields<'accepted'> = {
    capacityEnabled: isMain ? NOTHING_ACCEPTED : METER_AREA_CAPACITY_ENABLED,
    gridImportLimitKw: isMain ? NOTHING_ACCEPTED : METER_AREA_GRID_IMPORT_LIMIT,
    periodMinutes: NOTHING_ACCEPTED,
  };
  // When the open malformed-read window started; null while every carried field
  // reads well-formed, or after an explicit write until the next malformed read.
  let malformedSinceMs: number | null = null;
  return {
    readHardCapConfiguration(): SettingsUiHardCapConfigurationRead {
      try {
        const keys = settings.getKeys();
        if (keys.length === 0) return { state: 'unavailable' };
        return {
          state: 'resolved',
          configured: keys.includes(homeScopedSettingsKey(CAPACITY_LIMIT_KW, homeId)),
        };
      } catch {
        return { state: 'unavailable' };
      }
    },
    noteWrite(baseKey: string): boolean {
      if (!CARRIED_FIELD_KEYS.has(baseKey)) return false;
      malformedSinceMs = null;
      return true;
    },
    read(): CapacityScalarSettingsRead {
      try {
        const keys = settings.getKeys();
        // PELS always owns settings keys. An empty list is the SDK's transient
        // unreadable-store spelling, never evidence of a fresh install.
        if (keys.length === 0) return { state: 'unavailable' };
        const limit = settings.get(homeScopedSettingsKey(CAPACITY_LIMIT_KW, homeId));
        const margin = settings.get(homeScopedSettingsKey(CAPACITY_MARGIN_KW, homeId));
        const dryRun = settings.get(homeScopedSettingsKey(CAPACITY_DRY_RUN, homeId));
        const periodKey = homeScopedSettingsKey(CAPACITY_PERIOD_MINUTES, homeId);
        const fallback = lastGood();
        const read: CarriedFields<'read'> = {
          ...(isMain
            ? readMainHomeSwitches(settings, keys)
            : METER_AREA_SWITCHES_READ),
          periodMinutes: readPeriodMinutes(settings.get(periodKey), keys.includes(periodKey), fallback.periodMinutes),
        };
        const capacityEnabled = carryField(read.capacityEnabled, accepted.capacityEnabled);
        const gridImportLimitKw = carryField(read.gridImportLimitKw, accepted.gridImportLimitKw);
        const periodMinutes = carryField(read.periodMinutes, accepted.periodMinutes);
        // A malformed field with nothing accepted to carry (boot): keep the
        // caller's safe boot posture, and accept nothing from this read either.
        if (capacityEnabled.state === 'none' || gridImportLimitKw.state === 'none' || periodMinutes.state === 'none') {
          return { state: 'unavailable' };
        }
        accepted = { capacityEnabled, gridImportLimitKw, periodMinutes };
        const value: CapacityScalarSettings = {
          capacityEnabled: capacityEnabled.value,
          gridImportLimitKw: gridImportLimitKw.value,
          limitKw: isFiniteNumber(limit) ? limit : fallback.limitKw,
          marginKw: isFiniteNumber(margin) ? margin : fallback.marginKw,
          dryRun: typeof dryRun === 'boolean' ? dryRun : fallback.dryRun,
          periodMinutes: periodMinutes.value,
        };
        if (Object.values(read).every((field) => field.state === 'resolved')) {
          malformedSinceMs = null;
          return { state: 'resolved', value };
        }
        const nowMs = Date.now();
        if (malformedSinceMs === null) malformedSinceMs = nowMs;
        return { state: 'retained', value, askAgain: nowMs - malformedSinceMs < MALFORMED_READ_RETRY_WINDOW_MS };
      } catch {
        return { state: 'unavailable' };
      }
    },
  };
}

const CAPACITY_SETTINGS_READ_RETRY_MS = 1_000;

/**
 * The retry policy for an unavailable read, or a retained one the store still
 * expects to heal: one pending retry per `timerKey`, a second later, cleared as
 * soon as a read resolves or the store stops asking (`askAgain`). What an
 * unavailable read means in the meantime (keep the last-good scalars, or the
 * safe boot defaults) stays with the caller; this owns only when to ask again.
 */
export function scheduleCapacitySettingsReadRetry(
  read: CapacityScalarSettingsRead,
  timers: TimerRegistry,
  timerKey: string,
  retry: () => void,
): void {
  if (read.state === 'resolved' || (read.state === 'retained' && !read.askAgain)) {
    timers.clear(timerKey);
    return;
  }
  if (timers.has(timerKey)) return;
  const timer = setTimeout(() => {
    timers.clear(timerKey);
    retry();
  }, CAPACITY_SETTINGS_READ_RETRY_MS);
  timers.registerTimeout(timerKey, timer);
  (timer as { unref?: () => void }).unref?.();
}

/**
 * The reloader: owner of WHEN a home re-reads its capacity block and whether a
 * read warrants a plan rebuild. The store above decides what a read means; the
 * reloader decides what happens next, so the wiring only installs a read and
 * runs the rebuild it is told to.
 *
 * - A settings change reads the block now. Whether that read rebuilds is the
 *   home's (`rebuildOnChange`): the Main home's settings handlers rebuild after
 *   their own reload, a meter area's change path has no other rebuild.
 * - An unavailable read, or a retained one the store still expects to heal, is
 *   asked again a second later (`scheduleCapacitySettingsReadRetry`). A retry
 *   rebuilds only on a recovery (`resolved`): a retained read carries the
 *   scalars the home already runs on, and a rebuild per one-second retry would
 *   spend a plan build on nothing.
 * - An explicit write of a carried key (`CapacitySettingsStore.noteWrite`) opens
 *   a fresh retry window. When the settings handler's write dedupe skips that
 *   write's own reload, a block that is not reading back well-formed is asked
 *   again at once, through the retry lane: a correction the store keeps missing
 *   must still be read, and only one path reloads and rebuilds for one write.
 */

/** Why a reload rebuilds: the home's own change path, or a read that recovered. */
export type CapacityReloadRebuildCause = 'change' | 'recovered';

export type CapacitySettingsReloader = {
  /** A settings change landed: read the block now and install it. */
  reload(): void;
  /**
   * An explicit settings write of `baseKey` landed, ahead of the handler's
   * write dedupe: a carried key opens a fresh retry window. The handler's own
   * reload, when it runs, reads with it.
   */
  noteWritten(baseKey: string): void;
  /**
   * The handler's write dedupe skipped `baseKey`, so no reload follows it. A
   * carried key is re-read now, through the retry lane, while the block is not
   * reading back well-formed: a correction the store keeps missing must still
   * be read.
   */
  recoverAfterSkippedWrite(baseKey: string): void;
  /** An explicit settings write of `baseKey` landed on a path with no dedupe: reload it as a change. */
  reloadAfterWrite(baseKey: string): void;
};

/** The home's collaborators: its store and timers, and the wiring's two seams. */
export type CapacitySettingsReloaderPorts = {
  store: CapacitySettingsStore;
  timers: TimerRegistry;
  timerKey: string;
  /** Whether this home has stopped; a stopped home reads nothing more. */
  isStopped: () => boolean;
  /**
   * Install a read. An unavailable read keeps the scalars the home already runs
   * on (`resolveInstalledCapacityScalars`); the install still runs, because the
   * Main home reloads its other settings with them.
   */
  install: (read: CapacityScalarSettingsRead) => void;
  rebuild: (cause: CapacityReloadRebuildCause) => void;
  rebuildOnChange: boolean;
};

/** The scalars a read installs: the read's own, or the running ones when it is unavailable. */
export const resolveInstalledCapacityScalars = (
  read: CapacityScalarSettingsRead,
  running: CapacityScalarSettings,
): CapacityScalarSettings => (read.state === 'unavailable' ? running : read.value);

export function createCapacitySettingsReloader(ports: CapacitySettingsReloaderPorts): CapacitySettingsReloader {
  // Whether the last read fell short of `resolved`: only then is a write's
  // immediate re-read worth spending, since a resolved block has nothing to heal.
  let awaitingRecovery = false;
  const reloadFrom = (cause: 'change' | 'retry'): void => {
    if (ports.isStopped()) return;
    const read = ports.store.read();
    awaitingRecovery = read.state !== 'resolved';
    scheduleCapacitySettingsReadRetry(read, ports.timers, ports.timerKey, () => reloadFrom('retry'));
    ports.install(read);
    if (read.state === 'unavailable') return;
    if (cause === 'change') {
      if (ports.rebuildOnChange) ports.rebuild('change');
      return;
    }
    if (read.state === 'resolved') ports.rebuild('recovered');
  };
  return {
    reload: () => reloadFrom('change'),
    noteWritten: (baseKey) => { ports.store.noteWrite(baseKey); },
    recoverAfterSkippedWrite: (baseKey) => {
      if (!CARRIED_FIELD_KEYS.has(baseKey) || !awaitingRecovery) return;
      reloadFrom('retry');
    },
    reloadAfterWrite: (baseKey) => {
      ports.store.noteWrite(baseKey);
      reloadFrom('change');
    },
  };
}
