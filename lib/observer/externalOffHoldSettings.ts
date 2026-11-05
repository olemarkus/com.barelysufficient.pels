import {
  createExternalOffHoldPolicy as createPolicy,
  type ExternalOffHoldOptInRead,
  type ExternalOffHoldPolicy,
  type ExternalOffHoldSettingsStore,
} from './externalOffHold';
import { RESPECT_EXTERNAL_OFF_DEVICES } from '../utils/settingsKeys';
import { isBooleanMap } from '../utils/appTypeGuards';

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
