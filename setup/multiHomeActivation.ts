import type Homey from 'homey';
import {
  HOME_CONFIG_ACTIVATION_VERSION,
  type HomeConfig,
} from '../lib/home/homeConfig';
import { createHomesStore } from './homeRegistryAdapter';

/**
 * Retired pre-GA feature flag, retained only as upgrade evidence. It is not
 * mirrored into settings-UI contracts and is never exposed as a current
 * feature switch.
 */
export const LEGACY_MULTI_HOME_ENABLED = 'multi_home_enabled';

/**
 * Insured boundary read of the old flag. Only literal `true` is positive
 * activation evidence; absence, false, malformed values, and read failures all
 * fail closed.
 */
export const readLegacyMultiHomeEnabled = (
  settings: Homey.App['homey']['settings'],
): boolean => {
  try {
    return settings.get(LEGACY_MULTI_HOME_ENABLED) === true;
  } catch {
    return false;
  }
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
  homey: Homey.App['homey'],
): LegacyMultiHomeActivationMigrationOutcome => {
  if (!readLegacyMultiHomeEnabled(homey.settings)) return 'legacy_not_enabled';
  const store = createHomesStore(homey);
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
