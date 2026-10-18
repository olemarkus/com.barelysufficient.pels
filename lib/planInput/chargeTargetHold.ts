import type { EvChargeTargetConfig } from '../../packages/contracts/src/types';
import type {
  ChargeTargetHold,
  DeviceControlPosture,
} from '../../packages/planner-types/src/planInputDevice';
import { isEvObserved } from '../../packages/shared-domain/src/evObservedState';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import type { ToPlanDeviceInput } from './planInputDeviceTypes';

const NO_HOLD: ChargeTargetHold = { kind: 'none' };
const FULL_PERCENT = 100;

/**
 * Resolve a charger's target battery level into the hold it asks of the planner
 * (`PlanInputDeviceBase.chargeTargetHold`). The one place the setting, the
 * observed level and the plug state meet; the planner reads only the answer.
 *
 * - No target, or not a charger: no hold.
 * - A device PELS only watches: no hold. The hold is a command, so it needs
 *   `managed && commandAuthority`. Read off the STANDING posture resolved here,
 *   before deferred admission: a smart task that lends authority later in the
 *   cycle is either driving the device (and would lift the hold anyway) or
 *   holding it for its own reasons, and in neither case does the target gain a
 *   lever the owner did not give it.
 * - No car on the cable (`plugged_out`, or a level the session boundary marks
 *   `not_connected`): no hold. Nothing would charge, and "waiting for battery
 *   level" would be a wait with nothing to wait for.
 * - A known level at or above the target: held, naming the target. Except a
 *   100% target, which is the car's own limit: a full car that still draws
 *   (heating or cooling the cabin, balancing cells) keeps the charger on, as it
 *   did before the charger had a target.
 * - A car with no level for this session yet (`not_reported`, or a charger that
 *   has never reported one): held only when the owner chose not to charge before
 *   the level is known. The default charges to the car's own limit, as a charger
 *   with no target does.
 */
export const projectChargeTargetHold = (
  config: EvChargeTargetConfig | undefined,
  device: ToPlanDeviceInput,
  control: DeviceControlPosture,
): ChargeTargetHold => {
  if (config === undefined || !isEvObserved(device)) return NO_HOLD;
  if (!control.managed || !control.commandAuthority) return NO_HOLD;
  if (!isEvPlugStateConnected(device.evChargingState)) return NO_HOLD;
  const level = hasObservedStateOfCharge(device) ? device.stateOfCharge.level : undefined;
  if (level?.kind === 'known') {
    return level.percent >= config.targetPercent && config.targetPercent < FULL_PERCENT
      ? { kind: 'target_reached', targetPercent: config.targetPercent }
      : NO_HOLD;
  }
  if (level?.reasonCode === 'not_connected') return NO_HOLD;
  return config.chargeBeforeLevelKnown ? NO_HOLD : { kind: 'awaiting_level' };
};
