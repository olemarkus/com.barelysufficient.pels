import type { SettingsPort } from '../ports/homeyRuntime';
import { OVERSHOOT_BEHAVIORS } from '../utils/settingsKeys';
import {
  isShedBehaviorsSetting,
  readShedBehaviors,
  type ConfiguredShedBehavior,
} from '../../packages/shared-domain/src/settings/shedBehaviors';

/**
 * The shed-behaviour map, with genuine absence separated from a failed read.
 *
 * `resolved` with an EMPTY map is the one state a caller may build on: the store
 * demonstrably never held the key. A thrown read, a present value that is not a
 * map, a present-but-null key, or an unusable key list all answer
 * `unavailable`, because the seed's next act is a whole-map `set`, and one
 * transient SDK miss must not erase every other device's limits
 * (`notes/persisted-settings-state.md`). The bytes themselves are read by the
 * key's owner (`packages/shared-domain/src/settings/shedBehaviors.ts`); this is
 * the runtime's absence policy for them, in the module that already holds the
 * same policy for mode targets (`modeDeviceTargetsRead.ts`).
 */
export type ShedBehaviorsRead =
  | { state: 'resolved'; behaviors: Record<string, ConfiguredShedBehavior> }
  | { state: 'unavailable' };

export function readShedBehaviorsSetting(settings: SettingsPort): ShedBehaviorsRead {
  let raw: unknown;
  try {
    raw = settings.get(OVERSHOOT_BEHAVIORS);
  } catch {
    return { state: 'unavailable' };
  }
  if (isShedBehaviorsSetting(raw)) return { state: 'resolved', behaviors: readShedBehaviors(raw) };
  // A present value that is not a map is corruption, not absence, whatever the
  // key list says.
  if (raw !== undefined && raw !== null) return { state: 'unavailable' };
  let keys: unknown;
  try {
    keys = settings.getKeys();
  } catch {
    return { state: 'unavailable' };
  }
  // An EMPTY key list is itself a suspect read — a real install always has keys.
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((entry) => typeof entry === 'string')) {
    return { state: 'unavailable' };
  }
  return keys.includes(OVERSHOOT_BEHAVIORS) ? { state: 'unavailable' } : { state: 'resolved', behaviors: {} };
}
