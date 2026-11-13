import { describe, expect, it } from 'vitest';
import { confirmsChargingPhases } from '../../lib/chargingPhases/phaseObservation';
import type { ChargingPhaseDevice } from '../../lib/ports/chargingPhases';

const device = (watts: readonly [number, number, number], totalW: number): ChargingPhaseDevice => ({
  deviceId: 'charger', available: true, connected: true, managed: true, controlEnabled: true,
  forceSinglePhase: false, forceSinglePhaseObservedAtMs: 1000,
  currentLimitA: 6, minimumCurrentA: 6, maximumCurrentA: 16, configuredPhases: 3, planningPhases: 3, drawingPhases: 3,
  powers: [{ watts: watts[0], observedAtMs: 1000 }, { watts: watts[1], observedAtMs: 1000 },
    { watts: watts[2], observedAtMs: 1000 }], totalPower: { watts: totalW, observedAtMs: 1000 },
});

describe('independent charging-phase power evidence', () => {
  it('ignores a small non-charging phase reading and classifies a two-phase vehicle conservatively', () => {
    expect(confirmsChargingPhases(device([1380, 20, 0], 1400), 1, 900)).toBe(true);
    expect(confirmsChargingPhases(device([1380, 1380, 0], 2760), 3, 900)).toBe(true);
    expect(confirmsChargingPhases(device([0, 0, 0], 0), 1, 900)).toBe(false);
  });

  it('rejects a one-phase view that contradicts the independently reported total', () => {
    expect(confirmsChargingPhases(device([1380, 0, 0], 4140), 1, 900)).toBe(false);
  });

  it('does not require a quiet zero reading to gain a new timestamp', () => {
    const read = device([1380, 0, 0], 1380);
    read.powers = [{ watts: 1380, observedAtMs: 1000 }, { watts: 0, observedAtMs: 1 },
      { watts: 0, observedAtMs: 1 }];
    expect(confirmsChargingPhases(read, 1, 900)).toBe(true);
  });

  it('confirms a 6 A contraction when L1 power is unchanged and only the other phases and total change', () => {
    const read = device([1380, 0, 0], 1380);
    read.powers = [{ watts: 1380, observedAtMs: 1 }, { watts: 0, observedAtMs: 1000 },
      { watts: 0, observedAtMs: 1000 }];
    expect(confirmsChargingPhases(read, 1, 900)).toBe(true);
  });

  it('does not use a pre-command drawing reading to confirm a subsequent command', () => {
    expect(confirmsChargingPhases(device([1380, 1380, 1380], 4140), 3, 1100)).toBe(false);
    expect(confirmsChargingPhases(device([1380, 0, 0], 1380), 1, 1100)).toBe(false);
  });
});
