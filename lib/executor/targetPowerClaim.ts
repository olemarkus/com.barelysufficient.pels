import type { PlannedTargetPowerClaim } from '../planContract/executionPlan';
import { getDebugEmitter, getLogger } from '../logging/logger';
import type { ExecutorCommandContext } from './executorCommandContext';

const logger = getLogger('executor/target-power-claim');
const emitExecutorDebug = getDebugEmitter('executor', 'plan');

/**
 * Carry out the plan's claim of a device's watt target for Homey: the mode
 * alone. It runs before the device's other commands and never stops them: a
 * device PELS could not claim is still paused or stepped as the plan decided.
 *
 * The claim keeps no pending or retry state here. The device's owner reads the
 * outcome from the device itself (`lib/device/targetPowerControlClaims.ts`): a
 * claim that lands stops being planned, and one the device's app refuses, or
 * puts back, is withheld there until its retry is due. That owner is also what
 * keeps a device that will not keep the mode from being written every cycle.
 */
export const applyTargetPowerClaim = async (
  ctx: ExecutorCommandContext,
  claim: PlannedTargetPowerClaim,
): Promise<boolean> => {
  const fields = { deviceId: claim.deviceId, deviceName: claim.name };
  if (ctx.getCapacityDryRun()) {
    emitExecutorDebug({ event: 'target_power_claim_skipped', reasonCode: 'dry_run', ...fields });
    return false;
  }
  try {
    const outcome = await ctx.actuator.apply({ kind: 'target_power_claim', deviceId: claim.deviceId });
    if (outcome.requested) {
      logger.info({ event: 'target_power_claimed', ...fields });
      return true;
    }
    if ('reason' in outcome && outcome.reason === 'target_power_claim_refused') {
      logger.warn({ event: 'target_power_claim_refused', ...fields, errorMessage: outcome.errorMessage });
    } else {
      emitExecutorDebug({ event: 'target_power_claim_skipped', reasonCode: 'not_sent', ...fields });
    }
    return false;
  } catch (error) {
    logger.error({ event: 'target_power_claim_failed', ...fields, err: error });
    return false;
  }
};
