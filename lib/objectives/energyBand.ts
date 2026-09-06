import { OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS } from './bands';
import type { DeviceObjectiveProfile } from './types';

/**
 * Is this window's kWh per unit credible *for this device*?
 *
 * Every window pairs a rise in the observed value with the energy billed across
 * it. Not every rise is representative of what the device ordinarily costs:
 * draw hot water and the tank refills with cold, so recovering the same degree
 * costs several times what plain heating does; a charge report recalibrates and
 * the reported level steps without the matching energy having gone in; a door
 * left open, a leak, a heater fighting a cold room all bill far more energy than
 * the value that appeared. Learning any of them poisons the rate, and every
 * future smart task sized from that rate is wrong.
 *
 * What all of them have in common is only visible against the device's own
 * history: the window's kWh/unit sits far outside what this device has needed
 * before. That is the whole test, and it needs no cause, no unit and no device
 * type — the requirement of this layer, where a degree and a percent are the
 * same thing.
 *
 * ## A ratio, not a difference
 *
 * "Far outside" for a rate on a positive scale means a MULTIPLE, not an offset:
 * a tank at 0.23 kWh/°C and a car at 0.5 kWh/% have no shared step size, and the
 * only statement that travels between them is "this window cost N times what the
 * device usually needs". So the band is computed on the logarithm of the rate and
 * is symmetric in that ratio.
 *
 * ## Two-sided, because the poisoning is
 *
 * The obvious contamination is a window that costs abnormally *much* — the
 * refill, the open door. The mirror image is just as poisonous and reads the
 * opposite way: a report that steps credits units nobody paid for, so the window
 * comes out abnormally *cheap*. A ceiling alone learns that one happily and drags
 * the rate down.
 *
 * ## Robust, because the band judges its own inputs
 *
 * A contaminated window that slips through joins the history the next window is
 * judged against, and a mean-and-sigma band would then widen twice over — the
 * mean drifts toward the outlier and sigma, being squared error, leaps toward
 * it — admitting more contamination each round. So the centre is the MEDIAN of
 * the buffered observations and the spread is the MEDIAN ABSOLUTE DEVIATION,
 * both of which need more than half the history to be contaminated before they
 * move at all. One bad sample that gets in shifts the centre by one rank and the
 * spread barely at all; the loop cannot run away.
 *
 * That robustness is also why the band is trusted on sample COUNT alone and not
 * on the profile's `confidence`. Confidence is a relative-standard-deviation
 * verdict, so contamination degrades it — gating on it would arm this test last
 * on exactly the devices whose history is dirtiest, which is backwards.
 */

// Below this many buffered observations the device has no distribution of its
// own worth being judged against: a median over three points is a point, and
// three contaminated windows would define the band for everything after. The
// coarse bootstrap ceiling covers this stretch instead. It is also the width at
// which a median tolerates a minority of bad samples — with 8, three
// contaminated windows still leave the centre inside the clean cluster.
export const OBJECTIVE_PROFILE_MIN_BAND_HISTORY = 8;

// Bootstrap sanity bound, in kWh per unit, used ONLY while the profile is too
// young for a band of its own. It is a fleet-wide number and therefore says
// almost nothing about any particular device — a 200 L tank needs ~0.23 kWh/°C
// and an EV ~0.5 kWh/%, so this sits an order of magnitude above anything
// physical and catches only mis-paired power and outright junk. That weakness
// is why it is not the steady-state test; a fresh profile still needs some
// bound, and this is it.
export const OBJECTIVE_PROFILE_BOOTSTRAP_MAX_KWH_PER_UNIT = 5;

/**
 * Floor on the band's half-width, as a ratio: a device is always allowed to cost
 * anywhere from a quarter to four times its own median before a window is called
 * contaminated.
 *
 * The floor exists because a run of near-identical observations is ambiguous.
 * Zero spread can mean the device really is that consistent, or that it has only
 * shown one of its regimes so far — and nothing in the history distinguishes
 * them. A stepped heater that has spent ten hours on its low step and then moves
 * to a high one changes its kWh/unit for entirely honest reasons
 * (`notes/objective-profile-bands.md` records a fitted two-regime device whose
 * bands sit at 1 and 3 kWh/°C), and a band derived from the low regime alone
 * must not lock the high one out of ever being learned. Four is chosen to clear
 * that recorded 3× regime change with margin.
 *
 * It is still far tighter than the fleet-wide ceiling it replaces, which for a
 * 0.23 kWh/°C tank stood at twenty-one times the device's own rate.
 */
const MIN_BAND_RATIO = 4;

// Half-width in log space, in robust sigmas. This term binds only for a device
// whose own observations already span more than the ratio floor — a genuinely
// multi-regime device, where the evidence for a wide band is in the buffer. For
// an ordinary device the floor above governs and this contributes nothing.
const ROBUST_DEVIATION_MULTIPLE = 3;

// Median absolute deviation → standard-deviation equivalent for normally
// distributed data, so `ROBUST_DEVIATION_MULTIPLE` reads as "sigmas".
const MAD_TO_STD_DEV = 1.4826;

export type EnergyPerUnitBandBasis = 'bootstrap' | 'learned';

export type EnergyPerUnitBand = {
  basis: EnergyPerUnitBandBasis;
  lowerKwhPerUnit: number;
  upperKwhPerUnit: number;
};

/**
 * The credible kWh/unit range for this device's next window, from its own recent
 * accepted history. Computed from the profile as it stands *before* the
 * candidate window is folded in, so a window is never judged against itself, and
 * anchored on `nowMs` — the candidate's own observation time — so the horizon
 * moves with the device rather than with whatever last happened to write the
 * profile.
 *
 * A profile written by a build that predates the sample buffer carries lifetime
 * `kwhPerUnit` statistics but no observations, and reads as bootstrap until
 * eight windows have refilled the buffer. That is deliberate: the lifetime mean
 * and `m2` are a running Welford pair with no raw samples behind them, so
 * nothing robust can be recovered from them, and reaching for them would put a
 * mean-and-sigma band — the one this module exists to avoid — back in the path.
 *
 * The horizon is applied HERE as well as when the buffer is written
 * (`appendSampleToBuffer`), and the two are not redundant. The write-side prune
 * is what keeps the estimator's own history recent; this read-side filter is the
 * one that runs when there are no writes left — a device refusing every window
 * appends nothing, so nothing would ever prune it out of its own lockout.
 */
export function resolveEnergyPerUnitBand(
  profile: DeviceObjectiveProfile,
  nowMs: number,
): EnergyPerUnitBand {
  const horizonStartMs = nowMs - OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS;
  const logRates = (profile.samples ?? [])
    .filter((sample) => (
      sample.observedAtMs >= horizonStartMs
      && Number.isFinite(sample.kwhPerUnit)
      && sample.kwhPerUnit > 0
    ))
    .map((sample) => Math.log(sample.kwhPerUnit));
  if (logRates.length < OBJECTIVE_PROFILE_MIN_BAND_HISTORY) return bootstrapBand();
  const centreLog = median(logRates);
  if (!Number.isFinite(centreLog)) return bootstrapBand();
  const spreadLog = MAD_TO_STD_DEV * median(logRates.map((rate) => Math.abs(rate - centreLog)));
  const halfWidthLog = Math.max(ROBUST_DEVIATION_MULTIPLE * spreadLog, Math.log(MIN_BAND_RATIO));
  return {
    basis: 'learned',
    lowerKwhPerUnit: Math.exp(centreLog - halfWidthLog),
    upperKwhPerUnit: Math.exp(centreLog + halfWidthLog),
  };
}

export function isWithinEnergyPerUnitBand(band: EnergyPerUnitBand, kwhPerUnit: number): boolean {
  return kwhPerUnit >= band.lowerKwhPerUnit && kwhPerUnit <= band.upperKwhPerUnit;
}

function bootstrapBand(): EnergyPerUnitBand {
  return {
    basis: 'bootstrap',
    lowerKwhPerUnit: 0,
    upperKwhPerUnit: OBJECTIVE_PROFILE_BOOTSTRAP_MAX_KWH_PER_UNIT,
  };
}

// Callers pass a non-empty array; an empty one has no central value to report
// and returning 0 would read as a real centre.
function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return Number.NaN;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}
