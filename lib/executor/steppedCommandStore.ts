/**
 * Executor-owned stepped-command store.
 *
 * The commanded axis for a stepped load — what rung PELS asked for, whether the
 * ask is still in flight, and what the device last reported back — is executor
 * state. Device-owner configuration and Observer evidence drive the executor's
 * settle sweep; the plan-input producer only reads the command state.
 *
 * The store is the canonical owner in BOTH directions. Writes go through the
 * lifecycle methods; reads go through the accessors, which hand out the record
 * rather than the maps, so no consumer can mutate the backing state in place.
 * The bag itself (`DeviceControlRuntimeState`) and the transitions over it stay
 * in `steppedCommandState.ts` — this class owns the instance and is the only
 * path to it.
 *
 * **Two axes, deliberately kept apart.** `desired` is what PELS commanded;
 * `reported` is what the device attested through a Flow. They answer different
 * questions and neither is derived from the other — see the module docblock in
 * `steppedCommandState.ts`.
 *
 */

import type { FlowSteppedLoadObservation } from '../ports/flowSteppedLoadAdmission';
import type { DeviceConfigurationRead } from '../ports/deviceConfigurationRead';
import {
  getSteppedLoadLowestActiveStep, getSteppedLoadStep,
} from '../../packages/shared-domain/src/deviceControlProfiles';
import {
  confirmSteppedLoadDesiredStep,
  createDeviceControlRuntimeState,
  expireConfirmedDesiredStepOnBinaryOff,
  markSteppedLoadDesiredStepIssued,
  preserveSteppedLoadDesiredStep,
  pruneStaleSteppedLoadCommandStates,
  reportSteppedLoadActualStep,
  type DeviceControlRuntimeState,
  type MarkSteppedLoadDesiredStepIssuedParams,
  type ReportSteppedLoadActualStepResult,
  type SteppedLoadDesiredRuntimeState,
} from './steppedCommandState';
import type { SteppedReportedStepStore } from '../observer/steppedReportedStep';
import type { SteppedLoadCommandStatus } from '../../packages/contracts/src/types';

export class SteppedCommandStore {
  private readonly state: DeviceControlRuntimeState = createDeviceControlRuntimeState();

  /**
   * The observer's record of what the device attested. Injected, not owned:
   * reconciling a command against a report is this layer's job, but the report
   * itself belongs to `lib/observer/steppedReportedStep.ts`.
   */
  constructor(private readonly reportedStore: SteppedReportedStepStore) {}

  // --- Commanded axis: reads -------------------------------------------------

  /** The tracked desired-step command, or `undefined` when nothing is tracked. */
  getDesired(deviceId: string): SteppedLoadDesiredRuntimeState | undefined {
    return this.state.steppedLoadDesiredByDeviceId.get(deviceId);
  }

  /**
   * The lowest-step initialization latch, reconciled against the ladder now in
   * force and returned only if it still names that ladder's lowest active rung.
   * A latch that does not is stale — the profile changed under it — so the whole
   * command session goes with it.
   *
   * The verdict lives here because it is one question with one answer. Both
   * callers used to read the raw latch and re-derive "is it still valid" from
   * the ladder themselves: the same comparison written twice, one edit away
   * from two answers.
   */
  peekInitializationLatch(
    deviceId: string,
    lowestActiveStepId: string | undefined,
  ): string | undefined {
    const latched = this.state.steppedLoadInitializedAtLowestStepByDeviceId.get(deviceId);
    return latched === lowestActiveStepId ? latched : undefined;
  }

  /**
   * The write half of the same question, for the settle sweep: a latch that no
   * longer names the ladder's lowest active rung is stale — the profile changed
   * under it — so the whole command session goes with it. Split from the read so
   * that ASKING what the latch is cannot change it; the read runs on every plan
   * input build, and a read that mutates is why this lifecycle had to move.
   */
  reconcileInitializationLatch(deviceId: string, lowestActiveStepId: string | undefined): void {
    const latched = this.state.steppedLoadInitializedAtLowestStepByDeviceId.get(deviceId);
    if (latched === undefined || latched === lowestActiveStepId) return;
    this.clearCommandSession(deviceId);
  }

  /** Retire command state that refers to a control axis or rung removed by its owner. */
  reconcileConfiguration(configuration: DeviceConfigurationRead): void {
    if (!('steppedLoadProfile' in configuration)) {
      this.clearCommandSession(configuration.id);
      return;
    }
    const profile = configuration.steppedLoadProfile;
    const desired = this.getDesired(configuration.id);
    // An EV target-power command carries its planning watts and may name the rung
    // above the confirmed ladder. `TargetPowerCommandLifecycle` retires it against
    // the planner's ladder instead, so an unacknowledged probe keeps its pacing.
    if (desired && desired.planningPowerW === undefined
      && (!getSteppedLoadStep(profile, desired.stepId)
        || (desired.previousStepId !== undefined && !getSteppedLoadStep(profile, desired.previousStepId)))) {
      this.clearCommandSession(configuration.id);
    }
    this.reconcileInitializationLatch(configuration.id, getSteppedLoadLowestActiveStep(profile)?.id);
  }

  /** Whether a step command was actually issued during this on-session. */
  hasPriorStepCommand(deviceId: string): boolean {
    return this.state.steppedLoadStepCommandIssuedByDeviceId.has(deviceId);
  }

  /** Whether anything at all is tracked — the settle pass's cheap early out. */
  hasTrackedState(): boolean {
    return this.state.steppedLoadDesiredByDeviceId.size > 0
      || this.state.steppedLoadInitializedAtLowestStepByDeviceId.size > 0
      || this.state.steppedLoadStepCommandIssuedByDeviceId.size > 0
      || this.state.steppedLoadLastBinaryOnByDeviceId.size > 0;
  }

  /** Whether a step command is issued and not yet settled. */
  isStepCommandPending(deviceId: string): boolean {
    return this.state.steppedLoadDesiredByDeviceId.get(deviceId)?.pending === true;
  }

  /**
   * Whether any device is mid-probe: an in-flight command that admitted a rung
   * above the confirmed EV ceiling. The probe scheduler asks this to decide
   * whether a settlement pass is still owed.
   */
  hasPendingTargetPowerProbe(): boolean {
    for (const desired of this.state.steppedLoadDesiredByDeviceId.values()) {
      if (
        desired.pending
        && desired.targetPowerProbeConfirmedMaxPowerW !== undefined
        && desired.targetPowerProbeStartedAtMs !== undefined
      ) {
        return true;
      }
    }
    return false;
  }

  // --- Writes ----------------------------------------------------------------

  markDesiredStepIssued(params: Omit<MarkSteppedLoadDesiredStepIssuedParams, 'unacknowledged'>): void {
    markSteppedLoadDesiredStepIssued({ runtimeState: this.state, ...params });
  }

  preserveDesiredStep(params: {
    deviceId: string;
    desiredStepId: string;
    previousStepId?: string;
    changedAtMs?: number;
    status?: SteppedLoadCommandStatus;
  }): void {
    preserveSteppedLoadDesiredStep({ runtimeState: this.state, ...params });
  }

  reportActualStep(observation: FlowSteppedLoadObservation): ReportSteppedLoadActualStepResult {
    return reportSteppedLoadActualStep(this.state, this.reportedStore, observation);
  }

  /**
   * Forget the whole command session for a device whose ladder changed under
   * it: the latched initialization step no longer names a rung on the current
   * profile, so the desired command and the issued-command latch describe a
   * ladder that is gone.
   */
  clearCommandSession(deviceId: string): void {
    this.state.steppedLoadInitializedAtLowestStepByDeviceId.delete(deviceId);
    this.state.steppedLoadDesiredByDeviceId.delete(deviceId);
    this.state.steppedLoadStepCommandIssuedByDeviceId.delete(deviceId);
  }

  // --- Lifecycle ------------------------------------------------------------

  confirmDesired(deviceId: string, desired: SteppedLoadDesiredRuntimeState): void {
    confirmSteppedLoadDesiredStep({ runtimeState: this.state, deviceId, desired });
  }

  expireConfirmedDesiredOnBinaryOff(deviceId: string, observedOn: boolean): void {
    expireConfirmedDesiredStepOnBinaryOff({ runtimeState: this.state, deviceId, observedOn });
  }

  pruneStale(nowMs: number = Date.now()): boolean {
    return pruneStaleSteppedLoadCommandStates(this.state, nowMs);
  }

  /**
   * Forget the tracked command outright. The reachability probe does this when
   * a step settles BELOW what was asked for: the command is answered, and the
   * answer is "not at that rung", so nothing is in flight any more.
   */
  deleteDesired(deviceId: string): void {
    this.state.steppedLoadDesiredByDeviceId.delete(deviceId);
  }
}

export const createSteppedCommandStore = (
  reportedStore: SteppedReportedStepStore,
): SteppedCommandStore => new SteppedCommandStore(reportedStore);
