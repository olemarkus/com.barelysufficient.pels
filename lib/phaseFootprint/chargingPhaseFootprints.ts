import type { ChargingPhaseCount, ChargingPhaseName } from '../../packages/contracts/src/chargingPhases';
import type { ChargingPhasePoint } from '../../packages/planner-types/src/chargingPhases';
import type { PhaseFootprint } from '../../packages/planner-types/src/phaseFootprint';
import type { DevicePhaseConnection } from '../../packages/shared-domain/src/settings/devicePhaseConnections';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

/** The already-resolved amp ladder names its operating envelope, never a saved installation preset. */
export function resolveOperatingChargingPhases(
  profile: SteppedLoadProfile | undefined,
): ChargingPhaseCount | undefined {
  const step = profile?.steps.find((entry) => (entry.planningCurrentA ?? 0) > 0);
  if (!step || step.planningCurrentA === undefined) return undefined;
  const wattsPerAmp = step.planningPowerW / step.planningCurrentA;
  if (wattsPerAmp === 230) return 1;
  if (wattsPerAmp === 690) return 3;
  return undefined;
}
type ChargingPhaseMeasurement = {
  currentLimitA: number;
  powers: readonly [{ watts: number }, { watts: number }, { watts: number }];
  totalPower: { watts: number };
};

/** One installation setting names both its three-phase circuit and its single-phase house mapping. */
export function chargingSingleHousePhase(connection: DevicePhaseConnection | undefined): ChargingPhaseName | undefined {
  switch (connection) {
    case 'three_L1': return 'L1';
    case 'three_L2': return 'L2';
    case 'three_L3': return 'L3';
    default: return undefined;
  }
}

/** Separate envelopes never inherit session-learned single-phase guesses from each other. */
export function resolveChargingPhaseFootprint(
  connection: DevicePhaseConnection | undefined, phases: ChargingPhaseCount,
): PhaseFootprint {
  const single = chargingSingleHousePhase(connection);
  if (single === undefined) return { kind: 'unknown' };
  return phases === 3 ? { kind: 'all_three' } : { kind: 'single', phase: single };
}

/**
 * The local first phase is mapped explicitly. The other two wires' order is unknown,
 * so either house phase retains the larger measured draw; total power remains measured.
 */
export function resolveChargingPhaseObservedPoint(
  device: ChargingPhaseMeasurement, phases: ChargingPhaseCount, connection: DevicePhaseConnection | undefined,
): ChargingPhasePoint {
  const [first, second, third] = device.powers.map((power) => power.watts / 1000);
  const a = first ?? 0;
  const b = second ?? 0;
  const c = third ?? 0;
  const single = chargingSingleHousePhase(connection);
  const largest = Math.max(a, b, c);
  const remainder = Math.max(b, c);
  const housePhasePowerKw = (phase: ChargingPhaseName): number => {
    if (single === undefined) return largest;
    return phase === single ? a : remainder;
  };
  return {
    phases, currentA: device.currentLimitA, totalKw: device.totalPower.watts / 1000,
    perPhaseKw: { L1: housePhasePowerKw('L1'), L2: housePhasePowerKw('L2'), L3: housePhasePowerKw('L3') },
  };
}
