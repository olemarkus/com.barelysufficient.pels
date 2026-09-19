/**
 * Domain-owned read boundary for the capacity scalar settings block
 * (`capacity_limit_kw`, `capacity_margin_kw`, `capacity_dry_run`, and
 * `capacity_period_minutes`). Consumers
 * depend on this type, never on `homey.settings` — the interface does not
 * expose the SDK, so capacity code cannot read or normalise the persisted
 * scalars itself. This module implements the reader over the SDK-free
 * `SettingsPort`; setup only supplies that port.
 *
 * A store instance is scoped to one home at construction time: the main home
 * reads the historical unsuffixed keys, any other home reads home-suffixed
 * keys (`homeScopedSettingsKey` in `lib/utils/settingsKeys.ts`).
 *
 * `read` is junk-tolerant per field: a missing/non-finite numeric scalar or
 * non-boolean dry-run flag resolves to the caller-supplied last-good snapshot.
 * The period's absence is different: an unlisted key is an install that never
 * wrote the setting and may use the compatibility default, while a listed key
 * whose value is absent/malformed is an unavailable SDK read. That distinction
 * keeps a transient startup miss from silently changing Belgian 15-minute
 * control into hourly control for the life of the process.
 */

/**
 * Identifier of a home, re-exported for capacity consumers. Single source of
 * truth in `lib/utils/settingsKeys.ts` (shared with the `lib/home` domain —
 * one identity type, no peer import; the main home is `MAIN_HOME_ID` there).
 */
import type { HomeId } from '../utils/settingsKeys';
import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import {
  isCapacityPeriodMinutes,
  resolveCapacityPeriodMinutes,
} from '../../packages/shared-domain/src/settings/capacityPeriod';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { TimerRegistry } from '../utils/timerRegistry';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  homeScopedSettingsKey,
} from '../utils/settingsKeys';

export type { HomeId } from '../utils/settingsKeys';

export type CapacityScalarSettingsRead =
  | { state: 'resolved'; value: CapacityScalarSettings }
  | { state: 'unavailable' };

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
};

const CAPACITY_SCALAR_KEYS: ReadonlySet<string> = new Set([
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
  return {
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
        const periodMinutes = settings.get(periodKey);
        if (keys.includes(periodKey) && !isCapacityPeriodMinutes(periodMinutes)) {
          return { state: 'unavailable' };
        }
        const fallback = lastGood();
        return {
          state: 'resolved',
          value: {
            limitKw: isFiniteNumber(limit) ? limit : fallback.limitKw,
            marginKw: isFiniteNumber(margin) ? margin : fallback.marginKw,
            dryRun: typeof dryRun === 'boolean' ? dryRun : fallback.dryRun,
            periodMinutes: resolveCapacityPeriodMinutes(periodMinutes, fallback.periodMinutes),
          },
        };
      } catch {
        return { state: 'unavailable' };
      }
    },
  };
}

const CAPACITY_SETTINGS_READ_RETRY_MS = 1_000;

/**
 * The retry policy for an unavailable read: one pending retry per `timerKey`,
 * a second later, cleared as soon as a read resolves. What an unavailable read
 * means in the meantime (keep the last-good scalars, or the safe boot defaults)
 * stays with the caller; this owns only when to ask again.
 */
export function scheduleCapacitySettingsReadRetry(
  read: CapacityScalarSettingsRead,
  timers: TimerRegistry,
  timerKey: string,
  retry: () => void,
): void {
  if (read.state === 'resolved') {
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
