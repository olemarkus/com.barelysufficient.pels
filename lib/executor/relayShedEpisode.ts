import type { DeviceExecutionState } from '../planContract/deviceExecutionState';
import type { NativeRelayBinding, RelayMeterObservation } from '../ports/nativeRelay';
import type { LatchedMeterReading } from '../power/lastTotalPower';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../ports/controlCommandConfirmation';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/relay-shed');
const MIN_DRAW_W = 250;
type Watts = NonNullable<RelayMeterObservation['watts']>;
type Energy = NonNullable<RelayMeterObservation['energy']>;
type PowerEvidence = NonNullable<DeviceExecutionState['relayShedPowerEvidence']>;
export type RelayShedStatus = { startedAtMs: number; powerEvidence: PowerEvidence; repeatIssued: boolean };
export type RelayShedOutcome = 'accepted' | 'no_ack' | 'unknown' | 'failed';
type HouseholdEvidence = {
  household: () => LatchedMeterReading | undefined;
  overlappingSheds: (id: string, sinceMs: number) => boolean;
};

function hasSubstantialResidual(beforeW: number | undefined, afterW: number): boolean {
  return beforeW !== undefined && beforeW >= MIN_DRAW_W && afterW >= MIN_DRAW_W && afterW * 10 > beforeW * 7;
}

function classify(sample: Watts, baseline: Watts | undefined, settledAt: number): PowerEvidence {
  if (!baseline || baseline.value < MIN_DRAW_W || sample.atMs < settledAt || sample.receivedAtMs < settledAt) {
    return 'post_command';
  }
  if (!hasSubstantialResidual(baseline.value, sample.value)) return 'relieved';
  return sample.sourceDated ? 'off_with_draw' : 'post_command';
}

/** A continuous hold retains its baseline and repeat allowance across ordinary ON retries. */
export class RelayShedEpisode {
  public ack: 'dispatching' | Exclude<RelayShedOutcome, 'failed'> = 'dispatching';
  public noAck?: { decisionAtMs?: number; retryAtMs: number };
  public repeatIssued = false;
  public invalidated = false;
  public readonly startedAtMs = Date.now();
  private readonly baseline?: Watts;
  private readonly houseBefore?: LatchedMeterReading;
  private latestDispatchMs = this.startedAtMs;
  private settleFromMs = this.startedAtMs;
  private lastSampleMs = this.startedAtMs;
  private observedOffAtMs?: number;
  private priorOpposingOnAtMs?: number;
  private energy?: Energy;
  private energyAdvanced = false;
  private consecutiveHigh = 0;
  private powerEvidence: PowerEvidence;
  private identifiedByNoAck = false;
  readonly binding: string;
  private readonly flagged: boolean;

  constructor(readonly id: string, binding: NativeRelayBinding, observed: RelayMeterObservation | undefined,
    private readonly deps: HouseholdEvidence) {
    this.binding = binding.binding;
    this.flagged = binding.zwave;
    const sample = observed?.watts;
    const dated = observed?.datedWatts;
    if (sample?.sourceDated) this.baseline = sample;
    else if (dated && dated.value === sample?.value) this.baseline = dated;
    this.priorOpposingOnAtMs = observed?.lastOpposingOnAtMs;
    this.powerEvidence = this.baseline ? 'pre_command' : 'awaiting_power';
    this.houseBefore = deps.household();
  }

  private householdChange(): number | undefined {
    const after = this.deps.household();
    const before = this.houseBefore;
    return after && before && after.atMs > before.atMs ? after.powerW - before.powerW : undefined;
  }

  closed(reason: string): void {
    if (this.ack === 'dispatching') return;
    logger.info({ event: 'relay_shed_episode_ended', deviceId: this.id, reason, outcome: this.ack,
      startedAtMs: this.startedAtMs, beforeW: this.baseline?.value, powerEvidence: this.powerEvidence,
      repeatIssued: this.repeatIssued, householdChangeW: this.householdChange(),
      overlappingSheds: this.deps.overlappingSheds(this.id, this.startedAtMs) });
  }

  status(observed: RelayMeterObservation | undefined): RelayShedStatus | undefined {
    if (this.invalidated || this.ack === 'dispatching' || observed?.on !== false) return undefined;
    return { startedAtMs: this.startedAtMs, repeatIssued: this.repeatIssued,
      powerEvidence: observed.watts ? this.powerEvidence : 'awaiting_power' };
  }

  observe(observed: RelayMeterObservation | undefined): void {
    if (!observed || this.invalidated) return;
    const opposing = observed.lastOpposingOnAtMs;
    if (opposing !== undefined && opposing >= this.settleFromMs && opposing !== this.priorOpposingOnAtMs) {
      this.invalidated = true;
      this.consecutiveHigh = 0;
      return;
    }
    if (observed.on || observed.binaryAtMs < this.settleFromMs) return;
    this.observedOffAtMs ??= observed.binaryAtMs;
    if (this.ack === 'dispatching') return;
    const settleAt = Math.max(this.observedOffAtMs, this.settleFromMs + CONTROL_COMMAND_CONFIRMATION_MS);
    if (observed.energy) this.observeEnergy(observed.energy, settleAt);
    if (observed.watts) this.acceptSample(observed.watts, settleAt);
  }

  private observeEnergy(reading: Energy, settleAt: number): void {
    if (reading.atMs < settleAt || reading.receivedAtMs < settleAt) return;
    const previous = this.energy;
    if (previous && reading.atMs <= previous.atMs) return;
    if (previous && reading.kwh < previous.kwh) this.energyAdvanced = false;
    this.energy = reading;
    if (previous && reading.kwh > previous.kwh && !this.energyAdvanced) {
      this.energyAdvanced = true;
      logger.info({ event: 'relay_shed_energy_advanced', deviceId: this.id, fromKwh: previous.kwh,
        toKwh: reading.kwh, fromMs: previous.atMs, toMs: reading.atMs });
    }
  }

  private acceptSample(sample: Watts, settleAt: number): void {
    if (sample.atMs <= this.lastSampleMs) return;
    const evidence = classify(sample, this.baseline, settleAt);
    // An undated high cannot count toward the run or displace an independently dated high.
    if (!sample.sourceDated && hasSubstantialResidual(this.baseline?.value, sample.value)) {
      if (this.consecutiveHigh > 0) return;
    } else {
      this.lastSampleMs = sample.atMs;
    }
    const consecutive = evidence === 'off_with_draw' ? Math.min(2, this.consecutiveHigh + 1) : 0;
    if (evidence === this.powerEvidence && consecutive === this.consecutiveHigh) return;
    this.consecutiveHigh = consecutive;
    this.powerEvidence = evidence;
    logger.info({ event: 'relay_shed_evidence', deviceId: this.id, powerEvidence: evidence, consecutive,
      startedAtMs: this.startedAtMs, beforeW: this.baseline?.value, afterW: sample.value,
      householdChangeW: this.householdChange(), overlappingSheds: this.deps.overlappingSheds(this.id, this.startedAtMs),
      measuredAtMs: sample.atMs, receivedAtMs: sample.receivedAtMs, sourceDated: sample.sourceDated,
      repeatIssued: this.repeatIssued });
  }

  repeatReady(observed: RelayMeterObservation | undefined, meterAtMs: number): boolean {
    if (this.invalidated || this.repeatIssued || this.consecutiveHigh < 2) return false;
    if (!observed?.watts || observed.on) return false;
    return (this.ack === 'accepted' || this.ack === 'no_ack') && meterAtMs >= this.lastSampleMs
      && hasSubstantialResidual(this.baseline?.value, observed.watts.value);
  }

  dispatched(repeat: boolean, observed: RelayMeterObservation | undefined): void {
    this.latestDispatchMs = Date.now();
    if (this.noAck) this.noAck = { ...this.noAck, retryAtMs: this.latestDispatchMs + CONTROL_COMMAND_CONFIRMATION_MS };
    if (repeat) {
      this.repeatIssued = true;
      return;
    }
    this.settleFromMs = this.latestDispatchMs;
    this.lastSampleMs = this.latestDispatchMs;
    this.observedOffAtMs = undefined;
    this.priorOpposingOnAtMs = observed?.lastOpposingOnAtMs;
    this.invalidated = false;
    this.consecutiveHigh = 0;
    this.energy = undefined;
    this.energyAdvanced = false;
    this.powerEvidence = this.baseline ? 'pre_command' : 'awaiting_power';
    this.ack = 'dispatching';
  }

  private matchesWrite(outcome: RelayShedOutcome, binding: string | undefined, unflaggedRelay: boolean): boolean {
    if (outcome === 'unknown') return this.flagged || this.identifiedByNoAck;
    // Any accepted OFF must prove the native binding actually used. A generic
    // success could have come from a Flow or from a changed write surface.
    return binding === this.binding && (!unflaggedRelay || this.identifiedByNoAck);
  }

  /** Return whether this episode still carries useful identity, pacing or a spent allowance. */
  finish(outcome: RelayShedOutcome, binding?: string, decisionAtMs?: number, unflaggedRelay = false): boolean {
    if (outcome === 'failed' || !this.matchesWrite(outcome, binding, unflaggedRelay)) {
      if (this.ack === 'dispatching') this.invalidated = true;
      return this.repeatIssued || this.noAck !== undefined || this.ack !== 'dispatching';
    }
    if (outcome === 'no_ack') this.identifiedByNoAck = true;
    this.ack = outcome;
    this.noAck = outcome === 'no_ack'
      ? { decisionAtMs, retryAtMs: this.latestDispatchMs + CONTROL_COMMAND_CONFIRMATION_MS } : undefined;
    logger.info({ event: 'relay_shed_dispatch', deviceId: this.id, outcome, beforeW: this.baseline?.value,
      baselineAtMs: this.baseline?.atMs, startedAtMs: this.startedAtMs, repeatIssued: this.repeatIssued,
      dispatchedAtMs: this.latestDispatchMs });
    return true;
  }
}
