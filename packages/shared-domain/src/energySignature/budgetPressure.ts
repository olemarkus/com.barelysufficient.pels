import type {
  BudgetPressureState,
  WeatherDailyRecord,
} from '../../../contracts/src/weatherAdvisorTypes';

/**
 * The budget-pressure loop: the integral half of the daily-budget suggestion.
 *
 * The energy signature is a *model* of what the home usually needs. It has real
 * blind spots — an away stretch sitting in the fit as ordinary warm-regime days,
 * a new EV, an occupancy change — and every one of them shows up the same way:
 * the suggested budget lands under real demand, the daily budget becomes the
 * binding pace constraint, and the home gets genuinely hurt while the model
 * happily reports a good fit. The residual headroom (`residualQ80`/`Q90`) is
 * proportional control: one fixed nudge that cannot track a mismatch bigger
 * than itself.
 *
 * This term closes the loop from cause-independent denied-energy evidence.
 * Whenever the configured budget is below sustainable capacity, every observed
 * unmet-demand span contributes even if the immediate refusal is labelled
 * hard-cap or cooldown. The daily overshoot measures how far the applied budget
 * missed real demand; quiet days decay the term.
 *
 * It composes with the residual headroom rather than duplicating it: the step is
 * measured against the budget that was actually applied, which already carried
 * that headroom, so what accumulates here is the error the proportional term
 * left behind.
 *
 * Layering: this is pure and browser-safe. It consumes only the flat evidence
 * already stamped on `WeatherDailyRecord` at rollup. Diagnostics never reaches
 * the planner — the loop's one and only output is the *suggested* budget, which
 * still passes through the user's auto-apply opt-in.
 */

/**
 * Legacy bar for records written before the denied-energy integral existed: a day
 * counted as suppressed past this much hold-time censoring. Those records keep
 * the meaning they were written with; integral-bearing records never reach it.
 */
const MIN_SUPPRESSION_MS = 60 * 60 * 1000;
/** One day may add at most this much, so the loop ramps instead of jumping. */
const MAX_STEP_KWH = 10;
/**
 * Leak applied on every day that did NOT overshoot its budget. A leaky
 * integrator is what keeps this honest: without it the term would only ever
 * grow, and it would never discover that the budget it pushed up is now more
 * than the home needs. Gentle enough that one mild day cannot undo a week of
 * evidence.
 */
const NO_OVERSHOOT_DECAY = 0.75;
/**
 * Below this the term is spent, and it snaps to EXACTLY zero. Load-bearing, not
 * cosmetic: 0.75^n never reaches zero, and a non-zero term keeps auto-apply's
 * lowering guard armed forever. Without the snap a home could never have its
 * budget automatically lowered again after one suppressed stretch.
 */
const NEGLIGIBLE_KWH = 0.25;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const isFinitePositive = (value: number | undefined): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

/** Energy the budget denied deadline-bound tasks that then missed, 0 when absent or junk. */
const deadlineMissDeniedKwhOf = (record: WeatherDailyRecord): number => {
  const value = record.suppression?.deadlineMissDeniedKwh;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * Did budget pressure deny energy on this day? An observed zero is
 * authoritative; only records predating the integral use legacy duration bars.
 *
 * Records written before the integral existed fall back to the legacy hold-time
 * bar, keeping the meaning they were written with.
 */
export function dayWasBudgetDamaged(record: WeatherDailyRecord): boolean {
  const suppression = record.suppression;
  if (!suppression) return false;
  // Deadline misses are independent evidence and remain additive to the
  // continuously observed device-demand integral.
  if (deadlineMissDeniedKwhOf(record) > 0) return true;
  if (suppression.budgetDenialObserved === true) {
    return deniedKwhOf(record) > 0;
  }
  // Retired day-close records can explicitly say their verdict was unwitnessed.
  // Preserve that historical no-damage result instead of applying older bars.
  if (suppression.budgetDeniedUnwitnessed === true) return false;
  return (suppression.targetDeficitMs ?? 0) >= MIN_SUPPRESSION_MS
    || (suppression.blockedByHeadroomMs ?? 0) >= MIN_SUPPRESSION_MS;
}

/** Integrated denied energy, 0 when absent or junk. */
const deniedKwhOf = (record: WeatherDailyRecord): number => {
  const value = record.suppression?.budgetDeniedKwh;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * How far the day overran the budget it was given, or `undefined` when that
 * cannot be measured (no kWh total, or no budget stamped — a boot catch-up
 * rolling up an older day deliberately stamps none rather than a stale one).
 */
export function measuredBudgetOvershootKwh(record: WeatherDailyRecord): number | undefined {
  // A day the power tracker flagged unreliable is not evidence. The fit already
  // refuses it, and this term WRITES A SETTING — the "stuck meter" case must not
  // be allowed to grow the budget through a gap the model itself distrusts.
  // (Checked inline rather than through `isUsableSignatureDay` to keep this
  // module free of a cycle with `energySignature.ts`, which imports from here.)
  if (record.quality.unreliablePower) return undefined;
  if (!isFinitePositive(record.appliedBudgetKwh)) return undefined;
  if (typeof record.kwhTotal !== 'number' || !Number.isFinite(record.kwhTotal)) return undefined;
  return Math.max(0, record.kwhTotal - record.appliedBudgetKwh);
}

/**
 * Folds one closed day into the term. Days at or before `throughDateKey` are
 * ignored, which makes repeat rollups and boot catch-ups idempotent — the loop
 * must integrate each day exactly once or a restart would inflate it.
 */
export function foldBudgetPressureDay(
  previous: BudgetPressureState | undefined,
  record: WeatherDailyRecord,
  /**
   * Anti-windup bound: the sustainable capacity energy for the local day. The
   * pressure may keep growing past an inaccurate model prediction, but never
   * past what the hard cap minus its safety margin can physically deliver.
   */
  applicableCeilingKwh?: number,
): BudgetPressureState {
  if (previous !== undefined && record.dateKey <= previous.throughDateKey) return previous;
  const ceilingKwh = isFinitePositive(applicableCeilingKwh)
    ? applicableCeilingKwh
    : Number.POSITIVE_INFINITY;
  const carried = Math.min(previous?.kwh ?? 0, ceilingKwh);
  // An undamaged day means no pressure, and that is true whether or not the
  // day's overshoot could be measured — so this check comes FIRST. Ordering it
  // after the unmeasurable-hold below froze the term forever once the owner
  // switched the daily budget off: with no budget there is nothing to stamp,
  // every day became "unmeasurable", and the term (which arms the auto-apply
  // lowering guard) could never decay again.
  //
  // This decays through a day that overshot
  // its budget but denied nothing. The overshoot alone says the estimate ran
  // low; if nobody was hurt, the budget needs no correction — the estimate for
  // tomorrow is the fit's job, not this term's.
  const decay = (): BudgetPressureState => {
    const decayed = carried * NO_OVERSHOOT_DECAY;
    return { kwh: decayed < NEGLIGIBLE_KWH ? 0 : decayed, throughDateKey: record.dateKey };
  };
  if (!dayWasBudgetDamaged(record)) return decay();
  const overshootKwh = measuredBudgetOvershootKwh(record);
  // The LARGER of the two denials, not their sum. They can describe
  // different holds — the continuous integral prices device demand, while the
  // second value prices what a task never got before its deadline
  // — but they can describe one hold twice: a temperature device with a smart
  // task on it can miss at 22:00 and still be budget-held at midnight, and
  // nothing in either producer excludes the other. Summing would then price one
  // unmet need twice, on a term that writes a real setting. Taking the larger
  // under-counts two genuinely separate denials instead, and an integrator
  // recovers from under-counting on the next day; over-correction it must decay
  // back out of.
  const deniedKwh = Math.max(deniedKwhOf(record), deadlineMissDeniedKwhOf(record));
  if (deniedKwh > 0) {
    // Integral-bearing damage: grow by the energy the budget denied to devices
    // or to a task whose deadline went by, plus however
    // far the day measurably ran past its budget. The
    // denied energy is the failure measure in its own right — a day the budget
    // held everything in check WHILE denying a device shows no overshoot at all,
    // precisely because the denial worked — so an unmeasurable or zero overshoot
    // does not hold or shrink the step; it is simply absent from it. (The
    // overshoot side stays meter-gated via `measuredBudgetOvershootKwh`; the
    // denied side comes from diagnostics and the smart-task history, not the
    // meter, so an unreliable-power day still grows by the denial it proved.)
    return {
      kwh: Math.min(carried + clamp(deniedKwh + Math.max(0, overshootKwh ?? 0), 0, MAX_STEP_KWH), ceilingKwh),
      throughDateKey: record.dateKey,
    };
  }
  // Legacy records (no integral): the rules they were written under, verbatim.
  // An unmeasurable overshoot holds (a badly-timed restart must not erode real
  // evidence); a day inside its budget decays; a day past it grows by the
  // overshoot.
  if (overshootKwh === undefined) return { kwh: carried, throughDateKey: record.dateKey };
  if (overshootKwh <= 0) return decay();
  return {
    kwh: Math.min(carried + clamp(overshootKwh, 0, MAX_STEP_KWH), ceilingKwh),
    throughDateKey: record.dateKey,
  };
}

/**
 * The term as the suggestion should apply it. Its physical ceiling belongs to
 * the final suggestion clamp; tying it to the model prediction prevented the
 * loop from correcting the very model errors it exists to learn around.
 */
export function resolveBudgetPressureKwh(params: {
  state: BudgetPressureState | undefined;
}): number {
  const { state } = params;
  const accumulated = state?.kwh ?? 0;
  if (!Number.isFinite(accumulated) || accumulated <= 0) return 0;
  return accumulated;
}
