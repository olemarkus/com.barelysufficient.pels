// Persistence boundary for "Leave off until turned on again" over
// `homey.settings`. All behaviour lives in the domain
// (`lib/observer/externalOffHold.ts`); this adapter only knows Homey, matching
// the port-in-domain / adapter-in-setup split used by
// `setup/curtailmentHoldStateAdapter.ts`.
//
// The hold state itself needs no adapting: it is one key per held device whose
// presence is the fact, so `homey.settings` already IS the store port and is
// passed straight through. What is left here is the opt-in map
// (`respect_external_off_devices`), whose absent / malformed / throwing reads
// mean genuinely different things and must be classified before the domain sees
// them — per `feedback_homey_sdk_unreliable`, a transient read failure must not
// release a user's hold or drop their configuration.

import {
  createExternalOffHoldPolicy as createPolicy,
  type ExternalOffHoldOptInRead,
  type ExternalOffHoldPolicy,
  type ExternalOffHoldSettingsStore,
} from '../lib/observer/externalOffHold';
import { RESPECT_EXTERNAL_OFF_DEVICES } from '../lib/utils/settingsKeys';
import { isBooleanMap } from '../lib/utils/appTypeGuards';

/**
 * Reads the opt-in map, classifying every outcome here so the domain never has
 * to (the boundary rule in `AGENTS.md`):
 *  - absent (`undefined`/`null`, including after `unset`) ⇒ a genuine "nobody
 *    opted in", or clearing the setting could never disable the feature;
 *  - throwing or malformed ⇒ the last good map when we have one, since that is
 *    the shape a transient corrupt read takes and silently disabling the feature
 *    would resume everything the user turned off;
 *  - throwing or malformed with no last good map ⇒ `unavailable`, NOT `{}`. At
 *    startup that difference is a wipe: `{}` makes every stored hold look
 *    de-opted, and the policy's constructor would clear them all.
 */
const readOptInMap = (
  store: ExternalOffHoldSettingsStore,
  lastGood: Record<string, boolean> | null,
): ExternalOffHoldOptInRead => {
  const fallback = (): ExternalOffHoldOptInRead => (
    lastGood === null ? { status: 'unavailable' } : { status: 'resolved', optIn: lastGood }
  );
  let raw: unknown;
  try {
    raw = store.get(RESPECT_EXTERNAL_OFF_DEVICES);
  } catch {
    return fallback();
  }
  if (raw === undefined || raw === null) return { status: 'resolved', optIn: {} };
  return isBooleanMap(raw) ? { status: 'resolved', optIn: raw } : fallback();
};

/** Build the external-off hold policy over Homey settings. */
export function createExternalOffHoldPolicy(
  store: ExternalOffHoldSettingsStore,
): ExternalOffHoldPolicy {
  // `null` until a read succeeds — an unresolved map must not masquerade as empty.
  let lastGoodOptIn: Record<string, boolean> | null = null;
  return createPolicy({
    store,
    readOptIn: () => {
      const read = readOptInMap(store, lastGoodOptIn);
      if (read.status === 'resolved') lastGoodOptIn = read.optIn;
      return read;
    },
  });
}
