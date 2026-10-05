/**
 * What each home battery has shown PELS about following its setpoints, this
 * run: the verdict the planner input carries (`StorageVerdict`) and the
 * delivery ceiling a short plateau taught. Written by the executor's storage
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
 *   delivery above it by more than the setpoint tolerance. The plateau itself
 *   is remembered after it expires, so a re-probe that starts there and gets no
 *   further re-learns it instead of reading as not responding
 *   (`startsAtPlateau`).
 */
import type { BatteryDelivery } from '../ports/batteryControlOwner';
import type { StorageVerdict } from '../../packages/planner-types/src/planInputDevice';
import { getLogger } from '../logging/logger';
import { backoffDelayMs } from './retryBackoff';

const logger = getLogger('battery');

/** Wait before re-probing after the 1st, 2nd and every later unanswered setpoint. */
export const BATTERY_REPROBE_BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;

/** How long a learned delivery ceiling holds before the battery gets its full range again. */
export const DELIVERY_CEILING_TTL_MS = 30 * 60_000;

/** The last plateau an increase taught, and when; kept after it expires (`startsAtPlateau`). */
type LearnedPlateau = { kind: 'none' } | { kind: 'learned'; dischargeW: number; learnedAtMs: number };

type VerificationEntry = {
  verdict: Exclude<StorageVerdict, 'reprobing'>;
  /** Unanswered setpoints in a row; reset by any answered one. */
  failures: number;
  /** When a `not_responding` battery may be probed again. */
  nextProbeAtMs: number;
  plateau: LearnedPlateau;
};

const NO_PLATEAU: LearnedPlateau = { kind: 'none' };

/** A battery nothing has been judged for yet. */
const UNVERIFIED: VerificationEntry = { verdict: 'unverified', failures: 0, nextProbeAtMs: 0, plateau: NO_PLATEAU };

export type BatteryVerificationRead = {
  verdict: StorageVerdict;
  /**
   * The most discharge PELS may ask for, W: the battery's discharge range, or
   * the plateau an increase stopped at while that lesson holds.
   */
  deliveryCeilingW: number;
};

const isCeilingHeld = (
  plateau: LearnedPlateau,
  nowMs: number,
): plateau is Extract<LearnedPlateau, { kind: 'learned' }> => (
  plateau.kind === 'learned' && nowMs - plateau.learnedAtMs < DELIVERY_CEILING_TTL_MS
);

/**
 * The verdict as of now: a `not_responding` battery whose back-off has ended
 * is `reprobing` — it may be driven again, and earns no credit until it answers.
 */
const resolveVerdict = (entry: VerificationEntry, nowMs: number): StorageVerdict => (
  entry.verdict === 'not_responding' && nowMs >= entry.nextProbeAtMs ? 'reprobing' : entry.verdict
);

export class BatteryVerificationLedger {
  private readonly entries = new Map<string, VerificationEntry>();

  /** What the battery has shown, against the most its range lets it discharge, W. */
  read(deviceId: string, maxDischargeW: number, nowMs: number): BatteryVerificationRead {
    const entry = this.entryOf(deviceId);
    const { plateau } = entry;
    return {
      verdict: resolveVerdict(entry, nowMs),
      deliveryCeilingW: isCeilingHeld(plateau, nowMs) ? Math.min(maxDischargeW, plateau.dischargeW) : maxDischargeW,
    };
  }

  startsAtPlateau(deviceId: string, dischargeW: number, toleranceW: number): boolean {
    const { plateau } = this.entryOf(deviceId);
    return plateau.kind === 'learned' && Math.abs(dischargeW - plateau.dischargeW) <= toleranceW;
  }

  recordResponding(deviceId: string, delivery: BatteryDelivery, nowMs: number): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    const { plateau } = entry;
    const lifted = isCeilingHeld(plateau, nowMs) && delivery.dischargeW > plateau.dischargeW + delivery.toleranceW;
    this.transition(deviceId, entry, {
      verdict: 'responding', failures: 0, nextProbeAtMs: 0, plateau: lifted ? NO_PLATEAU : plateau,
    });
    if (lifted) {
      logger.info({
        event: 'battery_control_delivery_ceiling_lifted',
        deviceId,
        previousDischargeW: plateau.dischargeW,
        deliveredDischargeW: delivery.dischargeW,
      });
    }
  }

  recordDeliveryCeiling(deviceId: string, dischargeW: number, nowMs: number): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    const plateau = { kind: 'learned' as const, dischargeW: Math.max(0, dischargeW), learnedAtMs: nowMs };
    this.transition(deviceId, entry, { verdict: 'responding', failures: 0, nextProbeAtMs: 0, plateau });
    logger.info({ event: 'battery_control_delivery_ceiling_learned', deviceId, dischargeW: plateau.dischargeW });
  }

  recordNotResponding(deviceId: string, nowMs: number): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    const failures = entry.failures + 1;
    const nextProbeAtMs = nowMs + backoffDelayMs(BATTERY_REPROBE_BACKOFF_MS, failures);
    this.transition(deviceId, entry, { verdict: 'not_responding', failures, nextProbeAtMs, plateau: entry.plateau });
    logger.warn({ event: 'battery_control_not_responding', deviceId, failures, nextProbeAtMs });
  }

  recordSignInverted(deviceId: string): void {
    const entry = this.entryOf(deviceId);
    if (entry.verdict === 'sign_inverted') return;
    this.transition(deviceId, entry, { verdict: 'sign_inverted', failures: 0, nextProbeAtMs: 0, plateau: NO_PLATEAU });
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
