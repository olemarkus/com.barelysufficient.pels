/**
 * The learned measured peak: the highest draw PELS has actually observed from a
 * device, on a rolling window.
 *
 * Pure policy, no I/O. `lib/device/managerRuntime.updateLastKnownPower` and
 * `pruneMissingLearnedPeaks` own mutation; `lib/device/devicePowerEstimate`
 * reads it as one rung of the expected-power ladder. Persistence lives in the
 * userdata store (`lib/device/learnedPowerPeakStore.ts`), which validates each
 * row with the same shape and ceiling checks as the legacy settings import.
 *
 * WHY A WINDOW. The peak used to be a monotonic max held only in memory, which
 * made a one-off spike survive until the next restart and no longer. Persisting
 * it without a window would have promoted that accident to permanent: a heat gun
 * plugged into the water heater's socket once would pin the estimate at its draw
 * for the life of the install, with no way back except the manual override.
 *
 * WHY THE WINDOW IS ANCHORED ON OBSERVATION TIME, NOT `lastUpdated`. Homey
 * reports capabilities ON CHANGE, so a device sitting steady at its peak stops
 * republishing and its `lastUpdated` ages without anything having happened.
 * Keying expiry on that would retire the peak of the steadiest devices first —
 * the same inversion that keying per-capability staleness on `lastUpdated`
 * produces.
 * `observedAtMs` here is when PELS took the reading, not when the device last
 * changed its mind.
 *
 * WHY ONE READING IS NOT A PEAK. A corrupt frame is a single observation: a
 * floor thermostat that draws 0.4 kW reported 88 kW once, under the plausible
 * ceiling, and the home then sized every restore of it against 88 kW. The level
 * recorded is therefore the third-highest of the device's last ten separate
 * readings (`rankedPeakLevelKw`), which are held in memory for the run.
 */
import type { DeviceExpectedPowerOverrides } from '../../packages/contracts/src/types';
import type { DevicePowerSources } from '../../packages/shared-domain/src/settings/devicePowerSources';
import { MAX_PLAUSIBLE_DEVICE_POWER_KW } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { asUnknownRecord } from '../../packages/shared-domain/src/recordGuards';

/**
 * How long a learned peak stands without being re-observed. 30 days: a water
 * heater, EV charger, or panel heater that is in service at all reaches its peak
 * far more often than monthly, so an entry that goes this long unmatched
 * describes a device whose duty has genuinely changed (or a spike that never
 * repeated).
 */
export const PEAK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How old the standing anchor must be before a reading that merely MATCHES the
 * peak moves it. Against a 30-day window, moving the anchor by less than a day
 * buys nothing: the peak still expires 29 to 30 days after it was last matched.
 * Every move changes the record, though, and a changed record is a write. A
 * device sitting at its rated power matches its peak on every reading, so moving
 * the anchor on each match made the peaks record the busiest settings writer in
 * production while it lived there (about 38 writes an hour on 2026-09-26, the
 * kW figures never changing).
 */
export const PEAK_REANCHOR_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type LearnedPeak = {
  kw: number;
  observedAtMs: number;
  /** Omitted only on rows that predate source tracking. */
  sourceDeviceId?: string;
};

export type LearnedPeaksByDeviceId = Record<string, LearnedPeak>;

/**
 * Drop peaks for devices that no longer exist. A snapshot with no devices does
 * not prove deletion: Homey can return an empty list on a transient read
 * failure, and that must not erase learned data. `device/managerRuntime` owns
 * this mutable record; callers provide only the resolved set of present IDs.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export const pruneMissingLearnedPeaks = (
  peaks: LearnedPeaksByDeviceId,
  presentDeviceIds: ReadonlySet<string>,
): void => {
  if (presentDeviceIds.size === 0) return;
  for (const deviceId of Object.keys(peaks)) {
    if (!presentDeviceIds.has(deviceId)) {
      // eslint-disable-next-line no-param-reassign
      delete peaks[deviceId];
    }
  }
};
/* eslint-enable functional/immutable-data */

const isExpired = (peak: LearnedPeak, nowMs: number): boolean => (
  nowMs - peak.observedAtMs > PEAK_WINDOW_MS
);

/**
 * The peak to use right now, or `null` when the window has closed on it.
 *
 * `null` is genuine absence — the ladder falls through to its next rung rather
 * than to a stale figure. An expired entry is deliberately NOT deleted on read:
 * the store is written by the ingest path, and a read that mutates would make
 * every consumer a writer.
 */
export const resolveLearnedPeakKw = (
  peak: LearnedPeak | undefined,
  nowMs: number,
): number | null => {
  if (!peak || peak.kw <= 0) return null;
  return isExpired(peak, nowMs) ? null : peak.kw;
};

export const learnedPeakForSource = (
  peak: LearnedPeak | undefined,
  deviceId: string,
  sourceDeviceId: string,
): LearnedPeak | undefined => (
  (peak?.sourceDeviceId ?? deviceId) === sourceDeviceId ? peak : undefined
);

/**
 * The entry to store for a new reading, or `null` to leave the store untouched.
 *
 * `measuredKw` is the level `resolvePeakLevelKw` named, or a persisted peak
 * being merged. Four cases, and the last is the whole point of the window:
 * - no entry yet → the reading anchors one;
 * - reading above the standing peak → it IS the peak, and re-anchors the window;
 * - reading that matches the standing peak → re-anchors the window once the
 *   anchor is {@link PEAK_REANCHOR_INTERVAL_MS} old, so a device that keeps
 *   reaching its peak never expires, and is otherwise ignored;
 * - reading below the standing peak → normally ignored, because a duty cycle
 *   dipping is not evidence the device got smaller. Once the standing peak has
 *   gone a whole window without being matched, the lower reading re-anchors
 *   instead, which is how an unrepeated spike ages out.
 */
export const nextLearnedPeak = (
  peak: LearnedPeak | undefined,
  measuredKw: number,
  nowMs: number,
): LearnedPeak | null => {
  if (!Number.isFinite(measuredKw) || measuredKw <= 0) return null;
  if (!peak) return { kw: measuredKw, observedAtMs: nowMs };
  if (measuredKw > peak.kw) return { kw: measuredKw, observedAtMs: nowMs };
  if (measuredKw === peak.kw) {
    return nowMs - peak.observedAtMs >= PEAK_REANCHOR_INTERVAL_MS ? { kw: measuredKw, observedAtMs: nowMs } : null;
  }
  return isExpired(peak, nowMs) ? { kw: measuredKw, observedAtMs: nowMs } : null;
};

/**
 * Below this a reading is standby noise, not evidence of what the device draws
 * when working: it is never a peak sample. 5 W.
 */
export const MIN_PEAK_LEARNING_KW = 0.005;

/** How many of a device's latest separate readings the peak level is read from. */
export const PEAK_SAMPLE_WINDOW = 10;

/**
 * Which of those readings, counted from the highest, is the level: the third.
 * Two corrupt readings among the ten therefore never reach the peak, whether or
 * not they resemble each other, and a device needs three readings before it has
 * a learned peak at all.
 */
export const PEAK_SAMPLE_RANK = 3;

/** What peak learning keeps of one device's readings during a run. */
export type PeakReadings = {
  /** The device's latest reading, standby included: the next one is new only if it differs. */
  lastKw: number;
  /** Its latest separate readings at or above `MIN_PEAK_LEARNING_KW`, oldest first. */
  samplesKw: readonly number[];
};

export type PeakReadingWindow = { sourceDeviceId: string; readings?: PeakReadings };

/**
 * A device's readings with one more taken into account.
 *
 * A reading is a new sample only when its value differs from the device's last
 * one. Homey re-dates a capability only when its value changes, and one report
 * reaches PELS more than once with different times (the live event at arrival,
 * the full read at Homey's own stamp), so neither the clock nor a count of
 * reads tells readings apart; a changed value does. A standby reading is no
 * sample but still counts as the last one, so a device that only ever reports
 * 0 W and one fixed draw gives a sample each time it runs.
 */
export const recordPeakReading = (readings: PeakReadings | undefined, kw: number): PeakReadings => {
  if (readings?.lastKw === kw) return readings;
  const samplesKw = readings?.samplesKw ?? [];
  return {
    lastKw: kw,
    samplesKw: kw >= MIN_PEAK_LEARNING_KW ? [...samplesKw, kw].slice(-PEAK_SAMPLE_WINDOW) : samplesKw,
  };
};

/**
 * The level a device's latest readings vouch for: the `PEAK_SAMPLE_RANK`-highest,
 * or `null` while there are too few readings to name one.
 */
export const rankedPeakLevelKw = (samplesKw: readonly number[]): number | null => (
  [...samplesKw].sort((left, right) => right - left)[PEAK_SAMPLE_RANK - 1] ?? null
);

/**
 * The level to record against the standing peak (`nextLearnedPeak`) for one
 * reading at or above `MIN_PEAK_LEARNING_KW`, or `null` for none.
 *
 * A reading at or below the standing peak needs no vouching: it can only match
 * the peak, which keeps a steady device's window open, or be ignored. Anything
 * above it, and any reading while there is no standing peak, goes by rank.
 */
export const resolvePeakLevelKw = (
  standingKw: number | null,
  samplesKw: readonly number[],
  measuredKw: number,
): number | null => (
  standingKw !== null && measuredKw <= standingKw ? measuredKw : rankedPeakLevelKw(samplesKw)
);

/**
 * Drop entries whose window closed long enough ago that they can no longer
 * become relevant. Used by the persistence prune so the stored record does not
 * accumulate devices the user removed years ago; NOT used on the read path,
 * where `resolveLearnedPeakKw` already answers `null` for an expired entry.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export const pruneExpiredLearnedPeaks = (
  peaks: LearnedPeaksByDeviceId,
  nowMs: number,
): LearnedPeaksByDeviceId => {
  const kept: LearnedPeaksByDeviceId = {};
  for (const [deviceId, peak] of Object.entries(peaks)) {
    if (!isExpired(peak, nowMs)) kept[deviceId] = peak;
  }
  return kept;
};
/* eslint-enable functional/immutable-data */

const isFinitePositive = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

const isFiniteTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

/** Decode the stored shape before applying the ceiling. Undefined means the id or peak is malformed. */
export const parseLearnedPeakEntry = (value: unknown, deviceId: string): LearnedPeak | undefined => {
  const entry = asUnknownRecord(value);
  if (!deviceId || !entry || !isFinitePositive(entry.kw) || !isFiniteTimestamp(entry.observedAtMs)) return undefined;
  const { sourceDeviceId } = entry;
  if (sourceDeviceId !== undefined && (typeof sourceDeviceId !== 'string' || sourceDeviceId.trim() === '')) {
    return undefined;
  }
  return {
    kw: entry.kw,
    observedAtMs: entry.observedAtMs,
    ...(sourceDeviceId === undefined ? {} : { sourceDeviceId }),
  };
};

/** The plausibility check shared by stored rows and the legacy settings import. */
export const exceedsLearnedPeakCeiling = (peak: LearnedPeak): boolean => peak.kw > MAX_PLAUSIBLE_DEVICE_POWER_KW;

/**
 * Decode the legacy learned-peak settings record using the same entry and ceiling checks as stored rows.
 *
 * Entry-wise, not all-or-nothing: one corrupt device must not discard the
 * learning for every other device. A rejected entry is simply absent, and the
 * ladder falls through for that device alone.
 *
 * An EMPTY device id is rejected with the rest. No Homey device has one, so an
 * entry keyed on `''` is corruption; keeping it would put a peak in the record
 * that nothing can ever look up and that the prune can only drop by expiry.
 *
 * A peak above the plausible device ceiling is rejected too: it was learned from
 * a corrupt reading before those were dropped, and dropping it here lets the
 * device learn its real peak instead of waiting out the window.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export const parseLearnedPeaks = (raw: unknown): LearnedPeaksByDeviceId => {
  const record = asUnknownRecord(raw);
  if (!record) return {};
  const parsed: LearnedPeaksByDeviceId = {};
  for (const [deviceId, value] of Object.entries(record)) {
    const entry = parseLearnedPeakEntry(value, deviceId);
    if (entry && !exceedsLearnedPeakCeiling(entry)) {
      parsed[deviceId] = { kw: entry.kw, observedAtMs: entry.observedAtMs };
    }
  }
  return parsed;
};
/* eslint-enable functional/immutable-data */

/**
 * Validate a persisted manual-override record at the settings boundary. Same
 * entry-wise rule as `parseLearnedPeaks`, and the same reason: this is the
 * owner's own figure for a device, and one bad neighbour must not erase it.
 * The empty device id is rejected here too, and for the same reason.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export const parseExpectedPowerOverrides = (raw: unknown): DeviceExpectedPowerOverrides => {
  const record = asUnknownRecord(raw);
  if (!record) return {};
  const parsed: DeviceExpectedPowerOverrides = {};
  for (const [deviceId, value] of Object.entries(record)) {
    if (!deviceId) continue;
    const entry = asUnknownRecord(value);
    if (!entry) continue;
    if (!isFinitePositive(entry.kw) || !isFiniteTimestamp(entry.ts)) continue;
    parsed[deviceId] = { kw: entry.kw, ts: entry.ts, origin: entry.origin === 'flow' ? 'flow' : 'settings' };
  }
  return parsed;
};
/* eslint-enable functional/immutable-data */

/**
 * What one settings read of a persisted power record actually saw.
 *
 * Gathered by the settings adapter (`setup/settingsRepository.ts`) and consumed
 * by the classifiers below, so all Homey provenance is spent in one place. The
 * key list is load-bearing: `homey.settings.get()` answers an unset key with
 * `null` (NOT `undefined`), so an absent value on its own cannot tell "never
 * written" from a stored null — only a key list that does not carry the key
 * proves absence (`setup/AGENTS.md`).
 */
export type PersistedRecordReadEvidence = {
  raw: unknown;
  keyPresent: boolean;
};

/**
 * The owner's manual figures as a settings read can honestly report them.
 *
 * A RESOLVED EMPTY record is a real answer — no figure set, or the owner cleared
 * the last one — and it must NOT be folded into `unavailable`, or such an install
 * would have its write-back suppressed for good. `unavailable` says the
 * opposite: nothing is known, so the caller may neither adopt it nor write over
 * it.
 *
 * Collapsing the two is a data-loss bug rather than a nuisance: `undefined`,
 * `null`, a malformed value and a thrown read all arriving as `{}` let the next
 * write replace a perfectly good persisted record with nothing (the learned
 * peaks lost weeks of learning this way while they lived in settings).
 *
 * The one empty parse that is NOT a real answer is a record that carried keys
 * and lost every one to validation — see `isWhollyUnparsableRecord`.
 */
export type ExpectedPowerOverridesRead =
  | { state: 'resolved'; overrides: DeviceExpectedPowerOverrides }
  | { state: 'unavailable' };

/**
 * Absence is only trustworthy when the key list vouches for it. A list that
 * carries the key while the value reads empty stays unavailable.
 */
const isConfirmedAbsence = (evidence: PersistedRecordReadEvidence): boolean => !evidence.keyPresent;

const isAbsentRead = (raw: unknown): boolean => raw === undefined || raw === null;

/**
 * A record that carried entries and lost EVERY one of them to validation is
 * corruption, not a clear.
 *
 * The parsers reject entry-wise on purpose, and that stays: while at least one
 * entry survives, the rest are simply absent and their devices fall through the
 * ladder. But a record whose keys ALL fail is the same case the branch below
 * already refuses — a value under this key that PELS did not write. Parsing it
 * down to `{}` and answering "resolved, nothing here" would license the very
 * overwrite that refusal exists to prevent, and would do it while looking
 * exactly like the one thing that must stay observable: `{}` really persisted,
 * which is how the owner clearing their last manual figure reaches disk.
 *
 * So the zero-key record keeps its meaning and only the wholly-unreadable one
 * changes: nothing is known about this key, so the caller may neither adopt it
 * nor write over it.
 */
const isWhollyUnparsableRecord = (
  raw: Record<string, unknown>,
  parsed: Record<string, unknown>,
): boolean => Object.keys(raw).length > 0 && Object.keys(parsed).length === 0;

export const classifyExpectedPowerOverridesSetting = (
  evidence: PersistedRecordReadEvidence,
): ExpectedPowerOverridesRead => {
  const record = asUnknownRecord(evidence.raw);
  if (record) {
    const overrides = parseExpectedPowerOverrides(record);
    return isWhollyUnparsableRecord(record, overrides)
      ? { state: 'unavailable' }
      : { state: 'resolved', overrides };
  }
  if (isAbsentRead(evidence.raw)) {
    return isConfirmedAbsence(evidence)
      ? { state: 'resolved', overrides: {} }
      : { state: 'unavailable' };
  }
  return { state: 'unavailable' };
};

/**
 * Reconcile a persisted record with the one this run already holds.
 *
 * Needed because the read that failed at boot is retried later, by which time
 * the ingest path may have learned peaks of its own. Taking either side whole
 * loses something real: the persisted side carries devices this run has not seen
 * draw power yet, and the held side carries what it just measured. So each
 * device is decided by the SAME standing-peak policy the ingest path uses —
 * `nextLearnedPeak` — which keeps the higher figure, re-anchors on a match once
 * the anchor is a day old (so never backward), and lets a lower held reading win
 * only once the persisted entry's window has closed unmatched.
 */
/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
export const adoptPersistedLearnedPeaks = (
  persisted: LearnedPeaksByDeviceId,
  held: LearnedPeaksByDeviceId,
  powerSources?: DevicePowerSources,
): LearnedPeaksByDeviceId => {
  const merged: LearnedPeaksByDeviceId = { ...persisted };
  for (const [deviceId, heldPeak] of Object.entries(held)) {
    const stored = merged[deviceId];
    const resolvedSource = powerSources ? powerSources[deviceId] ?? deviceId : undefined;
    const previous = learnedPeakForSource(stored, deviceId, heldPeak.sourceDeviceId ?? deviceId);
    if (!previous && resolvedSource && learnedPeakForSource(stored, deviceId, resolvedSource)) continue;
    const next = nextLearnedPeak(previous, heldPeak.kw, heldPeak.observedAtMs);
    if (next) merged[deviceId] = heldPeak;
  }
  return merged;
};
/* eslint-enable functional/immutable-data */
