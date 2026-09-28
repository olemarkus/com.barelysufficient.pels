import type { SettingsPort } from '../ports/homeyRuntime';
import {
  HOME_CONFIG_ACTIVATION_VERSION,
  type HomeConfig,
} from './homeConfig';
import { createHomesStore } from './homeRegistryStore';

/**
 * Retired pre-GA feature flag, retained only as upgrade evidence. It is not
 * mirrored into settings-UI contracts and is never exposed as a current
 * feature switch.
 */
export const LEGACY_MULTI_HOME_ENABLED = 'multi_home_enabled';

type LegacyMultiHomeFlagRead =
  | { state: 'resolved'; enabled: boolean }
  | { state: 'suspect' };

/**
 * Boundary read of the old flag that keeps read-failure provenance: only
 * literal `true` resolves to enabled; absence, false, and malformed values
 * resolve to disabled; a thrown read is `suspect` — the flag's value is
 * unknown, which is NOT the same evidence as "off".
 */
const classifyLegacyMultiHomeEnabled = (
  settings: SettingsPort,
): LegacyMultiHomeFlagRead => {
  try {
    return { state: 'resolved', enabled: settings.get(LEGACY_MULTI_HOME_ENABLED) === true };
  } catch {
    return { state: 'suspect' };
  }
};

/**
 * Insured boundary read of the old flag. Only literal `true` is positive
 * activation evidence; absence, false, malformed values, and read failures all
 * fail closed.
 */
export const readLegacyMultiHomeEnabled = (
  settings: SettingsPort,
): boolean => {
  const read = classifyLegacyMultiHomeEnabled(settings);
  return read.state === 'resolved' && read.enabled;
};

/**
 * Membership-owned runtime activation decision. The membership service
 * publishes its latched result to downstream setup wiring; consumers do not
 * re-read the legacy flag or re-resolve activation independently. An empty
 * config is behaviourally dormant and safe to treat as GA-ready; a populated
 * pre-GA config needs either explicit legacy-on evidence or the atomic marker
 * written by a current UI upsert.
 */
export const isHomeConfigRuntimeActive = (
  config: HomeConfig,
  legacyEnabled: boolean,
): boolean => (
  legacyEnabled
  || config.activationVersion === HOME_CONFIG_ACTIVATION_VERSION
  || config.subHomes.length === 0
);

export type LegacyMultiHomeActivationMigrationOutcome =
  | 'applied'
  | 'already_active'
  | 'legacy_not_enabled'
  | 'store_unwritten'
  | 'store_suspect';

/**
 * Idempotent pre-GA `true` migration. The marker lives in `homes_config`
 * itself so config + activation commit in one value write. No separate
 * migration-done key is used: a suspect read or failed write naturally retries
 * next boot, while a successfully marked config is its own completion marker.
 */
export const migrateLegacyMultiHomeActivation = (
  settings: SettingsPort,
): LegacyMultiHomeActivationMigrationOutcome => {
  if (!readLegacyMultiHomeEnabled(settings)) return 'legacy_not_enabled';
  const store = createHomesStore(settings);
  const read = store.read();
  if (read.state === 'unwritten') return 'store_unwritten';
  if (read.state === 'suspect') return 'store_suspect';
  if (read.value.activationVersion === HOME_CONFIG_ACTIVATION_VERSION) return 'already_active';
  store.write({
    activationVersion: HOME_CONFIG_ACTIVATION_VERSION,
    subHomes: read.value.subHomes,
  });
  return 'applied';
};
