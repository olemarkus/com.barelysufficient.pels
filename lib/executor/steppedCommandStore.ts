/**
 * Executor-owned stepped-command store.
 *
 * The commanded axis for a stepped load — what rung PELS asked for, whether the
 * ask is still in flight, and what the device last reported back — is executor
 * state, exactly as pending binary commands are observer state
 * (`lib/observer/pendingBinaryCommands.ts`, the model for this class). It used
 * to be held in `setup/appDeviceControlHelpers.ts`, which made the wiring layer
 * the owner of a domain concept and put the state above the layer boundaries
 * `arch:check` enforces: the executor wrote it, the plan-input producer read it
 * and advanced it, and neither module imported the other, so no rule could see
 * the coupling. `setup/AGENTS.md` § "No state" is the rule that closes that.
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
 * **Still to move (`TODO.md`, P1):** the confirm/expire/prune lifecycle is
 * currently driven by the plan-input producer, so a command settles when the
 * planner asks for its devices rather than when the executor observes
 * materialization. This class makes that visible — those methods have exactly
 * one caller each — but does not yet move it. The destination is a settle sweep
 * beside `syncPendingBinaryCommands`.
 */
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
import type { SteppedLoadReportedRuntimeState } from '../observer/steppedReportedStep';
import type { DeviceControlProfiles, SteppedLoadCommandStatus } from '../../packages/contracts/src/types';

export class SteppedCommandStore {
  private readonly state: DeviceControlRuntimeState = createDeviceControlRuntimeState();

  // --- Commanded axis: reads -------------------------------------------------

  /** The tracked desired-step command, or `undefined` when nothing is tracked. */
  getDesired(deviceId: string): SteppedLoadDesiredRuntimeState | undefined {
    return this.state.steppedLoadDesiredByDeviceId.get(deviceId);
  }

  /** The step the lowest-step initialization latched, if it is still latched. */
  getInitializedStepId(deviceId: string): string | undefined {
    return this.state.steppedLoadInitializedAtLowestStepByDeviceId.get(deviceId);
  }

  /** Whether a step command was actually issued during this on-session. */
  hasPriorStepCommand(deviceId: string): boolean {
    return this.state.steppedLoadStepCommandIssuedByDeviceId.has(deviceId);
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

  // --- Reported axis: reads --------------------------------------------------

  /** The raw last Flow-reported step, before decoration resolves it. */
  getReported(deviceId: string): SteppedLoadReportedRuntimeState | undefined {
    return this.state.steppedLoadReportedByDeviceId.get(deviceId);
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

  reportActualStep(params: {
    profiles: DeviceControlProfiles;
    deviceId: string;
    stepId: string;
    reportedAtMs?: number;
    planningPowerW?: number;
  }): ReportSteppedLoadActualStepResult {
    return reportSteppedLoadActualStep({ runtimeState: this.state, ...params });
  }

  /** Drop the raw Flow report — the device's native wiring is authoritative. */
  clearReported(deviceId: string): void {
    this.state.steppedLoadReportedByDeviceId.delete(deviceId);
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

  // --- Lifecycle (see the docblock: destination is the executor settle sweep) -

  confirmDesired(deviceId: string, desired: SteppedLoadDesiredRuntimeState): void {
    confirmSteppedLoadDesiredStep({ runtimeState: this.state, deviceId, desired });
  }

  expireConfirmedDesiredOnBinaryOff(deviceId: string, observedOn: boolean | undefined): void {
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

  /**
   * Test-only view of the backing bag, mirroring the accessor this state had
   * when the wiring layer held it. Production consumers go through the methods
   * above — there is deliberately no accessor that hands out the raw maps.
   */
  getStateForTests(): DeviceControlRuntimeState {
    return this.state;
  }
}

export const createSteppedCommandStore = (): SteppedCommandStore => new SteppedCommandStore();
