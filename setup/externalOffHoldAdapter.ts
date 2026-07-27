// Persistence boundary for "Leave off until turned on again" over
// `homey.settings`. All behaviour lives in the domain
// (`lib/observer/externalOffHold.ts`); this adapter only knows Homey, matching
// the port-in-domain / adapter-in-setup split used by
// `setup/curtailmentHoldStateAdapter.ts`.
//
// It binds three keys:
//  - `respect_external_off_devices` — the per-device opt-in (config)
//  - `external_off_holds` — which devices PELS is currently leaving off (state)
//  - `external_off_holds_initialized` — the written-before marker that lets the
//    store tell a fresh install from a transient read miss, so a failed read
//    engages the abandon-grace window instead of full-replacing the state with
//    an empty map. Same trick as `power_calibration_initialized`.
//
// Per `feedback_homey_sdk_unreliable`: a transient SDK read failure must not
// release a user's hold or drop their configuration.

import {
  createExternalOffHoldPolicy as createPolicy,
  type ExternalOffHoldOptInRead,
  type ExternalOffHoldPolicy,
  type PersistedExternalOffHolds,
} from '../lib/observer/externalOffHold';
import {
  EXTERNAL_OFF_HOLDS,
  EXTERNAL_OFF_HOLDS_INITIALIZED,
  RESPECT_EXTERNAL_OFF_DEVICES,
} from '../lib/utils/settingsKeys';
import { isBooleanMap } from '../lib/utils/appTypeGuards';

type SettingsLike = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
};

/**
 * Reads the opt-in map, classifying every outcome here so the domain never has
 * to (the boundary rule in `AGENTS.md`):
 *  - absent (`undefined`/`null`, including after `unset`) ⇒ a genuine "nobody
 *    opted in", or clearing the setting could never disable the feature;
 *  - throwing or malformed ⇒ the last good map when we have one, since that is
 *    the shape a transient corrupt read takes and silently disabling the feature
 *    would resume everything the user turned off;
 *  - throwing or malformed with no last good map ⇒ `unavailable`, NOT `{}`. At
 *    startup that difference is a wipe: `{}` makes every restored hold look
 *    de-opted, and the policy's constructor would clear and persist an empty map.
 */
const readOptInMap = (
  settings: SettingsLike,
  lastGood: Record<string, boolean> | null,
): ExternalOffHoldOptInRead => {
  const fallback = (): ExternalOffHoldOptInRead => (
    lastGood === null ? { status: 'unavailable' } : { status: 'resolved', optIn: lastGood }
  );
  let raw: unknown;
  try {
    raw = settings.get(RESPECT_EXTERNAL_OFF_DEVICES);
  } catch {
    return fallback();
  }
  if (raw === undefined || raw === null) return { status: 'resolved', optIn: {} };
  return isBooleanMap(raw) ? { status: 'resolved', optIn: raw } : fallback();
};

/** Build the external-off hold policy over Homey settings. */
export function createExternalOffHoldPolicy(settings: SettingsLike): ExternalOffHoldPolicy {
  // `null` until a read succeeds — an unresolved map must not masquerade as empty.
  let lastGoodOptIn: Record<string, boolean> | null = null;
  // True once this process has persisted holds, whatever the stored marker says.
  let markerWritten = false;
  return createPolicy({
    load: () => settings.get(EXTERNAL_OFF_HOLDS),
    /**
     * The blob and its written-before marker are ONE persist. If the marker
     * cannot be written the whole save is reported as failed, so the domain
     * keeps the mutation pending and retries both — a marker dropped as
     * best-effort would make a later transiently-absent blob look like a fresh
     * install, skipping the grace window that stops a wipe. Rewriting the blob
     * on a retry is idempotent.
     */
    save: (holds: PersistedExternalOffHolds) => {
      settings.set(EXTERNAL_OFF_HOLDS, holds);
      if (settings.get(EXTERNAL_OFF_HOLDS_INITIALIZED) !== true) {
        settings.set(EXTERNAL_OFF_HOLDS_INITIALIZED, true);
      }
      markerWritten = true;
    },
    readOptIn: () => {
      const read = readOptInMap(settings, lastGoodOptIn);
      if (read.status === 'resolved') lastGoodOptIn = read.optIn;
      return read;
    },
    hasWrittenBefore: () => {
      if (markerWritten) return true;
      try {
        const marker = settings.get(EXTERNAL_OFF_HOLDS_INITIALIZED);
        // Only a genuinely ABSENT marker means "fresh install". `true` means we
        // have written; anything else is a marker we cannot interpret, and
        // guessing "fresh" there skips the grace window and lets the next
        // mutation replace the stored map — the wipe this marker exists to stop.
        if (marker === undefined || marker === null) return false;
        return true;
      } catch {
        // Unknown marker state: assume we have written before, so a failed read
        // engages the grace window rather than risking a wipe.
        return true;
      }
    },
  });
}
