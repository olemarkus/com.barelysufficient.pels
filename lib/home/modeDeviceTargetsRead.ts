import type { SettingsPort } from '../ports/homeyRuntime';
import { MODE_DEVICE_TARGETS, homeScopedSettingsKey } from '../utils/settingsKeys';
import {
  sanitizeModeDeviceTargets,
  type ModeDeviceTargets,
} from '../../packages/shared-domain/src/settings/modeDeviceTargets';

/**
 * The mode-target catalog for one home, with genuine absence separated from a
 * failed read.
 *
 * `resolved` with an EMPTY catalog is the one state a caller may build a default
 * on top of: the store demonstrably never held the key. A thrown read, an
 * unusable key list, a payload the parser does not recognize, or a
 * present-but-null key all answer `unavailable`, because every caller's next act
 * is a whole-blob `set` or a persisted default, and one transient SDK miss must
 * not become a wipe (`notes/persisted-settings-state.md`).
 *
 * ONE classification for this key, in the module that owns the concept. It was
 * two: the mode-target fill pass and the overshoot-floor seed each read the same
 * bytes with their own absence policy, in `setup/`, where `setup/AGENTS.md`
 * forbids classifying at all. The seed's copy disagreed — it read an absent
 * catalog as unknown and skipped the seed outright, so a temperature-only device
 * on a home with no mode targets got no limiting floor and could never be
 * limited.
 *
 * The SDK answers an unwritten setting with `null` on Homey Pro and the
 * Self-Hosted Server, and object doubles in specs answer `undefined`; the key
 * list is the authority for absence in both cases.
 */
export type ModeDeviceTargetsRead =
  | { state: 'resolved'; catalog: ModeDeviceTargets }
  | { state: 'unavailable' };

export function readModeDeviceTargets(
  settings: SettingsPort,
  key: string,
): ModeDeviceTargetsRead {
  let raw: unknown;
  try {
    raw = settings.get(key);
  } catch {
    return { state: 'unavailable' };
  }
  const parsed = sanitizeModeDeviceTargets(raw);
  if (parsed !== null) return { state: 'resolved', catalog: parsed };
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
  return keys.includes(key) ? { state: 'unavailable' } : { state: 'resolved', catalog: {} };
}

/**
 * ONE device's saved target in ONE mode, or `null` when the home has no target
 * for it. The catalog read above plus the lookup into it, so a caller never
 * indexes a domain structure itself — the key is composed here too, from the
 * home the caller resolved.
 *
 * `unavailable` still travels, and the distinction is the whole point: absent is
 * "no target configured", which a caller may build a default on, and unavailable
 * is "we could not find out", which it must not.
 */
export function readModeDeviceTarget(
  settings: SettingsPort,
  catalogHomeId: string,
  mode: string,
  deviceId: string,
): { state: 'resolved'; targetC: number | null } | { state: 'unavailable' } {
  const read = readModeDeviceTargets(settings, homeScopedSettingsKey(MODE_DEVICE_TARGETS, catalogHomeId));
  if (read.state === 'unavailable') return { state: 'unavailable' };
  return { state: 'resolved', targetC: read.catalog[mode]?.[deviceId] ?? null };
}
