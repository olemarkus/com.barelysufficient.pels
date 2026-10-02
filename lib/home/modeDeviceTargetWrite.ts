import type { SettingsPort } from '../ports/homeyRuntime';
import { MODE_DEVICE_TARGETS, homeScopedSettingsKey } from '../utils/settingsKeys';
import { isWritableModeDeviceTargets } from '../../packages/shared-domain/src/settings/modeDeviceTargets';
import { resolveModeName } from '../utils/capacityHelpers';
import { readModeDeviceTargets } from './modeDeviceTargetsRead';
import type { DeviceModeCatalogOutcome } from './homeModeDeviceRead';

/**
 * An owner's explicit edit to one device's temperature in one mode, as a Flow
 * card makes it. The observation path that adopts a change made outside PELS
 * is a different writer (`observedTemperatureModeUpdates.ts`): that edit is
 * inferred and must not rebuild the plan, while this one is the owner's and
 * takes the ordinary settings-triggered rebuild.
 *
 * Narrower than the settings UI's per-mode field in one way: it edits only
 * modes that already keep a target record (see {@link listTargetModes}).
 */

type ResolvedDeviceModeCatalog = Extract<DeviceModeCatalogOutcome, { state: 'resolved' }>;

/** The mode an edit names: whichever governs the device when it runs, or one by name. */
export type ModeTargetSelection =
  | { kind: 'active' }
  | { kind: 'named'; name: string };

export type DeviceModeTargetEdit =
  | { state: 'written' | 'unchanged'; mode: string }
  | { state: 'unknown_mode' }
  | { state: 'unavailable' };

/**
 * The modes a device's target can be set in: the modes its catalog keeps a
 * target record for. A mode with only priorities is not one, because a target
 * saved there would create a mode the owner never made.
 */
export const listTargetModes = (catalog: ResolvedDeviceModeCatalog): string[] => (
  Object.keys(catalog.catalog.targets).sort((left, right) => left.localeCompare(right))
);

/**
 * The configured mode a selection names, following the catalog's aliases so a
 * Flow built before a mode was renamed still finds it. `null` when it names no
 * mode this catalog has.
 */
export const resolveTargetMode = (
  catalog: ResolvedDeviceModeCatalog,
  selection: ModeTargetSelection,
): string | null => {
  const requested = selection.kind === 'active' ? catalog.activeMode : selection.name;
  if (requested === null) return null;
  const modes = new Set(listTargetModes(catalog));
  const resolved = resolveModeName(requested, catalog.catalog.aliases, modes);
  return modes.has(resolved) ? resolved : null;
};

/**
 * Saves one device's target in the mode a selection names, in the catalog the
 * device's mode targets live in.
 *
 * Read through the key's owner and merged the way the settings UI merges its
 * own edit. A mode the stored catalog no longer holds is `unknown_mode`, never
 * created: the catalog has moved on since it was resolved, and a new mode is
 * the owner's to make.
 */
export function editDeviceModeTarget(
  settings: SettingsPort,
  catalog: DeviceModeCatalogOutcome,
  deviceId: string,
  selection: ModeTargetSelection,
  targetC: number,
): DeviceModeTargetEdit {
  if (catalog.state === 'unavailable') return catalog;
  const mode = resolveTargetMode(catalog, selection);
  if (mode === null) return { state: 'unknown_mode' };
  const key = homeScopedSettingsKey(MODE_DEVICE_TARGETS, catalog.catalogHomeId);
  const read = readModeDeviceTargets(settings, key);
  if (read.state === 'unavailable') return read;
  if (!Object.hasOwn(read.catalog, mode)) return { state: 'unknown_mode' };
  const modeTargets = read.catalog[mode] ?? {};
  if (modeTargets[deviceId] === targetC) return { state: 'unchanged', mode };
  const next = { ...read.catalog, [mode]: { ...modeTargets, [deviceId]: targetC } };
  if (!isWritableModeDeviceTargets(next)) return { state: 'unavailable' };
  settings.set(key, next);
  return { state: 'written', mode };
}
