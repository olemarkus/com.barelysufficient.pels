// Homey-settings adapter for the capacity scalar block. The port type lives in
// the domain (`lib/power/capacitySettingsStore.ts`); only this adapter knows
// the persisted key names and the home→key mapping. Reads are validated at the
// boundary with the exact historical semantics of the capacity snapshot
// builder: a non-finite scalar or non-boolean dry-run flag resolves to the
// caller-supplied fallback (the last-good snapshot value), never a fabricated
// default — so persisted garbage can never displace a previously loaded value.

import type {
  CapacityScalarSettings,
  CapacitySettingsStore,
  HomeId,
} from '../lib/power/capacitySettingsStore';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  homeScopedSettingsKey,
} from '../lib/utils/settingsKeys';

type SettingsLike = {
  get: (key: string) => unknown;
};

/**
 * Builds the {@link CapacitySettingsStore} for one home: the main home reads
 * the historical unsuffixed keys, any other home reads `<key>:<homeId>`.
 *
 * `lastGood` is bound here, next to the homeId, so the home↔fallback pairing
 * is decided once at the wiring site — it must yield this home's own
 * last-good values (never another home's), already validated finite.
 */
export function createCapacitySettingsStore(
  settings: SettingsLike,
  homeId: HomeId,
  lastGood: () => CapacityScalarSettings,
): CapacitySettingsStore {
  return {
    read(): CapacityScalarSettings {
      const limit = settings.get(homeScopedSettingsKey(CAPACITY_LIMIT_KW, homeId));
      const margin = settings.get(homeScopedSettingsKey(CAPACITY_MARGIN_KW, homeId));
      const dryRun = settings.get(homeScopedSettingsKey(CAPACITY_DRY_RUN, homeId));
      const fallback = lastGood();
      return {
        limitKw: isFiniteNumber(limit) ? limit : fallback.limitKw,
        marginKw: isFiniteNumber(margin) ? margin : fallback.marginKw,
        dryRun: typeof dryRun === 'boolean' ? dryRun : fallback.dryRun,
      };
    },
  };
}
