/**
 * What each home battery has shown PELS about following its setpoints, this
 * run: the verdict the planner input carries (`StorageVerdict`) and the
 * discharge and charge ceilings a short plateau taught. Written by the executor's storage
 * lane (`lib/executor/batteryExecutor.ts`) through the owner's
 * `BatteryVerificationRecorder` port; read back by the owner's `readControl`.
 *
 * In memory on purpose. A restart re-verifies from the first setpoint, which
 * costs one confirmation window, and gives a battery PELS turned off for an
 * inverted sign a fresh look after the owner has had a chance to fix it. A
 * persisted verdict would outlive the firmware update that fixed the battery.
 *
 * - `not_responding` backs off 15, 30, then every 60 min; when the back-off
 *   ends the verdict reads `reprobing`, so the next deficit re-probes without
 *   credit until the battery answers.
 * - `sign_inverted` is final until restart.
 * - A learned ceiling expires after `DELIVERY_CEILING_TTL_MS` (a battery that
 *   plateaued near empty may be charged again by then) and is lifted only by a
 *   delivery above it by more than the setpoint tolerance. The discharge
 *   plateau itself is remembered after it expires, so a re-probe that starts
 *   there and gets no further re-learns it instead of reading as not responding
 *   (`startsAtPlateau`).
 * - A charge that stops short teaches the charge ceiling, whether it moved or
 *   not, and changes no verdict: a battery that is full stops charging, and
 *   that is its own limit, not a failure to follow. Whether it follows is
 *   judged on its discharge and by the sign check.
 * - The charge ceiling is learned per charge band (`chargeBandOf`). Many
 *   batteries accept less charge from about 80 % up, and every full battery
 *   accepts none, so a lesson taught near full caps only its own band and the
 *   bands above it. A lesson below 80 %, or without a reported level, caps
 *   every level, as before. A charge at a known level lifts every band it
 *   shows to be too low.
 * - A band lesson serves two readers on two clocks. Live control holds it for
 *   `DELIVERY_CEILING_TTL_MS`, then asks for full power again, which re-teaches
 *   or lifts it. The continuous plan, built hours ahead, keeps a band's lesson
 *   for `CHARGE_TAPER_PLANNING_RETENTION_MS` (`planningTaper`), until it is
 *   re-taught or lifted, but only once a second plateau confirms it: one taught
 *   again in its band, no higher than the lesson before it (by the setpoint's
 *   tolerance), within that retention. A plateau is judged on one fresh reading
 *   after the confirmation window, and a battery that ramps slower than that
 *   window would otherwise cap the plan's charge from that band up for a week;
 *   the plan asking for no more than the lesson meant nothing lifted it. A
 *   lesson awaiting its confirmation is lifted like a kept one. Both are in
 *   memory: a restart relearns.
 * - A lesson where the battery took no charge at all (within the setpoint's
 *   tolerance) is a stop, not a taper: the battery was full, or at its own
 *   charge limit. Live control holds it; the plan never keeps it, because
 *   under the plan live control asks for no more than the plan does, so
 *   nothing would ask for charge at that level again to lift it.
 */
import type { BatteryChargeCeiling, BatteryDelivery } from '../ports/batteryControlOwner';
import type { HomeBatteryLevelObservation, HomeBatterySetpointRange } from '../../packages/contracts/src/types';
import type { StorageVerdict } from '../../packages/planner-types/src/planInputDevice';
import { getLogger } from '../logging/logger';
import { backoffDelayMs } from './retryBackoff';

const logger = getLogger('battery');

/** Wait before re-probing after the 1st, 2nd and every later unanswered setpoint. */
export const BATTERY_REPROBE_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;

/** How long a learned delivery ceiling holds before the battery gets its full range again. */
export const DELIVERY_CEILING_TTL_MS = 30 * 60_000;

/**
 * How long the continuous plan keeps a band's latest charge lesson. A taper is
 * the battery's own charge curve, steady from one day to the next, but a battery
 * reaches 80 % only on some days (sunny ones, cheap nights), so a shorter
 * memory would forget it between charges. A week spans several such charges,
 * and a lesson taught in a cold spell, or by a battery whose curve has since
 * changed, still fades within one.
 */
export const CHARGE_TAPER_PLANNING_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * The last plateau an increase taught, and when, as a magnitude, W: discharge
 * for the delivery ceiling, charge for the charge ceiling. A discharge plateau
 * is kept after it expires (`startsAtPlateau`).
 */
type LearnedPlateau = { kind: 'none' } | { kind: 'learned'; powerW: number; learnedAtMs: number };

/**
 * A charge band's lesson: whether the battery took no charge at all then (a
 * stop, not a taper), and whether it repeated a plateau the band taught before
 * (`confirmed`), which the plan waits for.
 */
type ChargeLesson = Extract<LearnedPlateau, { kind: 'learned' }> & { stopped: boolean; confirmed: boolean };

/**
 * Where a charge lesson applies: `0` at every level, otherwise from that
 * charge level up. Taper typically starts between 80 and 90 %; 5 % bands are
 * half a kWh on a 10 kWh battery, fine enough to follow the taper and coarse
 * enough that a band is taught again before its lesson expires.
 */
type ChargeBand = 0 | 80 | 85 | 90 | 95;

/** The band a charge lesson taught at this level falls in. */
const chargeBandOf = (level: HomeBatteryLevelObservation | undefined): ChargeBand => {
  if (level === undefined || level.percent < 80) return 0;
  if (level.percent < 85) return 80;
  if (level.percent < 90) return 85;
  return level.percent < 95 ? 90 : 95;
};

/** Whether a band's lesson applies at this level: an unreported level only gets the every-level one. */
const bandApplies = (band: ChargeBand, level: HomeBatteryLevelObservation | undefined): boolean => (
  band === 0 || (level !== undefined && level.percent >= band)
);

type VerificationEntry = {
  verdict: Exclude<StorageVerdict, 'reprobing'>;
  /** Unanswered setpoints in a row; reset by any answered one. */
  failures: number;
  /** When a `not_responding` battery may be probed again. */
  nextProbeAtMs: number;
  plateau: LearnedPlateau;
  /** Charge lessons by band; an absent band has taught nothing. */
  chargePlateaus: ReadonlyMap<ChargeBand, ChargeLesson>;
};

const NO_PLATEAU: LearnedPlateau = { kind: 'none' };
const NO_CHARGE_PLATEAUS: ReadonlyMap<ChargeBand, ChargeLesson> = new Map();

/** A battery nothing has been judged for yet. */
const UNVERIFIED: VerificationEntry = {
  verdict: 'unverified', failures: 0, nextProbeAtMs: 0, plateau: NO_PLATEAU, chargePlateaus: NO_CHARGE_PLATEAUS,
};

export type BatteryVerificationRead = {
  verdict: StorageVerdict;
  /**
   * The most discharge PELS may ask for, W: the battery's discharge range, or
   * the plateau an increase stopped at while that lesson holds.
   */
  deliveryCeilingW: number;
  /** The most charge PELS may ask for, by charge level (`chargeCeilingAtLevelW`). */
  chargeCeiling: BatteryChargeCeiling;
};

const isCeilingHeld = (
  plateau: LearnedPlateau,
  nowMs: number,
): plateau is Extract<LearnedPlateau, { kind: 'learned' }> => (
  plateau.kind === 'learned' && nowMs - plateau.learnedAtMs < DELIVERY_CEILING_TTL_MS
);

/** The range's limit, W, or less while a plateau below it holds. */
const resolveCeilingW = (rangeW: number, plateau: LearnedPlateau, nowMs: number): number => (
  isCeilingHeld(plateau, nowMs) ? Math.min(rangeW, plateau.powerW) : rangeW
);

/** A taper lesson within the planning retention, confirmed or still awaiting its confirmation; never a stop. */
const isRetainedTaper = (lesson: ChargeLesson, nowMs: number): boolean => (
  !lesson.stopped && nowMs - lesson.learnedAtMs < CHARGE_TAPER_PLANNING_RETENTION_MS
);

/** Whether the plan keeps a band lesson: a retained taper a second plateau confirmed. */
const isPlanningRetained = (lesson: ChargeLesson, nowMs: number): boolean => (
  lesson.confirmed && isRetainedTaper(lesson, nowMs)
);

/** Whether a taper plateau repeats the band's retained one: no higher than it, by the tolerance. */
const confirmsLesson = (
  previous: ChargeLesson | undefined, powerW: number, toleranceW: number, nowMs: number,
): boolean => previous !== undefined && isRetainedTaper(previous, nowMs) && powerW <= previous.powerW + toleranceW;

/** The bands' lessons each predicate keeps, ascending, capped by the charge range. */
const taperSteps = (
  rangeW: number,
  lessons: ReadonlyMap<ChargeBand, ChargeLesson>,
  keeps: (lesson: ChargeLesson) => boolean,
): BatteryChargeCeiling['taper'] => [...lessons]
  .filter(([band, lesson]) => band !== 0 && keeps(lesson))
  .sort(([left], [right]) => left - right)
  .map(([band, lesson]) => ({ fromPercent: band, ceilingW: Math.min(rangeW, lesson.powerW) }));

/** The charge range, capped by each band's held lesson and, for the plan, its retained one. */
const resolveChargeCeiling = (
  rangeW: number,
  lessons: ReadonlyMap<ChargeBand, ChargeLesson>,
  nowMs: number,
): BatteryChargeCeiling => ({
  everyLevelW: resolveCeilingW(rangeW, lessons.get(0) ?? NO_PLATEAU, nowMs),
  taper: taperSteps(rangeW, lessons, (lesson) => isCeilingHeld(lesson, nowMs)),
  planningTaper: taperSteps(rangeW, lessons, (lesson) => isPlanningRetained(lesson, nowMs)),
});

/**
 * The most charge PELS may ask for at this charge level, W: the every-level
 * ceiling and each taper step at or below the level. An unreported level gets
 * the every-level ceiling: no band lesson can be placed against it.
 */
export const chargeCeilingAtLevelW = (
  ceiling: BatteryChargeCeiling,
  level: HomeBatteryLevelObservation | undefined,
): number => ceiling.taper
  .filter(step => level !== undefined && level.percent >= step.fromPercent)
  .reduce((ceilingW, step) => Math.min(ceilingW, step.ceilingW), ceiling.everyLevelW);

/** Whether a delivery past a held plateau by more than the tolerance lifts it. */
const isLifted = (plateau: LearnedPlateau, deliveredW: number, toleranceW: number, nowMs: number): boolean => (
  isCeilingHeld(plateau, nowMs) && deliveredW > plateau.powerW + toleranceW
);

const logCeilingLifted = (event: string, deviceId: string, plateau: LearnedPlateau, deliveredSignedW: number): void => {
  if (plateau.kind !== 'learned') return;
  logger.info({ event, deviceId, previousCeilingW: plateau.powerW, deliveredSignedW });
};

/**
 * The verdict as of now: a `not_responding` battery whose back-off has ended
 * is `reprobing` — it may be driven again, and earns no credit until it answers.
 */
const resolveVerdict = (entry: VerificationEntry, nowMs: number): StorageVerdict => (
  entry.verdict === 'not_responding' && nowMs >= entry.nextProbeAtMs ? 'reprobing' : entry.verdict
);

export class BatteryVerificationLedger {
  private readonly entries = new Map<string, VerificationEntry>();

  /** What the battery has shown, against the signed range it accepts. */
  read(deviceId: string, range: HomeBatterySetpointRange, nowMs: number): BatteryVerificationRead {
    const entry = this.entryOf(deviceId);
    return {
      verdict: resolveVerdict(entry, nowMs),
      deliveryCeilingW: resolveCeilingW(Math.max(0, -range.minW), entry.plateau, nowMs),
      chargeCeiling: resolveChargeCeiling(Math.max(0, range.maxW), entry.chargePlateaus, nowMs),
    };
  }

  startsAtPlateau(deviceId: string, dischargeW: number, toleranceW: number): boolean {
    const { plateau } = this.entryOf(deviceId);
    return plateau.kind === 'learned' && Math.abs(dischargeW - plateau.powerW) <= toleranceW;
  }

  recordResponding(deviceId: string, delivery: BatteryDelivery, nowMs: number): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    const { plateau, chargePlateaus } = entry;
    const { signedW, toleranceW, level } = delivery;
    const dischargeLifted = isLifted(plateau, -signedW, toleranceW, nowMs);
    // A band the plan keeps, or would keep once confirmed, is lifted too, held
    // or not: a charge past it shows the plan's taper is wrong as well as live
    // control's.
    const liftedBands = [...chargePlateaus].filter(([band, charge]) => bandApplies(band, level) && (
      band === 0 ? isLifted(charge, signedW, toleranceW, nowMs)
        : (isCeilingHeld(charge, nowMs) || isRetainedTaper(charge, nowMs)) && signedW > charge.powerW + toleranceW
    ));
    const remaining = new Map(chargePlateaus);
    for (const [band] of liftedBands) remaining.delete(band);
    this.transition(deviceId, entry, {
      verdict: 'responding',
      failures: 0,
      nextProbeAtMs: 0,
      plateau: dischargeLifted ? NO_PLATEAU : plateau,
      chargePlateaus: liftedBands.length === 0 ? chargePlateaus : remaining,
    });
    if (dischargeLifted) logCeilingLifted('battery_control_delivery_ceiling_lifted', deviceId, plateau, signedW);
    for (const [band, charge] of liftedBands) {
      logger.info({
        event: 'battery_control_charge_ceiling_lifted', deviceId, band,
        previousCeilingW: charge.powerW, deliveredSignedW: signedW,
      });
    }
  }

  recordDeliveryCeiling(deviceId: string, dischargeW: number, nowMs: number): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    const plateau = { kind: 'learned' as const, powerW: Math.max(0, dischargeW), learnedAtMs: nowMs };
    this.transition(deviceId, entry, { ...entry, verdict: 'responding', failures: 0, nextProbeAtMs: 0, plateau });
    logger.info({ event: 'battery_control_delivery_ceiling_learned', deviceId, dischargeW: plateau.powerW });
  }

  recordChargeCeiling(deviceId: string, delivery: BatteryDelivery, nowMs: number): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    const { level, toleranceW } = delivery;
    const band = chargeBandOf(level);
    const powerW = Math.max(0, delivery.signedW);
    const stopped = powerW <= toleranceW;
    const confirmed = !stopped && confirmsLesson(entry.chargePlateaus.get(band), powerW, toleranceW, nowMs);
    const lesson: ChargeLesson = { kind: 'learned', powerW, learnedAtMs: nowMs, stopped, confirmed };
    this.entries.set(deviceId, { ...entry, chargePlateaus: new Map(entry.chargePlateaus).set(band, lesson) });
    logger.info({
      event: 'battery_control_charge_ceiling_learned', deviceId, chargeW: powerW, band,
      levelPercent: level?.percent ?? null, stopped, confirmed,
    });
  }

  recordNotResponding(deviceId: string, nowMs: number): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    const failures = entry.failures + 1;
    const nextProbeAtMs = nowMs + backoffDelayMs(BATTERY_REPROBE_BACKOFF_MS, failures);
    this.transition(deviceId, entry, { ...entry, verdict: 'not_responding', failures, nextProbeAtMs });
    logger.warn({ event: 'battery_control_not_responding', deviceId, failures, nextProbeAtMs });
  }

  recordSignInverted(deviceId: string): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    this.transition(deviceId, entry, {
      verdict: 'sign_inverted', failures: 0, nextProbeAtMs: 0, plateau: NO_PLATEAU, chargePlateaus: NO_CHARGE_PLATEAUS,
    });
    logger.error({
      event: 'battery_control_sign_inverted',
      deviceId,
      msg: 'Battery power moved opposite to the whole-home meter; PELS stops controlling it until the app restarts',
    });
  }

  private entryOf(deviceId: string): VerificationEntry {
    return this.entries.get(deviceId) ?? UNVERIFIED;
  }

  private transition(deviceId: string, previous: VerificationEntry, next: VerificationEntry): void {
    this.entries.set(deviceId, next);
    if (previous.verdict === next.verdict) return;
    logger.info({
      event: 'battery_control_verdict_changed',
      deviceId,
      verdict: next.verdict,
      previousVerdict: previous.verdict,
    });
  }
}
