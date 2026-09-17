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
 * The period follows the same rule; the initial snapshot's 60-minute seed is
 * the compatibility default for an install that has never written the key.
 */

/**
 * Identifier of a home, re-exported for capacity consumers. Single source of
 * truth in `lib/utils/settingsKeys.ts` (shared with the `lib/home` domain —
 * one identity type, no peer import; the main home is `MAIN_HOME_ID` there).
 */
import type { HomeId } from '../utils/settingsKeys';
import type { CapacityPeriodMinutes } from '../../packages/shared-domain/src/settings/capacityPeriod';
import { resolveCapacityPeriodMinutes } from '../../packages/shared-domain/src/settings/capacityPeriod';
import type { SettingsPort } from '../ports/homeyRuntime';
import { isFiniteNumber } from '../utils/appTypeGuards';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  homeScopedSettingsKey,
} from '../utils/settingsKeys';

export type { HomeId } from '../utils/settingsKeys';

/** The capacity scalar block: hard cap, safety margin, dry-run, and billing period. */
export type CapacityScalarSettings = {
  limitKw: number;
  marginKw: number;
  dryRun: boolean;
  periodMinutes: CapacityPeriodMinutes;
};

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
  read(): CapacityScalarSettings;
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
    read(): CapacityScalarSettings {
      const limit = settings.get(homeScopedSettingsKey(CAPACITY_LIMIT_KW, homeId));
      const margin = settings.get(homeScopedSettingsKey(CAPACITY_MARGIN_KW, homeId));
      const dryRun = settings.get(homeScopedSettingsKey(CAPACITY_DRY_RUN, homeId));
      const periodMinutes = settings.get(homeScopedSettingsKey(CAPACITY_PERIOD_MINUTES, homeId));
      const fallback = lastGood();
      return {
        limitKw: isFiniteNumber(limit) ? limit : fallback.limitKw,
        marginKw: isFiniteNumber(margin) ? margin : fallback.marginKw,
        dryRun: typeof dryRun === 'boolean' ? dryRun : fallback.dryRun,
        periodMinutes: resolveCapacityPeriodMinutes(periodMinutes, fallback.periodMinutes),
      };
    },
  };
}
