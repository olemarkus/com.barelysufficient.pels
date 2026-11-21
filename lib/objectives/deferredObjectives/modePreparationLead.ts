import { MAX_MODE_PREPARATION_LEAD_MS } from '../../ports/modePreparation';
import type { PowerTrackerState } from '../../power/tracker';
import type { ObjectiveDeviceSource } from '../types';
import { resolveObjectiveDeviceInputs } from '../types';
import { resolvePlanningSpeedKw } from './planningSpeed';
import { resolveProfileEnergy } from './profileEnergyResolution';

const HOUR_MS = 3_600_000;

/** The heating profile and delivery speed shared with Smart tasks. */
export function resolveModePreparationLeadMs(
  tracker: PowerTrackerState,
  device: ObjectiveDeviceSource,
  fromC: number,
  targetC: number,
): number {
  const [objectiveDevice] = resolveObjectiveDeviceInputs([device], () => 'heating');
  const speedKw = resolvePlanningSpeedKw(objectiveDevice);
  if (speedKw === null) return 2 * HOUR_MS;
  const { energyNeededKWh } = resolveProfileEnergy(
    tracker, { deviceId: device.id, carId: null }, 'temperature', 'soft',
    targetC - fromC, 'increasing', fromC,
  );
  if (energyNeededKWh === null) return 2 * HOUR_MS;
  return Math.min(MAX_MODE_PREPARATION_LEAD_MS, (energyNeededKWh / speedKw + 0.5) * HOUR_MS);
}
