import type { SettingsPort } from '../ports/homeyRuntime';
import type { DeviceOperatingModeOutcome } from './homeModeDeviceRead';
import { MODE_DEVICE_TARGETS, homeScopedSettingsKey } from '../utils/settingsKeys';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import {
  sanitizeModeDeviceTargets,
  type ModeDeviceTargets,
} from '../../packages/shared-domain/src/settings/modeDeviceTargets';

/**
 * The mode-target catalog for one home, with genuine absence separated from a
 * failed read.
 *
 * `resolved` with an EMPTY catalog is the one state a caller may build a default
 * on top of: the key list does not hold the key, so it was never written. A
 * thrown read, a key list that throws or answers malformed, a payload the
 * parser does not recognize, or a listed key that reads null all answer
 * `unavailable`: a read that cannot tell must not become a wipe by a
 * whole-blob `set`, nor move a default derived from it
 * (`notes/persisted-settings-state.md`).
 *
 * ONE classification for this key, in the module that owns the concept, and
 * never in `setup/`, where `setup/AGENTS.md` forbids classifying at all.
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
  const keyList = readSettingsKeyList(settings);
  return keyList.status === 'resolved' && !keyList.keys.includes(key)
    ? { state: 'resolved', catalog: {} }
    : { state: 'unavailable' };
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

/**
 * The target the device's governing mode holds for it now, for a default the
 * planner derives each build. `resolved` with `null` when that mode holds none
 * for it; `unavailable` when the mode or its catalog cannot be read this time.
 * The catalog owner keeps the last resolved answer across an unavailable read
 * (`HomeModeCatalogOwner.readGoverningModeDeviceTargetC`).
 */
export function readGoverningModeDeviceTargetC(
  settings: SettingsPort,
  operatingMode: DeviceOperatingModeOutcome,
  deviceId: string,
): { state: 'resolved'; targetC: number | null } | { state: 'unavailable' } {
  if (operatingMode.state === 'unavailable') return { state: 'unavailable' };
  if (operatingMode.mode === null) return { state: 'resolved', targetC: null };
  return readModeDeviceTarget(settings, operatingMode.catalogHomeId, operatingMode.mode, deviceId);
}
