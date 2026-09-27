import { getLogger } from '../logging/logger';
import type { HeldReading, ManagedLoadDraw, PowerTrackerState } from './trackerTypes';

/**
 * When a whole-home reading that has stopped changing stops counting as a
 * reading — `lib/power` decides, because `lib/power` owns the meter.
 *
 * Holding a value is not, by itself, evidence of anything: Homey reports a
 * capability on change, some meters only report past a threshold, and an idle
 * home or meter area can sit on one value for hours (owner ruling 2026-09-24:
 * an unchanged reading means nothing changed). What IS evidence is the home's
 * own metered load moving while the reading does not: a HAN reader whose app
 * keeps serving its last value, say (2026-09-14, one home on a frozen 1.1 kW
 * for three days with its hard cap unenforced).
 *
 * The evidence is the loads' live measurements of their draw, resolved at ingest
 * (`ManagedLoadDraw`), and a held reading is judged in two steps:
 * - SUSPECTED once, over the same loads, their draw has sat a kilowatt or more
 *   (or a quarter of the reading) away from its baseline on every sample for
 *   two minutes. The owner is warned: the no-readings banner and the other
 *   owner-facing surfaces age `resolveDisplayedPowerUpdateMs`.
 * - FROZEN once that has lasted ten minutes. The silence policy then counts
 *   the meter as silent since the reading took its value
 *   (`resolveMeterEvidenceAtMs`), so the fail-closed pass runs at once when
 *   that was more than ten minutes ago.
 *
 * A draw that comes back within the threshold before the reading is frozen
 * clears the suspicion: a spike, or a load that cycled, is not a dead meter.
 * A frozen verdict stays until the reading moves, because the pass it triggers
 * is what takes the moved load away again.
 *
 * The baseline follows the draw rather than being judged against it:
 * - through a settle window after the reading takes a new value, because a
 *   device's own report can trail the meter's by a cloud app's poll interval;
 * - whenever the loads summed change (the snapshot loading after a restart, a
 *   device joining), because draws over different loads are not comparable;
 * - for a day after this meter has held one value clean for as long as it
 *   takes to freeze a reading and then moved on. That is a meter reporting
 *   only on change, whose holds say nothing: a slow device report, or a move
 *   under its reporting threshold, would otherwise freeze a live meter and,
 *   through the pass, hold a whole home off until its reading next moves.
 *
 * Exactly 0 W never holds: a feed that cannot express export sits at 0 for as
 * long as the home exports, whatever its load does.
 */

const heldReadingLogger = getLogger('power/held-reading');

/**
 * How long the baseline follows the managed draw after the reading takes a new
 * value: longer than a cloud-polled device takes to report a change the meter
 * has already shown.
 */
export const HELD_READING_SETTLE_MS = 10 * 60 * 1000;

/** How long the draw must stay moved under a held reading before the owner is warned. */
export const HELD_READING_SUSPECT_MS = 2 * 60 * 1000;

/** How long the draw must stay moved under a held reading before the meter counts as silent. */
export const HELD_READING_FREEZE_MS = 10 * 60 * 1000;

/** A clean hold this long, then a new value, shows a meter that reports only on change. */
export const HELD_READING_LONG_HOLD_MS = HELD_READING_SETTLE_MS + HELD_READING_FREEZE_MS;

/** How long a long clean hold keeps this meter's holds from being judged. */
export const HELD_READING_LONG_HOLD_MEMORY_MS = 24 * 60 * 60 * 1000;

/**
 * The smallest move in measured draw the whole-home reading must follow: a
 * kilowatt, or a quarter of the reading on a home drawing more, so a meter
 * reporting only past a relative threshold is not caught out.
 */
const MIN_CONTRADICTING_DRAW_W = 1000;
const CONTRADICTING_DRAW_SHARE = 0.25;

type HeldReadingVerdict = 'unsuspected' | 'suspected' | 'frozen';

/** The verdict on a hold as of the sample it describes. */
function resolveVerdict(held: HeldReading | undefined): HeldReadingVerdict {
  if (held === undefined || held.contradictedAtMs === null) return 'unsuspected';
  const contradictedForMs = held.atMs - held.contradictedAtMs;
  if (contradictedForMs >= HELD_READING_FREEZE_MS) return 'frozen';
  return contradictedForMs >= HELD_READING_SUSPECT_MS ? 'suspected' : 'unsuspected';
}

/**
 * The hold after one admitted sample, logging the verdict when it changes. A
 * new value, 0 W, or a reset of sampling starts a new one. A frozen hold
 * carries unchanged. Otherwise the baseline follows the draw while it is not
 * to be judged, and after that each sample either extends the run of samples
 * whose draw has moved past the threshold or ends it.
 */
export function resolveNextHeldReading(
  state: PowerTrackerState,
  currentPowerW: number,
  managedDraw: ManagedLoadDraw,
  nowMs: number,
  resetSampling: boolean,
): HeldReading {
  const next = resolveNextHold(state.heldReading, currentPowerW, managedDraw, nowMs, resetSampling);
  logVerdictChange(state, next, managedDraw);
  return next;
}

function resolveNextHold(
  held: HeldReading | undefined,
  currentPowerW: number,
  managedDraw: ManagedLoadDraw,
  nowMs: number,
  resetSampling: boolean,
): HeldReading {
  if (resetSampling || currentPowerW === 0 || held === undefined || held.powerW !== currentPowerW) {
    return {
      powerW: currentPowerW,
      sinceMs: nowMs,
      atMs: nowMs,
      baseline: managedDraw,
      contradictedAtMs: null,
      longHoldEndedAtMs: resolveLongHoldEndedAtMs(held, nowMs),
    };
  }
  if (resolveVerdict(held) === 'frozen') return { ...held, atMs: nowMs };
  if (!isJudged(held, managedDraw, nowMs)) {
    return { ...held, atMs: nowMs, baseline: managedDraw, contradictedAtMs: null };
  }
  const thresholdW = Math.max(MIN_CONTRADICTING_DRAW_W, Math.abs(currentPowerW) * CONTRADICTING_DRAW_SHARE);
  const moved = Math.abs(managedDraw.totalW - held.baseline.totalW) >= thresholdW;
  return { ...held, atMs: nowMs, contradictedAtMs: moved ? (held.contradictedAtMs ?? nowMs) : null };
}

/** Whether this sample's draw may contradict the hold, rather than move its baseline. */
function isJudged(held: HeldReading, managedDraw: ManagedLoadDraw, nowMs: number): boolean {
  if (held.baseline.loadKey !== managedDraw.loadKey) return false;
  if (nowMs - held.sinceMs < HELD_READING_SETTLE_MS) return false;
  return held.longHoldEndedAtMs === null || nowMs - held.longHoldEndedAtMs >= HELD_READING_LONG_HOLD_MEMORY_MS;
}

/** The long-hold memory a new hold starts with, from the hold that just ended. */
function resolveLongHoldEndedAtMs(ended: HeldReading | undefined, nowMs: number): number | null {
  if (ended === undefined) return null;
  const endedLongAndClean = resolveVerdict(ended) === 'unsuspected'
    && ended.atMs - ended.sinceMs >= HELD_READING_LONG_HOLD_MS;
  return endedLongAndClean ? nowMs : ended.longHoldEndedAtMs;
}

/** `ManagedLoadDraw.loadKey`: 32-bit FNV-1a over the sorted load ids. */
export function resolveManagedLoadKey(deviceIds: readonly string[]): number {
  let hash = 0x811c9dc5;
  const sortedIds = [...deviceIds].sort();
  for (const id of sortedIds) {
    for (let index = 0; index < id.length; index += 1) {
      hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0;
    }
    hash = Math.imul(hash ^ 0x0a, 0x01000193) >>> 0;
  }
  return hash;
}

/** When the frozen reading took its value, or `null` while the reading is not frozen. */
export function resolveFrozenSinceMs(tracker: PowerTrackerState): number | null {
  const held = tracker.heldReading;
  return held !== undefined && resolveVerdict(held) === 'frozen' ? held.sinceMs : null;
}

/** When the suspect reading took its value (a frozen one included), or `null` while it is not suspect. */
export function resolveSuspectSinceMs(tracker: PowerTrackerState): number | null {
  const held = tracker.heldReading;
  return held !== undefined && resolveVerdict(held) !== 'unsuspected' ? held.sinceMs : null;
}

/**
 * A suspect reading that just moved again leaves a stretch unreliable, so the
 * learners that skip unreliable periods skip it too: the whole hold when the
 * reading was frozen (the energy booked across it came from one value the
 * meter had stopped updating), and only the contradicted run when it was
 * merely suspect. Flagged, never dropped (owner ruling 2026-09-24: never cut
 * a stretch out of the step integration).
 */
export function withEndedSuspectStretch(
  unreliablePeriods: PowerTrackerState['unreliablePeriods'],
  ended: HeldReading | undefined,
  next: HeldReading,
): PowerTrackerState['unreliablePeriods'] {
  if (ended === undefined || next.sinceMs <= ended.sinceMs) return unreliablePeriods;
  return withSuspectStretch(unreliablePeriods, ended, next.sinceMs);
}

/**
 * The same, for a hold a sampling reset ended: nothing was booked across the
 * gap after its last sample, so the stretch ends at that sample.
 */
export function withSuspectStretchBeforeReset(
  unreliablePeriods: PowerTrackerState['unreliablePeriods'],
  ended: HeldReading | undefined,
): PowerTrackerState['unreliablePeriods'] {
  return ended === undefined ? unreliablePeriods : withSuspectStretch(unreliablePeriods, ended, ended.atMs);
}

function withSuspectStretch(
  unreliablePeriods: PowerTrackerState['unreliablePeriods'],
  ended: HeldReading,
  endMs: number,
): PowerTrackerState['unreliablePeriods'] {
  const start = resolveSuspectStretchStartMs(ended);
  return start === null ? unreliablePeriods : [...(unreliablePeriods ?? []), { start, end: endMs }];
}

function resolveSuspectStretchStartMs(held: HeldReading): number | null {
  const verdict = resolveVerdict(held);
  if (verdict === 'frozen') return held.sinceMs;
  return verdict === 'suspected' ? held.contradictedAtMs : null;
}

/**
 * The tracker a restart hands back: a frozen verdict stands, since the meter
 * was shown dead and the pass it owes protects the cap, but a suspicion is
 * earned again. The time the app was down was never observed, and counting it
 * towards the run could freeze a reading on the first sample after boot.
 */
export function withHeldReadingAfterRestart(state: PowerTrackerState): PowerTrackerState {
  const held = state.heldReading;
  if (held === undefined || held.contradictedAtMs === null || resolveVerdict(held) === 'frozen') return state;
  return { ...state, heldReading: { ...held, contradictedAtMs: null } };
}

/**
 * The one trace a held reading leaves: its verdict changing, with the numbers
 * it was judged on and, for a sub-home, the meter it belongs to. Without it a
 * pass the frozen rule triggered reads in the logs like any silent meter, and
 * a false suspicion cannot be told from a true one.
 */
function logVerdictChange(before: PowerTrackerState, next: HeldReading, managedDraw: ManagedLoadDraw): void {
  const from = resolveVerdict(before.heldReading);
  const to = resolveVerdict(next);
  if (from === to) return;
  const fields = {
    event: 'whole_home_reading_verdict_changed',
    from,
    to,
    powerW: next.powerW,
    heldSinceMs: next.sinceMs,
    contradictedAtMs: next.contradictedAtMs,
    baselineDrawW: next.baseline.totalW,
    measuredDrawW: managedDraw.totalW,
    ...(before.meterIdentity === undefined ? {} : { meterDeviceId: before.meterIdentity.meterDeviceId }),
  };
  if (to === 'frozen') heldReadingLogger.warn(fields);
  else heldReadingLogger.info(fields);
}
