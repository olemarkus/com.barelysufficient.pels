import {
  EMPTY_CHARGING_PHASE_READ,
  type ChargingPhaseDecision, type ChargingPhaseExecutionGate, type ChargingPhaseOwner,
} from '../ports/chargingPhases';

/**
 * Meter areas share Main's device queue and hand-back fence, never its planning
 * lifecycle. Their empty phase plans must not withdraw Main's work. Main also
 * owns phase contests, so areas publish no desired phase setting of their own.
 */
export class ExecutionOnlyChargingPhases implements ChargingPhaseOwner {
  constructor(private readonly gate: ChargingPhaseExecutionGate) {}

  readPlanning(_nowMs: number) { return EMPTY_CHARGING_PHASE_READ; }
  readPermittedEnvelopes() { return EMPTY_CHARGING_PHASE_READ.permittedEnvelopes; }
  read(deviceId: string) { return this.gate.read(deviceId); }
  blocksIncrease(deviceId: string): boolean { return this.gate.blocksIncrease(deviceId); }
  cancelForSafety(deviceId: string): void { this.gate.cancelForSafety(deviceId); }
  reconcilePlan(_decisions: readonly ChargingPhaseDecision[], _nowMs: number): void {}
  getDesiredForceSingle(_deviceId: string): null { return null; }
  async apply(_decision: ChargingPhaseDecision, _nowMs: number) { return { requested: false }; }

  runDeviceCommand<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    return this.gate.runDeviceCommand(deviceId, operation);
  }
}
