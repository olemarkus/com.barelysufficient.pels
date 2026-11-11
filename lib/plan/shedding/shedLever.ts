import type { DevicePlanDevice, PlanInputDevice } from '../planTypes';
import { isSteppedLoadDevice } from '../planSteppedLoad';
import { isTemperaturePlanDevice } from '../planTemperatureDevice';
import { temperatureSetpointsFor } from '../planTemperatureSetpoints';
import type { TemperatureSetpointsByDevice } from '../../../packages/planner-types/src/temperatureSetpoints';

/**
 * How limiting a device releases its draw, from this build's resolved shed
 * behaviour: its step ladder, its setpoint limit, or its on/off switch.
 *
 * The one answer to "how does this device shed", for every lane that limits a
 * device: shedding's candidate walk (`candidates.ts`) and a restore swap's donor
 * release (`swap/candidates.ts`). A swap that switched off a device the owner
 * set to shed by lowering its temperature would override that choice, and on
 * the next build the setpoint hold would write the limit to a device that is
 * already off.
 *
 * - `step`: a stepped device; its own ladder decides the rung.
 * - `setpoint`: a temperature device limited by setpoint, at `limitC`
 *   (capability-normalized, what PELS writes). `releasesDemand` is false when
 *   writing it would release nothing: the device is at its limit, or the limit
 *   sits on the demand side of its target.
 * - `binary`: everything else, switched off.
 */
export type ShedLever =
  | { kind: 'step' }
  | { kind: 'setpoint'; limitC: number; releasesDemand: boolean }
  | { kind: 'binary' };

export function resolveShedLever(
  device: PlanInputDevice | DevicePlanDevice,
  temperatureSetpoints: TemperatureSetpointsByDevice,
): ShedLever {
  if (isSteppedLoadDevice(device)) return { kind: 'step' };
  if (isTemperaturePlanDevice(device)) {
    const { shed } = temperatureSetpointsFor(temperatureSetpoints, device.id);
    if (shed.action === 'set_temperature') {
      return { kind: 'setpoint', limitC: shed.limitC, releasesDemand: shed.releasesDemand };
    }
  }
  return { kind: 'binary' };
}
