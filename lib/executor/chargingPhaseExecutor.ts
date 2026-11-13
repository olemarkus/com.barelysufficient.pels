import type { ChargingPhaseOwner } from '../ports/chargingPhases';
import type { ChargingPhaseDecision } from '../planContract/chargingPhaseDecision';
import { getLogger } from '../logging/logger';

const logger = getLogger('executor/chargingPhases');

/** A convergence lane for already-admitted decisions; it makes no phase choices. */
export class ChargingPhaseExecutor {
  constructor(private readonly owner: ChargingPhaseOwner) {}

  public blocksIncrease(deviceId: string): boolean { return this.owner.blocksIncrease(deviceId); }
  public handlesDevice(deviceId: string): boolean { return this.owner.read(deviceId).kind === 'supported'; }
  public cancelForSafety(deviceId: string): void { this.owner.cancelForSafety(deviceId); }

  public runDeviceCommand<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    return this.owner.runDeviceCommand(deviceId, operation);
  }

  public async apply(decisions: readonly ChargingPhaseDecision[], nowMs: number): Promise<{
    commandRequestCount: number; failureCount: number;
  }> {
    this.owner.reconcilePlan(decisions, nowMs);
    const results = await Promise.all(decisions.map(async (decision) => {
      try {
        return { requested: (await this.owner.apply(decision, nowMs)).requested, failed: false };
      } catch (error) {
        logger.error({ event: 'charging_phase_execution_failed', deviceId: decision.deviceId, err: error });
        return { requested: false, failed: true };
      }
    }));
    return {
      commandRequestCount: results.filter((result) => result.requested).length,
      failureCount: results.filter((result) => result.failed).length,
    };
  }
}
