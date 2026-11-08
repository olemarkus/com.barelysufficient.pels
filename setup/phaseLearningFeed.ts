import type CapacityGuard from '../lib/power/capacityGuard';
import type { ActuationHistoryRead } from '../lib/ports/actuationHistory';
import type { DeviceSurfaces } from '../packages/contracts/src/deviceSurfaces';
import { isEvPlugStateConnected } from '../packages/shared-domain/src/evPlugState';

type LearningGuard = Pick<CapacityGuard, 'phaseReadings' | 'phaseLearner'>;

/** Hand the learner one accepted phase sample and the managed devices beside it. Wiring only. */
export function feedPhaseLearning(
  guard: LearningGuard,
  devices: readonly DeviceSurfaces[],
  actuation: Pick<ActuationHistoryRead, 'lastDeviceControlledMs'>,
  nowMs: number,
): void {
  const reading = guard.phaseReadings.current();
  if (reading.kind !== 'healthy') return;
  const [l1, l2, l3] = reading.phases;
  guard.phaseLearner.observe({
    atMs: nowMs,
    phasesKw: [l1.kw, l2.kw, l3.kw],
    devices: devices.flatMap((device) => {
      if (device.managed !== true || typeof device.measuredPowerKw !== 'number') return [];
      return [{
        deviceId: device.id,
        drawKw: device.measuredPowerKw,
        isEvCharger: device.isEvCharger === true,
        evSessionActive: device.evChargingState !== undefined && isEvPlugStateConnected(device.evChargingState),
        lastCommandAtMs: actuation.lastDeviceControlledMs[device.id],
      }];
    }),
  });
}
