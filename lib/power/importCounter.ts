import { getLogger } from '../logging/logger';
import type { MeterImportCounter } from '../ports/homeMeterReadings';
import type { ImportCounterAnchor, PowerTrackerState } from './trackerTypes';
import { MAX_PLAUSIBLE_WHOLE_HOME_POWER_W } from './wholeHomePowerPlausibility';

/**
 * When the whole-home meter's cumulative import counter may stand in for
 * readings PELS did not take: `lib/power` decides, because `lib/power` owns
 * the meter.
 *
 * The tracker books energy by holding each reading until the next one. Across
 * a gap (the app was stopped, restarted or updated) that books the last
 * reading before the gap for its whole length, whatever the home drew. The
 * meter kept counting meanwhile, so the step of its counter across the gap is
 * the import the gap really had.
 *
 * A counter value is only as good as the meter that published it, and a meter
 * can publish a wrong one (a value ten kilowatt-hours low for an hour, or three
 * million high). So the tracker keeps the counter it last accepted beside the
 * import it has booked since (`ImportCounterAnchor`), and:
 * - the counter's steps seen while sampling are checked, a quarter
 *   kilowatt-hour at a time, against what the tracker booked over the same
 *   stretch. A step that goes backwards, or a stretch that disagrees, leaves
 *   the counter unverified until a later stretch agrees;
 * - a gap is filled from the counter only between a verified value from before
 *   the gap and a value the meter changed after it began, and only when the
 *   step is not negative and no more than the home could have drawn.
 * Anything else falls back to the held reading.
 *
 * The counter says how much was imported up to when the meter last changed it,
 * which is not when PELS read it: a meter may publish the counter every few
 * seconds or once an hour. Each value is therefore taken at its own time
 * (`observedAtMs`). The gap is filled from the counter up to that time and
 * from the held reading after it, so a counter that only moves on the hour
 * recovers the part of a gap before the hour and no more.
 */

/** The import the tracker booked for one sample interval, the last reading held from `heldFromMs`. */
export type BookedImport = {
  readonly importKWh: number;
  readonly heldFromMs: number;
  readonly endMs: number;
  /** W; the held reading floored at 0. */
  readonly heldPowerW: number;
};

/** The start of a gap, as the counter fills it: `energyKWh` over the time up to `coveredUntilMs`. */
export type RecoveredGapImport = {
  readonly energyKWh: number;
  readonly coveredUntilMs: number;
};

/** A longer wait than this between two readings is a gap the counter may fill. */
export const IMPORT_GAP_MIN_MS = 60 * 1000;

/** How much the counter must have stepped, or the tracker booked, before the two are compared. */
const VERIFY_MIN_KWH = 0.25;

/** Counter steps and the booked import agree within this, or within a tenth of the larger. */
const AGREEMENT_SLACK_KWH = 0.03;
const AGREEMENT_SHARE = 0.1;

/**
 * The most a home can plausibly have averaged across a gap: three times its
 * highest retained hour, and at least 20 kW so a new home's first gap is not
 * judged against an empty history.
 */
const ENVELOPE_PEAK_HOUR_MULTIPLE = 3;
const ENVELOPE_FLOOR_KW = 20;

const logger = getLogger('power/import-counter');

const HOUR_MS = 3_600_000;

function resolveImportEnvelopeKw(state: PowerTrackerState): number {
  let peakHourKWh = 0;
  for (const kWh of Object.values(state.buckets ?? {})) {
    if (kWh > peakHourKWh) peakHourKWh = kWh;
  }
  return Math.min(
    MAX_PLAUSIBLE_WHOLE_HOME_POWER_W / 1000,
    Math.max(ENVELOPE_FLOOR_KW, peakHourKWh * ENVELOPE_PEAK_HOUR_MULTIPLE),
  );
}

type GapVerdict = RecoveredGapImport | 'unverified' | 'other_meter' | 'unchanged' | 'backwards' | 'implausible';

function judgeGapImport(
  state: PowerTrackerState,
  anchor: ImportCounterAnchor,
  observation: MeterImportCounter,
  gapStartMs: number,
  gapEndMs: number,
): GapVerdict {
  if (anchor.meterDeviceId !== observation.meterDeviceId) return 'other_meter';
  if (!anchor.verified || anchor.observedAtMs > gapStartMs) return 'unverified';
  const coveredUntilMs = Math.min(observation.observedAtMs, gapEndMs);
  const stepKWh = observation.importedKWh - anchor.importedKWh;
  // A value republished unchanged says the import stayed under the counter's
  // resolution, not that it was zero.
  if (coveredUntilMs <= gapStartMs || stepKWh === 0) return 'unchanged';
  const energyKWh = stepKWh - anchor.bookedSinceKWh;
  if (stepKWh < 0 || energyKWh < -AGREEMENT_SLACK_KWH) return 'backwards';
  const coveredHours = (coveredUntilMs - gapStartMs) / HOUR_MS;
  if (energyKWh > resolveImportEnvelopeKw(state) * coveredHours + AGREEMENT_SLACK_KWH) return 'implausible';
  return { energyKWh: Math.max(0, energyKWh), coveredUntilMs };
}

/**
 * The import the counter vouches for at the start of the gap
 * `[gapStartMs, gapEndMs]`, or `null` when the gap is filled from the held
 * reading alone: no counter came with this sample or none was held, the held
 * one is unverified or another meter's, the counter has not changed since the
 * gap began, or the step is negative or more than the home can draw.
 */
export function resolveGapImport(
  state: PowerTrackerState,
  observation: MeterImportCounter | undefined,
  gapStartMs: number,
  gapEndMs: number,
): RecoveredGapImport | null {
  const anchor = state.importCounter;
  if (anchor === undefined || observation === undefined) return null;
  const verdict = judgeGapImport(state, anchor, observation, gapStartMs, gapEndMs);
  const fields = {
    meterDeviceId: observation.meterDeviceId,
    gapStartMs,
    gapEndMs,
    counterStepKWh: observation.importedKWh - anchor.importedKWh,
    bookedSinceKWh: anchor.bookedSinceKWh,
  };
  if (typeof verdict === 'string') {
    logger.info({ event: 'gap_import_held_reading_kept', reasonCode: verdict, ...fields });
    return null;
  }
  logger.info({ event: 'gap_import_recovered', ...verdict, ...fields });
  return verdict;
}

const unverified = (observation: MeterImportCounter, bookedSinceKWh: number): ImportCounterAnchor => (
  { ...observation, bookedSinceKWh, verified: false, pendingStepKWh: 0, pendingBookedKWh: 0 }
);

/**
 * The accepted counter after one sample. `booked` is the import the sample
 * booked, or `null` when it booked none because sampling was reset.
 *
 * An unchanged value keeps its time and adds to what was booked since. A new
 * value replaces it, and its step joins the stretch being compared with the
 * import booked up to the time the meter changed it; what the sample booked
 * after that time is the held reading's, and starts the new count.
 */
export function resolveNextImportCounter(
  anchor: ImportCounterAnchor | undefined,
  observation: MeterImportCounter | undefined,
  booked: BookedImport | null,
): ImportCounterAnchor | undefined {
  if (booked === null) return observation === undefined ? undefined : unverified(observation, 0);
  if (observation === undefined) {
    return anchor === undefined ? undefined : { ...anchor, bookedSinceKWh: anchor.bookedSinceKWh + booked.importKWh };
  }
  const heldSinceMs = Math.min(booked.endMs, Math.max(booked.heldFromMs, observation.observedAtMs));
  const bookedAfterKWh = Math.min(
    booked.importKWh,
    (booked.heldPowerW / 1000) * ((booked.endMs - heldSinceMs) / HOUR_MS),
  );
  if (anchor === undefined || anchor.meterDeviceId !== observation.meterDeviceId
    || observation.observedAtMs < anchor.observedAtMs) {
    return unverified(observation, bookedAfterKWh);
  }
  if (observation.importedKWh === anchor.importedKWh) {
    return { ...anchor, bookedSinceKWh: anchor.bookedSinceKWh + booked.importKWh };
  }
  const stepKWh = observation.importedKWh - anchor.importedKWh;
  if (stepKWh < 0) return unverified(observation, bookedAfterKWh);
  // Steps are judged a quarter kilowatt-hour at a time: one step of a counter
  // that moves every few seconds is smaller than its own rounding, and agrees
  // with anything.
  const pendingStepKWh = anchor.pendingStepKWh + stepKWh;
  const pendingBookedKWh = anchor.pendingBookedKWh + anchor.bookedSinceKWh + booked.importKWh - bookedAfterKWh;
  const next = { ...observation, bookedSinceKWh: bookedAfterKWh };
  const judgedKWh = Math.max(pendingStepKWh, pendingBookedKWh);
  if (judgedKWh < VERIFY_MIN_KWH) return { ...next, verified: anchor.verified, pendingStepKWh, pendingBookedKWh };
  const verified = Math.abs(pendingStepKWh - pendingBookedKWh)
    <= Math.max(AGREEMENT_SLACK_KWH, AGREEMENT_SHARE * judgedKWh);
  return { ...next, verified, pendingStepKWh: 0, pendingBookedKWh: 0 };
}
