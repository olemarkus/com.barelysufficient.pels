import type { PlannerExecutionFeedback, KeepInvariantShedBlock } from '../ports/plannerExecutionFeedback';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import type { PlanEngineState } from './planState';
import { closeActivationAttemptForShed, recordActivationAttemptStart } from './admission';

/** Applies execution facts to planner-owned admission, shed membership and shortfall state. */
export class PlanExecutionFeedback implements PlannerExecutionFeedback {
  constructor(private readonly state: PlanEngineState,
    private readonly diagnostics: DeviceDiagnosticsRecorder | undefined) {}

  isStandingShed(deviceId: string): boolean { return this.state.shedDecisions.standingShedIds.has(deviceId); }
  isExternalOffHeld(deviceId: string): boolean { return this.state.isExternalOffHeld(deviceId); }
  getRestoreCooldownMs(): number { return this.state.restoreBackoff.restoreCooldownMs; }
  getKeepInvariantShedBlock(deviceId: string): KeepInvariantShedBlock | undefined {
    return this.state.keepInvariantShedBlockedByDevice[deviceId];
  }
  setKeepInvariantShedBlock(deviceId: string, block: KeepInvariantShedBlock): void {
    this.state.setKeepInvariantShedBlock(deviceId, block);
  }
  clearKeepInvariantShedBlock(deviceId: string): void { this.state.clearKeepInvariantShedBlock(deviceId); }
  noteInstability(nowMs: number): void { this.state.restoreBackoff.noteInstability(nowMs); }
  noteShedReleased(deviceId: string): void { this.state.shedDecisions.noteShedReleased(deviceId); }
  recordActivationAttemptStarted(deviceId: string, name: string, nowMs: number): void {
    const transition = recordActivationAttemptStart(this.state, deviceId, nowMs);
    if (transition) this.diagnostics?.recordActivationTransition(transition, { name });
  }
  closeActivationAttemptForShed(deviceId: string, name: string, nowMs: number): void {
    const transition = closeActivationAttemptForShed(this.state, deviceId, nowMs);
    if (transition) this.diagnostics?.recordActivationTransition(transition, { name });
  }
  isInShortfall(): boolean { return this.state.inShortfall; }
  commitShortfall(value: boolean): void { this.state.inShortfall = value; }
}
