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
  settings: Homey.App['homey']['settings'],
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
 * fail closed. Consumers whose fail-safe direction is "unknown", not "off"
 * (a failed read must not be treated as dormancy evidence) go through
 * `readHomeConfigRuntimeActivation` instead.
 */
export const readLegacyMultiHomeEnabled = (
  settings: Homey.App['homey']['settings'],
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

export type HomeConfigRuntimeActivationRead =
  | { state: 'resolved'; active: boolean }
  | { state: 'suspect' };

/**
 * Suspect-aware activation read for consumers whose fail-safe direction is
 * "unknown", not "off". `isHomeConfigRuntimeActive` over the fail-closed flag
 * read converts a transient legacy-flag read failure into `false`, which is
 * correct for control gating (never run area controllers on a failed read)
 * but wrong wherever a definite "dormant" answer triggers a destructive
 * transition — the weather meter-scope fingerprint would forget years of
 * learned history on one settings hiccup.
 *
 * The legacy flag is consulted only where it is DECISIVE: a populated config
 * without the atomic activation marker. Marker-activated and empty configs
 * resolve without touching it, so a flaky flag read cannot destabilize the
 * common (post-GA) shapes.
 */
export const readHomeConfigRuntimeActivation = (
  config: HomeConfig,
  settings: Homey.App['homey']['settings'],
): HomeConfigRuntimeActivationRead => {
  if (config.activationVersion === HOME_CONFIG_ACTIVATION_VERSION || config.subHomes.length === 0) {
    return { state: 'resolved', active: true };
  }
  const legacy = classifyLegacyMultiHomeEnabled(settings);
  return legacy.state === 'suspect'
    ? { state: 'suspect' }
    : { state: 'resolved', active: legacy.enabled };
};

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
