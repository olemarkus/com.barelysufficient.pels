import { resolveExplicitMainMeterDeviceId } from './homeConfig';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../utils/settingsKeys';
import type { MainMeterSelection } from '../../packages/contracts/src/mainMeterSelection';

export type MainMeterSelectionSettings = {
  get(key: string): unknown;
  getKeys(): string[];
};

/**
 * How long a LISTED key answering empty must keep answering empty before it
 * settles as "nothing chosen".
 *
 * Matches the effective window `lib/power/soleMeterAdoption.ts` already applies
 * to the same ambiguity over the same key — three agreeing reads paced 30s
 * apart. That one can count reads because a timer paces them; this reader is
 * called at whatever rate its consumers happen to ask (the status writer alone
 * asks twice per plan status write), so counting reads here would settle in
 * milliseconds under load and never while idle. Wall-clock is the same policy
 * expressed in the one unit that does not depend on who is asking.
 */
const LISTED_EMPTY_GRACE_MS = 90_000;

/**
 * Classify Main's explicit meter from one read, with no memory.
 *
 * Absence is never a value (the stored-null Automatic selection is retired and
 * the save seam cannot write one), so the question is whether the read can be
 * trusted and, when nothing is stored, whether that is PROVEN:
 *
 * - Homey answers an UNSET key with `null` and omits it from `getKeys()`, so
 *   empty AND unlisted is proof that nothing was ever chosen.
 * - A key a healthy list vouches for that still reads empty is either the
 *   transient-miss shape this repo has observed on real hardware or a legacy
 *   stored-null Automatic selection. One read cannot tell them apart, so one
 *   read must not call it `unconfigured` — see the reader below.
 * - An empty key list vouches for nothing and proves no absence.
 */
const classifyMainMeterSelection = (
  settings: MainMeterSelectionSettings,
): MainMeterSelection | 'listed_empty' => {
  try {
    const raw = settings.get(HOMEY_ENERGY_METER_DEVICE_ID);
    if (typeof raw === 'string') {
      const meterDeviceId = resolveExplicitMainMeterDeviceId(raw);
      return meterDeviceId === null
        ? { state: 'unavailable' }
        : { state: 'resolved', meterDeviceId };
    }
    // Anything stored that is not a string is a malformed or transient read of
    // SOMETHING: never proof that nothing is chosen.
    if (raw !== undefined && raw !== null) return { state: 'unavailable' };
    const keys = settings.getKeys();
    if (keys.length === 0) return { state: 'unavailable' };
    return keys.includes(HOMEY_ENERGY_METER_DEVICE_ID)
      ? 'listed_empty'
      : { state: 'unconfigured' };
  } catch {
    return { state: 'unavailable' };
  }
};

/**
 * One read, no memory. The ambiguous listed-empty case answers `unavailable`,
 * which is the safe half: it never claims nothing was chosen, and it stays
 * retryable.
 *
 * This is what a consumer that only needs the meter ID should use — the
 * weather scope fingerprint, the area-collision check, the transport wiring.
 * Only a consumer whose answer decides whether to RETRY needs the graced reader
 * below, because only for that consumer does the difference between the two
 * non-resolved states change anything.
 */
export const readMainMeterSelection = (
  settings: MainMeterSelectionSettings,
): MainMeterSelection => {
  const classified = classifyMainMeterSelection(settings);
  return classified === 'listed_empty' ? { state: 'unavailable' } : classified;
};

export type MainMeterSelectionReader = { read: () => MainMeterSelection };

/**
 * The Main meter selection, with the one ambiguity one read cannot settle
 * settled over time.
 *
 * Why this holds state at all: `unconfigured` and `unavailable` both fence
 * control, and differ only in whether asking again can change the answer —
 * which is what decides whether the authority arms its recovery loop. Get that
 * wrong toward `unavailable` and an install that simply has no meter re-reads
 * the setting on a backoff forever; get it wrong toward `unconfigured` and a
 * transient miss permanently stops the retry that would have recovered it. A
 * bounded grace is the only honest answer, and a grace needs memory.
 *
 * A listed-empty read starts the window and reports `unavailable` (retryable)
 * until it expires. Any other answer ends the window immediately, so an
 * explicit id that surfaces mid-grace restarts it rather than shortening the
 * next one.
 */
export const createMainMeterSelectionReader = (
  settings: MainMeterSelectionSettings,
  nowMs: () => number,
): MainMeterSelectionReader => {
  let listedEmptySinceMs: number | null = null;
  return {
    read: (): MainMeterSelection => {
      const classified = classifyMainMeterSelection(settings);
      if (classified !== 'listed_empty') {
        listedEmptySinceMs = null;
        return classified;
      }
      const now = nowMs();
      if (listedEmptySinceMs === null) {
        listedEmptySinceMs = now;
        return { state: 'unavailable' };
      }
      return now - listedEmptySinceMs >= LISTED_EMPTY_GRACE_MS
        ? { state: 'unconfigured' }
        : { state: 'unavailable' };
    },
  };
};
