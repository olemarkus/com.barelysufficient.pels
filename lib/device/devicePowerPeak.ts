/**
 * The learned measured peak: the highest draw PELS has actually observed from a
 * device, on a rolling window.
 *
 * Pure policy, no I/O. `lib/device/managerRuntime.updateLastKnownPower` owns the
 * mutation and `lib/device/devicePowerEstimate` reads it as one rung of the
 * expected-power ladder. Persistence is a settings-boundary concern and lives
 * on `setup/settingsRepository.ts`, which uses the parsers at the bottom of this
 * file to validate what it loads.
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
 * the same inversion recorded against per-capability staleness in `TODO.md`.
 * `observedAtMs` here is when PELS took the reading, not when the device last
 * changed its mind.
 */

/**
 * How long a learned peak stands without being re-observed. 30 days: a water
 * heater, EV charger, or panel heater that is in service at all reaches its peak
 * far more often than monthly, so an entry that goes this long unmatched
 * describes a device whose duty has genuinely changed (or a spike that never
 * repeated).
 */
export const PEAK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type LearnedPeak = {
  kw: number;
  observedAtMs: number;
};

export type LearnedPeaksByDeviceId = Record<string, LearnedPeak>;

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

/**
 * The entry to store for a new reading, or `null` to leave the store untouched.
 *
 * Three cases, and the third is the whole point of the window:
 * - no entry yet → the reading anchors one;
 * - reading at or above the standing peak → it IS the peak, and re-anchors the
 *   window (so a device that keeps reaching its peak never expires);
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
  if (measuredKw >= peak.kw) return { kw: measuredKw, observedAtMs: nowMs };
  return isExpired(peak, nowMs) ? { kw: measuredKw, observedAtMs: nowMs } : null;
};

/**
 * Drop entries whose window closed long enough ago that they can no longer
 * become relevant. Used by the persistence prune so the stored record does not
 * accumulate devices the user removed years ago; NOT used on the read path,
 * where `resolveLearnedPeakKw` already answers `null` for an expired entry.
 */
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

export type ExpectedPowerOverride = { kw: number; ts: number };
export type ExpectedPowerOverridesByDeviceId = Record<string, ExpectedPowerOverride>;

const isFinitePositive = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

const isFiniteTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/**
 * Validate a persisted learned-peak record at the settings boundary.
 *
 * Entry-wise, not all-or-nothing: one corrupt device must not discard the
 * learning for every other device. A rejected entry is simply absent, and the
 * ladder falls through for that device alone.
 *
 * An EMPTY device id is rejected with the rest. No Homey device has one, so an
 * entry keyed on `''` is corruption; keeping it would put a peak in the record
 * that nothing can ever look up and that the prune can only drop by expiry.
 */
export const parseLearnedPeaks = (raw: unknown): LearnedPeaksByDeviceId => {
  const record = asRecord(raw);
  if (!record) return {};
  const parsed: LearnedPeaksByDeviceId = {};
  for (const [deviceId, value] of Object.entries(record)) {
    if (!deviceId) continue;
    const entry = asRecord(value);
    if (!entry) continue;
    if (!isFinitePositive(entry.kw) || !isFiniteTimestamp(entry.observedAtMs)) continue;
    parsed[deviceId] = { kw: entry.kw, observedAtMs: entry.observedAtMs };
  }
  return parsed;
};

/**
 * Validate a persisted manual-override record at the settings boundary. Same
 * entry-wise rule as `parseLearnedPeaks`, and the same reason: this is the
 * owner's own figure for a device, and one bad neighbour must not erase it.
 * The empty device id is rejected here too, and for the same reason.
 */
export const parseExpectedPowerOverrides = (raw: unknown): ExpectedPowerOverridesByDeviceId => {
  const record = asRecord(raw);
  if (!record) return {};
  const parsed: ExpectedPowerOverridesByDeviceId = {};
  for (const [deviceId, value] of Object.entries(record)) {
    if (!deviceId) continue;
    const entry = asRecord(value);
    if (!entry) continue;
    if (!isFinitePositive(entry.kw) || !isFiniteTimestamp(entry.ts)) continue;
    parsed[deviceId] = { kw: entry.kw, ts: entry.ts };
  }
  return parsed;
};

/**
 * What one settings read of a persisted power record actually saw.
 *
 * Gathered by the settings adapter (`setup/settingsRepository.ts`) and consumed
 * by the classifiers below, so all Homey provenance is spent in one place. The
 * key list is load-bearing: `homey.settings.get()` answers an unset key with
 * `null` (NOT `undefined`), so an absent value on its own cannot tell "never
 * written" from "the read failed" — only a healthy, non-empty key list that does
 * not carry the key proves absence (`setup/AGENTS.md`).
 */
export type PersistedRecordReadEvidence = {
  raw: unknown;
  keyPresent: boolean;
  keyListEmpty: boolean;
};

/**
 * The learned peaks as a settings read can honestly report them.
 *
 * A RESOLVED EMPTY record is a real answer — a home that has never observed a
 * peak, or one whose entries all aged out — and it must NOT be folded into
 * `unavailable`, or such an install would have its write-back suppressed for
 * good. `unavailable` says the opposite: nothing is known, so the caller may
 * neither adopt it nor write over it.
 *
 * Collapsing the two is what made this a data-loss bug rather than a nuisance.
 * `undefined`, `null`, a malformed value and a thrown read all used to arrive as
 * `{}`; on a cold boot the in-memory record is empty too, so the "empty parse
 * while non-empty state is held" guard could not fire, and the next write
 * replaced a perfectly good persisted record with nothing.
 */
export type LearnedPeaksRead =
  | { state: 'resolved'; peaks: LearnedPeaksByDeviceId }
  | { state: 'unavailable' };

/** The owner's manual figures, on the same resolved/unavailable contract. */
export type ExpectedPowerOverridesRead =
  | { state: 'resolved'; overrides: ExpectedPowerOverridesByDeviceId }
  | { state: 'unavailable' };

/**
 * Absence is only trustworthy when a healthy key list vouches for it. An empty
 * key list is the SDK saying nothing at all, and a list that carries the key
 * while the value reads empty is a miss — both stay unavailable.
 */
const isConfirmedAbsence = (evidence: PersistedRecordReadEvidence): boolean => (
  !evidence.keyListEmpty && !evidence.keyPresent
);

const isAbsentRead = (raw: unknown): boolean => raw === undefined || raw === null;

export const classifyLearnedPeaksSetting = (
  evidence: PersistedRecordReadEvidence,
): LearnedPeaksRead => {
  const record = asRecord(evidence.raw);
  if (record) return { state: 'resolved', peaks: parseLearnedPeaks(record) };
  if (isAbsentRead(evidence.raw)) {
    return isConfirmedAbsence(evidence) ? { state: 'resolved', peaks: {} } : { state: 'unavailable' };
  }
  // A string, number or array under this key is not a record PELS wrote. It is
  // not absence either, so answering "no peaks" would license overwriting it.
  return { state: 'unavailable' };
};

export const classifyExpectedPowerOverridesSetting = (
  evidence: PersistedRecordReadEvidence,
): ExpectedPowerOverridesRead => {
  const record = asRecord(evidence.raw);
  if (record) return { state: 'resolved', overrides: parseExpectedPowerOverrides(record) };
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
 * `nextLearnedPeak` — which keeps the higher figure, re-anchors on a match, and
 * lets a lower held reading win only once the persisted entry's window has
 * closed unmatched.
 */
export const adoptPersistedLearnedPeaks = (
  persisted: LearnedPeaksByDeviceId,
  held: LearnedPeaksByDeviceId,
): LearnedPeaksByDeviceId => {
  const merged: LearnedPeaksByDeviceId = { ...persisted };
  for (const [deviceId, heldPeak] of Object.entries(held)) {
    const next = nextLearnedPeak(merged[deviceId], heldPeak.kw, heldPeak.observedAtMs);
    if (next) merged[deviceId] = next;
  }
  return merged;
};
