import type CapacityGuard from './capacityGuard';
import type { ActuationHistoryRead } from '../ports/actuationHistory';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { isHomeBatteryClassKey } from '../../packages/shared-domain/src/batteryOrSolarRole';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import { resolveOperatingChargingPhases } from '../phaseFootprint/chargingPhaseFootprints';

type LearningGuard = Pick<CapacityGuard, 'phaseReadings' | 'phaseLearner'>;
type PeakGuard = Pick<CapacityGuard, 'phasePeaks'>;
type PeakPhases = Parameters<PeakGuard['phasePeaks']['observe']>[1];
/** The phases as the planner measured them this cycle; `off` when none apply. */
type PeakPower = { readonly kind: 'off' } | { readonly kind: 'on'; readonly phases: PeakPhases };

/** Hand the learner one accepted phase sample and the managed devices beside it. */
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
        operatingPhases: device.isEvCharger ? resolveOperatingChargingPhases(device.steppedLoadProfile) : undefined,
        lastCommandAtMs: actuation.lastDeviceControlledMs[device.id],
      }];
    }),
  });
}

const MIN_DRAWING_KW = 0.1;

// A solar inverter's reading is production. A battery counts only while charging:
// its measured draw is 0 while it discharges.
const isLoadDrawing = (device: DeviceSurfaces): boolean => (
  (device.measuredPowerKw ?? 0) > MIN_DRAWING_KW
  && (device.isBatteryOrSolar !== true || isHomeBatteryClassKey(device.deviceClass))
);

/** Hand the peak log this sample's phases and the managed devices drawing most. */
export function feedPhasePeaks(
  guard: PeakGuard,
  devices: readonly DeviceSurfaces[],
  power: PeakPower,
  nowMs: number,
): void {
  if (power.kind === 'off') return;
  const drawing = devices
    .filter((device) => device.managed === true && isLoadDrawing(device))
    .sort((a, b) => (b.measuredPowerKw ?? 0) - (a.measuredPowerKw ?? 0))
    .map((device) => device.name);
  guard.phasePeaks.observe(nowMs, power.phases, drawing);
}
