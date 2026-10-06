/**
 * The storage lane: converges a newly built plan's home-battery decisions
 * (`StorageDecision`, decided by `lib/plan/battery/storageRelief.ts`) and
 * verifies the battery follows them. Main only: a meter area builds no lane
 * (`StorageLaneBinding`, `NO_STORAGE_LANE`).
 *
 * - **Claim.** `admitClaim` answers before every `storage_power`: the owner
 *   records the claim value the battery holds before the first one. The write
 *   goes through Main's fenced plan actuator, like every other plan write, and
 *   is dispatched after the plan's shed writes, so a slow cloud battery never
 *   delays a shed.
 * - **Drift.** A setpoint has work only until it is sent; a release only while
 *   the claim is held and no hand-back is running, backing off or stopped. A
 *   write the battery or Homey refused is judged like an unanswered setpoint,
 *   never resent every rebuild, unless the owner reads a rejected claim as the
 *   battery's app refusing control: then it only watches the battery, and the
 *   lane has no lever on it.
 * - **Release.** A release decision hands the battery back through its owner
 *   (`releaseClaim`), which restores the claim value it recorded. Capacity
 *   simulation dispatches nothing, and the planner decides nothing for a
 *   battery then; the owner hands a held one back itself.
 * - **Verification** (`syncStorageCommands`, once per plan reading, modelled on
 *   `targetPowerCommandLifecycle.ts`). A setpoint is judged only on the
 *   battery's own power reported after it went out; a battery that reports
 *   nothing new gets up to `VERIFICATION_MAX_WAIT_MS`. It is confirmed within
 *   the setpoint tolerance (`storageSetpointToleranceW`), charge and discharge
 *   alike. Past the window, an INCREASE in discharge that moved but stopped
 *   short teaches the delivery ceiling, as does one that starts at the last
 *   plateau and gets no further; an increase in charge that stops short, moved
 *   or not, teaches the charge ceiling (a full battery stops charging, which is
 *   its own limit and no verdict); a step toward 0 W that stops short teaches
 *   nothing. A discharge with no movement is `not_responding`, and the plan
 *   hands the battery back. A setpoint too small
 *   to tell from noise, or from a minimum the battery may have and does not
 *   declare, gives no verdict at all. A battery whose claim no longer reads
 *   Homey's after the window was taken by someone else: it is judged not
 *   responding rather than claimed back. A battery the owner handed back (opt
 *   out) is simply forgotten, never judged.
 * - **Sign.** After a followed step in which the battery's own power moved at
 *   least 1 kW, either way, the whole-home meter's move, less the move of the
 *   managed devices' own metered draw, is compared with the battery's. A
 *   reading within `SIGN_CHECK_ACTION_QUIET_MS` of PELS's own shed or restore is
 *   no evidence. Two readings in a row decide a step; three inverted steps, one
 *   of them toward charge (a step down in discharge, or a charge increase), mark
 *   the battery `sign_inverted`, and each is logged with its evidence. Peer apps
 *   drove batteries with a silently inverted sign for months.
 *
 * The verdicts are the battery owner's (`lib/battery/batteryVerification.ts`);
 * this lane writes them through the owner's port and reads them back through
 * `readControl`, so the planner input and this lane read one answer.
 */
import type { Actuator } from '../actuator/deviceActuator';
import { getLogger } from '../logging/logger';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../observer/controlCommandConfirmation';
import type { BatteryControlOwner, BatteryLeverRead, BatterySetpointOutcome } from '../ports/batteryControlOwner';
import type { HomeBatteryPowerObservation } from '../../packages/contracts/src/types';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import type { PowerTrackerState } from '../power/tracker';
import {
  storageSetpointToleranceW,
  type StorageDecidedDevice,
  type StorageDecision,
  type StorageReleaseIntent,
} from '../planContract/storageDecision';
import { normalizeError } from '../utils/errorUtils';

const logger = getLogger('executor/battery');

/** How long a setpoint waits for a battery reading newer than it before it is judged anyway. */
export const VERIFICATION_MAX_WAIT_MS = 5 * 60 * 1000;
/** Below this, a setpoint may sit under a minimum power the battery does not declare: no verdict. */
const NO_VERDICT_BELOW_W = 500;
/** A followed step that moved the battery at least this much, W, is big enough to check the sign against the meter. */
const SIGN_CHECK_MIN_STEP_W = 1000;
/** A meter move smaller than this share of the battery's says nothing about the sign. */
const SIGN_CHECK_MIN_METER_SHARE = 0.5;
/** Meter readings one setpoint may spend on the sign check before it is left to the next. */
const SIGN_CHECK_MAX_SAMPLES = 6;
/** A reading this close after PELS's own shed or restore says nothing about the battery. */
export const SIGN_CHECK_ACTION_QUIET_MS = 30 * 1000;
/** Inverted steps, one of them toward charge, before a battery is marked `sign_inverted`. */
const SIGN_INVERTED_STEPS_REQUIRED = 3;

/** A plan device carrying a home-battery decision. */

type SetpointLever = Extract<BatteryLeverRead, { kind: 'setpoint' }>;
type SetpointDecision = Extract<StorageDecision, { kind: 'setpoint' }>;

/** Did the meter move the way the battery says its own power moved? `none` when it moved too little to say. */
type SignSample = 'agrees' | 'inverted' | 'none';

/** The whole-home meter's latched reading, W, and when it landed. */
type MeterReading = { meterW: number; atMs: number };

/**
 * What a setpoint's sign is checked against: the whole-home meter and the
 * managed devices' metered draw when it went out, W, and the last meter
 * reading the check has looked at.
 */
type SignBaseline = { meterW: number; managedW: number; lastAtMs: number };

/**
 * Where a setpoint is in its verification: waiting for its verdict, a followed
 * step sampling its sign against the meter, or `done` (judged, and its sign
 * checked or not worth checking). A setpoint sent with no meter reading
 * latched has no baseline, and its sign goes unchecked.
 */
type CommandPhase =
  | { kind: 'pending'; baseline: SignBaseline | 'unavailable' }
  | { kind: 'sign_check'; baseline: SignBaseline; lastSample: SignSample; samples: number }
  | { kind: 'done' };

type SignCheckPhase = Extract<CommandPhase, { kind: 'sign_check' }>;

const DONE: CommandPhase = { kind: 'done' };

/** One setpoint the lane sent and what it has shown so far. */
type StorageCommandRecord = {
  setpointW: number;
  stepW: number;
  issuedAtMs: number;
  /** First unanswered send: replacement decisions cannot postpone failure forever. */
  unansweredSinceMs: number;
  /** The battery's own signed power when the setpoint went out, W. */
  startSignedW: number;
  phase: CommandPhase;
};

/**
 * What a setpoint showed: the battery `followed` it (reached it, or plateaued
 * on an increase), showed nothing either way (`inconclusive`), or did not
 * answer it (`unanswered`, judged not responding).
 */
type SetpointVerdict = 'followed' | 'inconclusive' | 'unanswered';

/** What this run's sign checks have shown about a battery: confirmed once, or inverted steps so far. */
type SignEvidence = { kind: 'confirmed' } | { kind: 'inverted'; invertedSteps: number; stepDownSeen: boolean };

const NO_INVERTED_STEPS = { kind: 'inverted', invertedSteps: 0, stepDownSeen: false } as const;

export type BatteryExecutorDeps = {
  owner: BatteryControlOwner;
  /** Main's fenced plan actuator. */
  actuator: Actuator;
  /** The battery's own signed power, from the observer's record. */
  readBatteryPower: (deviceId: string) => HomeBatteryPowerObservation | undefined;
  getPowerTracker: () => PowerTrackerState;
  /** The managed devices' own metered draw, W (no battery): the sign check discounts its move. */
  readManagedDrawW: () => number;
  /** Whether PELS shed or restored any device at or after this time. */
  hasShedOrRestoreSince: (sinceMs: number) => boolean;
  /**
   * A hand-back the restore lane decided (`restored`) went out: stamp the
   * restore clocks, as a confirmed load restore does. Only on a hand-back the
   * owner actually made: one it declined restored nothing.
   */
  recordRestore: (deviceId: string, name: string, nowMs: number) => void;
};

/** What the plan executor asks of a home's storage lane. */
export type StorageLane = Pick<BatteryExecutor, 'apply' | 'hasDrift' | 'sync' | 'releaseAbsent' | 'hasReleaseDrift'>;

/** A meter area's lane: it plans no battery, so its plans carry no storage decision to converge. */
export const NO_STORAGE_LANE: StorageLane = {
  apply: async () => false,
  hasDrift: () => false,
  sync: () => undefined,
  releaseAbsent: async () => false,
  hasReleaseDrift: () => false,
};

const isBlockedVerdict = (control: SetpointLever): boolean => (
  control.verdict === 'not_responding' || control.verdict === 'sign_inverted'
);

const hasSetpointProgress = (record: StorageCommandRecord, power: HomeBatteryPowerObservation): boolean => (
  power.observedAtMs > record.issuedAtMs
  && (power.signedW - record.startSignedW) * Math.sign(record.setpointW - record.startSignedW)
    >= storageSetpointToleranceW(record.setpointW, record.stepW)
);

const resolveSignSample = (batteryDeltaW: number, meterDeltaW: number): SignSample => {
  if (Math.abs(meterDeltaW) < Math.abs(batteryDeltaW) * SIGN_CHECK_MIN_METER_SHARE) return 'none';
  return Math.sign(meterDeltaW) === Math.sign(batteryDeltaW) ? 'agrees' : 'inverted';
};

export class BatteryExecutor {
  private readonly commands = new Map<string, StorageCommandRecord>();
  private readonly signEvidence = new Map<string, SignEvidence>();

  constructor(private readonly deps: BatteryExecutorDeps) {}

  /** Converge one decision. True when a write or hand-back was requested. */
  async apply(device: StorageDecidedDevice): Promise<boolean> {
    const decision = device.storageDecision;
    // A released battery has no setpoint left to judge.
    if (decision.kind === 'release') this.commands.delete(device.id);
    const control = this.resolveDrift(device);
    if (control === 'no_drift') return false;
    return decision.kind === 'release'
      ? this.release(device, decision)
      : this.sendSetpoint(device, decision, control);
  }

  hasReleaseDrift(intent: StorageReleaseIntent): boolean {
    const control = this.deps.owner.readControl(intent.deviceId);
    // An unobserved binding still needs to transfer recovery to the owner.
    return control.kind === 'none' || (control.claimHeld && !control.handBackDeferred);
  }

  async releaseAbsent(intent: StorageReleaseIntent): Promise<boolean> {
    this.commands.delete(intent.deviceId);
    return await this.deps.owner.releaseClaim(intent.deviceId, intent.reason) === 'released';
  }

  /** Whether this decision has a write or a hand-back due. */
  hasDrift(device: StorageDecidedDevice): boolean {
    return this.resolveDrift(device) !== 'no_drift';
  }

  /**
   * Judge every setpoint in flight against the battery's own power, then its
   * sign against the meter. Run once per plan reading, before the build, so
   * the build reads this reading's verdicts.
   */
  sync(nowMs: number): void {
    for (const [deviceId, recorded] of this.commands) {
      const control = this.deps.owner.readControl(deviceId);
      // Handed back (an opt-out, a hand-back of the owner's own): nothing to judge.
      if (control.kind === 'none' || !control.claimHeld) {
        this.commands.delete(deviceId);
        continue;
      }
      const power = this.deps.readBatteryPower(deviceId);
      if (power === undefined) continue;
      const record = recorded.phase.kind === 'pending' ? this.settle(deviceId, recorded, power, nowMs) : recorded;
      if (record === 'unanswered' || record.phase.kind === 'pending') continue;
      if (this.isClaimLost(deviceId, record, control, nowMs)) continue;
      if (record.phase.kind === 'sign_check') this.sampleSign(deviceId, record, record.phase, power);
    }
  }

  /**
   * The battery's lever when this decision has work: a setpoint only until it
   * is sent, and never to a battery judged not responding or sign-inverted; a
   * release only while the claim is held and no hand-back is running, backing
   * off or stopped.
   */
  private resolveDrift(device: StorageDecidedDevice): SetpointLever | 'no_drift' {
    const control = this.deps.owner.readControl(device.id);
    if (control.kind === 'none') return 'no_drift';
    const decision = device.storageDecision;
    const drifted = decision.kind === 'release'
      ? control.claimHeld && !control.handBackDeferred
      : !isBlockedVerdict(control) && this.commands.get(device.id)?.setpointW !== decision.setpointW;
    return drifted ? control : 'no_drift';
  }

  private async sendSetpoint(
    device: StorageDecidedDevice,
    decision: SetpointDecision,
    control: SetpointLever,
  ): Promise<boolean> {
    const power = this.deps.readBatteryPower(device.id);
    if (power === undefined) return false;
    try {
      const outcome = await this.deps.owner.dispatchSetpoint(device.id, async () => {
        const baseline = this.deps.readBatteryPower(device.id);
        if (baseline === undefined) return 'skipped';
        this.recordSent(device.id, decision, baseline, Date.now());
        const sent = await this.deps.actuator.apply({
          kind: 'storage_power', deviceId: device.id, setpointW: decision.setpointW,
        });
        if (!sent.requested && sent.reason === 'claim_rejected') {
          return { kind: sent.reason, errorMessage: sent.errorMessage };
        }
        if (!sent.requested || sent.kind !== 'storage_power') return 'skipped';
        const record = this.commands.get(device.id);
        if (record !== undefined) this.commands.set(device.id, { ...record, setpointW: sent.requestedSetpointW });
        return sent.requestedSetpointW;
      });
      if (outcome.status === 'refused') {
        logger.info({
          event: 'battery_storage_claim_refused', deviceId: device.id, deviceName: device.name, reason: outcome.reason,
        });
        return false;
      }
      if (outcome.status === 'claim_rejected') {
        this.recordClaimRejected(device, decision, outcome);
        return false;
      }
      if (outcome.setpointW === 'skipped') {
        this.commands.delete(device.id);
        return false;
      }
      logger.info({
        event: 'battery_storage_setpoint_sent', deviceId: device.id, deviceName: device.name,
        setpointW: outcome.setpointW, observedPowerW: power.signedW, verdict: control.verdict,
      });
      return true;
    } catch (error) {
      // Keep a rejected send's baseline: verification bounds retries rather
      // than issuing the same rejected write on every meter reading.
      logger.warn({
        event: 'battery_storage_setpoint_failed', deviceId: device.id, deviceName: device.name,
        setpointW: decision.setpointW, err: normalizeError(error),
      });
      return false;
    }
  }

  /**
   * The battery's app rejected the claim, so no setpoint went out. A battery
   * its owner now only watches has nothing left to judge (the owner logged
   * it). Any other keeps the baseline, as a rejected setpoint does, so
   * verification judges it unanswered and bounds the retries.
   */
  private recordClaimRejected(
    device: StorageDecidedDevice,
    decision: SetpointDecision,
    outcome: Extract<BatterySetpointOutcome, { status: 'claim_rejected' }>,
  ): void {
    if (outcome.effect === 'watch_only') {
      this.commands.delete(device.id);
      return;
    }
    logger.warn({
      event: 'battery_storage_setpoint_failed', deviceId: device.id, deviceName: device.name,
      setpointW: decision.setpointW, failedWrite: 'claim', err: normalizeError(outcome.errorMessage),
    });
  }

  /** The whole-home meter's latched reading, or `unavailable` when none is latched. */
  private readMeter(): MeterReading | 'unavailable' {
    const { lastPowerW, lastTimestamp } = this.deps.getPowerTracker();
    if (!isFiniteNumber(lastPowerW) || lastTimestamp === undefined) return 'unavailable';
    return { meterW: lastPowerW, atMs: lastTimestamp };
  }

  /**
   * Capture the battery, meter and managed draw before dispatch. Each replacement
   * gets its own settling window; the first unanswered send bounds the total wait.
   */
  private recordSent(
    deviceId: string,
    decision: SetpointDecision,
    power: HomeBatteryPowerObservation,
    nowMs: number,
  ): void {
    const meter = this.readMeter();
    const unanswered = this.commands.get(deviceId);
    this.commands.set(deviceId, {
      setpointW: decision.setpointW,
      stepW: decision.stepW,
      issuedAtMs: nowMs,
      unansweredSinceMs: unanswered?.phase.kind === 'pending' && !hasSetpointProgress(unanswered, power)
        ? unanswered.unansweredSinceMs : nowMs,
      startSignedW: power.signedW,
      phase: {
        kind: 'pending',
        baseline: meter === 'unavailable'
          ? meter
          : { meterW: meter.meterW, managedW: this.deps.readManagedDrawW(), lastAtMs: meter.atMs },
      },
    });
  }

  private async release(
    device: StorageDecidedDevice,
    decision: Extract<StorageDecision, { kind: 'release' }>,
  ): Promise<boolean> {
    if (await this.deps.owner.releaseClaim(device.id, decision.reason) !== 'released') return false;
    logger.info({
      event: 'battery_storage_released', deviceId: device.id, deviceName: device.name, reason: decision.reason,
    });
    if (decision.reason === 'restored') this.deps.recordRestore(device.id, device.name, Date.now());
    return true;
  }

  /**
   * Settle a pending setpoint once the battery reached it or its window is
   * over: the record as it stands now, or `unanswered` once it was judged so
   * and dropped.
   */
  private settle(
    deviceId: string,
    record: StorageCommandRecord,
    power: HomeBatteryPowerObservation,
    nowMs: number,
  ): StorageCommandRecord | 'unanswered' {
    const toleranceW = storageSetpointToleranceW(record.setpointW, record.stepW);
    const fresh = power.observedAtMs > record.issuedAtMs;
    const elapsedMs = nowMs - record.issuedAtMs;
    const reached = fresh && Math.abs(power.signedW - record.setpointW) <= toleranceW;
    const unansweredOver = nowMs - record.unansweredSinceMs >= VERIFICATION_MAX_WAIT_MS;
    const windowOver = (fresh && elapsedMs >= CONTROL_COMMAND_CONFIRMATION_MS)
      || (unansweredOver && !hasSetpointProgress(record, power));
    if (!reached && !windowOver) return record;
    const tooSmall = Math.abs(record.setpointW) < Math.max(toleranceW, NO_VERDICT_BELOW_W);
    const verdict = tooSmall ? 'inconclusive' : this.judge(deviceId, record, power, reached, nowMs);
    if (verdict === 'unanswered') {
      this.commands.delete(deviceId);
      return verdict;
    }
    const settled = {
      ...record,
      phase: verdict === 'followed' ? this.resolveSignPhase(deviceId, record, power) : DONE,
    };
    this.commands.set(deviceId, settled);
    return settled;
  }

  /** Record what the setpoint showed with the battery's owner. */
  private judge(
    deviceId: string,
    record: StorageCommandRecord,
    power: HomeBatteryPowerObservation,
    reached: boolean,
    nowMs: number,
  ): SetpointVerdict {
    const toleranceW = storageSetpointToleranceW(record.setpointW, record.stepW);
    const { verification } = this.deps.owner;
    const event = {
      deviceId, setpointW: record.setpointW, startPowerW: record.startSignedW, observedPowerW: power.signedW,
    };
    if (reached) {
      verification.recordResponding(deviceId, { signedW: power.signedW, toleranceW }, nowMs);
      logger.info({ event: 'battery_storage_setpoint_confirmed', ...event, elapsedMs: nowMs - record.issuedAtMs });
      return 'followed';
    }
    const towardDischarge = record.setpointW < record.startSignedW;
    // An increase moves the setpoint away from 0 W on its own side; a judged
    // setpoint is never 0 W (`NO_VERDICT_BELOW_W`), so it has a side.
    const increase = towardDischarge ? record.setpointW < 0 : record.setpointW > 0;
    const progressW = (power.signedW - record.startSignedW) * Math.sign(record.setpointW - record.startSignedW);
    const moved = progressW >= toleranceW;
    if (increase && !towardDischarge) {
      verification.recordChargeCeiling(deviceId, Math.max(0, power.signedW), nowMs);
      logger.info({ event: 'battery_storage_charge_plateaued', ...event, moved });
      if (!moved) return 'inconclusive';
      verification.recordResponding(deviceId, { signedW: power.signedW, toleranceW }, nowMs);
      return 'followed';
    }
    if (increase && (moved || verification.startsAtPlateau(deviceId, -record.startSignedW, toleranceW))) {
      verification.recordDeliveryCeiling(deviceId, Math.max(0, -power.signedW), nowMs);
      logger.info({ event: 'battery_storage_setpoint_plateaued', ...event });
      return 'followed';
    }
    if (!increase && moved) {
      // A step toward 0 W that stopped short teaches nothing about what it can deliver.
      logger.info({ event: 'battery_storage_step_down_short', ...event });
      return 'inconclusive';
    }
    verification.recordNotResponding(deviceId, nowMs);
    logger.warn({ event: 'battery_storage_setpoint_unanswered', ...event });
    return 'unanswered';
  }

  /**
   * A followed step's sign is checked when it went out against a meter
   * reading, the battery's own power moved enough to show on the meter, and no
   * step has confirmed this battery's sign yet this run. The move is what the
   * battery did, not what it was asked: a step that plateaued where it started
   * moved nothing for the meter to agree or disagree with.
   */
  private resolveSignPhase(
    deviceId: string,
    record: StorageCommandRecord,
    power: HomeBatteryPowerObservation,
  ): CommandPhase {
    if (record.phase.kind !== 'pending' || record.phase.baseline === 'unavailable') return DONE;
    if (Math.abs(power.signedW - record.startSignedW) < SIGN_CHECK_MIN_STEP_W) return DONE;
    if (this.signEvidence.get(deviceId)?.kind === 'confirmed') return DONE;
    return { kind: 'sign_check', baseline: record.phase.baseline, lastSample: 'none', samples: 0 };
  }

  /**
   * A held battery that no longer reports Homey's claim after the confirmation
   * window was taken by something else. It is judged not responding, so the
   * plan hands it back, and PELS does not fight the other controller by writing
   * the claim again.
   */
  private isClaimLost(
    deviceId: string,
    record: StorageCommandRecord,
    control: SetpointLever,
    nowMs: number,
  ): boolean {
    if (control.claimEngaged || nowMs - record.issuedAtMs < CONTROL_COMMAND_CONFIRMATION_MS) return false;
    this.commands.delete(deviceId);
    this.deps.owner.verification.recordNotResponding(deviceId, nowMs);
    logger.warn({ event: 'battery_storage_claim_lost', deviceId, setpointW: record.setpointW });
    return true;
  }

  /**
   * One sign sample per new whole-home reading. A reading near PELS's own shed
   * or restore is skipped; otherwise the meter's move less the managed devices'
   * metered move is laid against the battery's. Two readings in a row decide
   * this step.
   */
  private sampleSign(
    deviceId: string,
    record: StorageCommandRecord,
    phase: SignCheckPhase,
    power: HomeBatteryPowerObservation,
  ): void {
    const meter = this.readMeter();
    if (meter === 'unavailable' || meter.atMs <= phase.baseline.lastAtMs) return;
    const quiet = !this.deps.hasShedOrRestoreSince(record.issuedAtMs - SIGN_CHECK_ACTION_QUIET_MS);
    const batteryDeltaW = power.signedW - record.startSignedW;
    const managedDeltaW = this.deps.readManagedDrawW() - phase.baseline.managedW;
    const meterDeltaW = meter.meterW - phase.baseline.meterW - managedDeltaW;
    const sample = quiet ? resolveSignSample(batteryDeltaW, meterDeltaW) : 'none';
    const decided = sample !== 'none' && phase.lastSample === sample;
    const samples = phase.samples + 1;
    this.commands.set(deviceId, {
      ...record,
      phase: decided || samples >= SIGN_CHECK_MAX_SAMPLES ? DONE : {
        kind: 'sign_check',
        baseline: { ...phase.baseline, lastAtMs: meter.atMs },
        lastSample: sample === 'none' ? phase.lastSample : sample,
        samples,
      },
    });
    if (!decided) return;
    const evidence = { deviceId, setpointW: record.setpointW, batteryDeltaW, meterDeltaW, managedDeltaW };
    if (sample === 'agrees') {
      this.signEvidence.set(deviceId, { kind: 'confirmed' });
      logger.info({ event: 'battery_storage_sign_confirmed', ...evidence });
      return;
    }
    const previous = this.signEvidence.get(deviceId);
    const prior = previous?.kind === 'inverted' ? previous : NO_INVERTED_STEPS;
    const invertedSteps = prior.invertedSteps + 1;
    const stepDownSeen = prior.stepDownSeen || record.setpointW > record.startSignedW;
    this.signEvidence.set(deviceId, { kind: 'inverted', invertedSteps, stepDownSeen });
    logger.warn({ event: 'battery_storage_sign_step_inverted', ...evidence, invertedSteps, stepDownSeen });
    if (invertedSteps < SIGN_INVERTED_STEPS_REQUIRED || !stepDownSeen) return;
    this.commands.delete(deviceId);
    this.signEvidence.delete(deviceId);
    this.deps.owner.verification.recordSignInverted(deviceId);
  }
}
