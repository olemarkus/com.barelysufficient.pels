import { describe, expect, it } from 'vitest';
import { confirmsChargingPhases, isChargingPhaseFloor } from '../../lib/chargingPhases/phaseObservation';
import type { ChargingPhaseDevice } from '../../lib/ports/chargingPhases';

const device = (watts: readonly [number, number, number], totalW: number): ChargingPhaseDevice => ({
  deviceId: 'charger', available: true, connected: true, managed: true, controlEnabled: true,
  forceSinglePhase: false, forceSinglePhaseObservedAtMs: 1000,
  currentLimitA: 6, minimumCurrentA: 6, maximumCurrentA: 16, configuredPhases: 3, planningPhases: 3, drawingPhases: 3,
  powers: [{ watts: watts[0], observedAtMs: 1000 }, { watts: watts[1], observedAtMs: 1000 },
    { watts: watts[2], observedAtMs: 1000 }], totalPower: { watts: totalW, observedAtMs: 1000 },
  phaseVoltagesV: [null, null, null],
});

describe('charging phase floor', () => {
  const envelopes = ([1, 3] as const).map((phases) => ({
    phases,
    footprint: phases === 1 ? { kind: 'single' as const, phase: 'L1' as const } : { kind: 'all_three' as const },
    profile: { steps: [6, 8].map((currentA) => ({
      id: `${currentA}a`, planningCurrentA: currentA, planningPowerW: currentA * phases * 230,
    })) },
  }));

  it.each([210, 230, 236, 240, 253])('admits coherent measured 6 A at %s V', (volts) => {
    const watts = 6 * volts;
    const read = device([watts, watts, watts], 3 * watts);
    read.phaseVoltagesV = [volts, volts, volts];
    expect(isChargingPhaseFloor(read, envelopes)).toBe(true);
  });

  it.each([
    { voltages: [210, 210, 210], watts: [1365, 1365, 1365], totalW: 4095 },
    { voltages: [240, 240, 240], watts: [1560, 1360, 1360], totalW: 4280 },
    { voltages: [240, 240, 240], watts: [1440, 1440, 1440], totalW: 4200 },
    { voltages: [0, 240, 240], watts: [1440, 1440, 1440], totalW: 4320 },
    { voltages: [null, 240, 240], watts: [1440, 1440, 1440], totalW: 4320 },
  ] as const)('rejects readings when $voltages V do not support $watts W and $totalW W total', ({
    voltages, watts, totalW,
  }) => {
    const read = device(watts, totalW);
    read.phaseVoltagesV = voltages;
    expect(isChargingPhaseFloor(read, envelopes)).toBe(false);
  });

  it('uses L1 for the single-phase geometry', () => {
    const read = device([1440, 0, 0], 1440);
    read.planningPhases = 1;
    read.phaseVoltagesV = [240, null, null];
    expect(isChargingPhaseFloor(read, envelopes)).toBe(true);
  });

  it('keeps the configured-current fence and uses the policy minimum for the measured floor', () => {
    const read = device([1920, 1920, 1920], 5760);
    read.phaseVoltagesV = [240, 240, 240];
    read.currentLimitA = 8;
    expect(isChargingPhaseFloor(read, envelopes)).toBe(false);
    read.minimumCurrentA = 8;
    expect(isChargingPhaseFloor(read, envelopes)).toBe(true);
  });
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
