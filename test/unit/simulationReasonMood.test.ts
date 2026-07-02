import { describe, expect, it } from 'vitest';
import { toSimulationReasonLine } from '../../packages/shared-domain/src/simulationReasonMood';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_STATUS,
} from '../../packages/shared-domain/src/planStateLabels';

// In simulation, a held/limited device's reason line must read hypothetically to
// agree with its "Would be … (simulation)" state line. The transform is the
// single source of that mood shift for every card surface (generic / thermostat /
// stepped). Non-acted reasons pass through unchanged.

describe('toSimulationReasonLine — held/limited reasons read hypothetically in simulation', () => {
  it('flips the generic + thermostat hard-cap / daily / hourly "Limited …" lines', () => {
    // Generic on/off held device and thermostat capacity reason share this line.
    expect(toSimulationReasonLine(PLAN_STATE_HELD_FALLBACK_STATUS, true))
      .toBe('Would be limited by the hard cap');
    expect(toSimulationReasonLine(PLAN_STATE_DAILY_BUDGET_STATUS, true))
      .toBe("Would be limited by today's daily budget");
    expect(toSimulationReasonLine(PLAN_STATE_HOURLY_BUDGET_STATUS, true))
      .toBe('Would be limited — this hour is near the hard cap');
  });

  it('flips budget-starvation and swap "Limited …" lines', () => {
    // Generic already-off / budget-starved device.
    expect(toSimulationReasonLine("Limited to stay within today's budget", true))
      .toBe("Would be limited to stay within today's budget");
    expect(toSimulationReasonLine('Limited so another device can run', true))
      .toBe('Would be limited so another device can run');
    // Stepped card status line.
    expect(toSimulationReasonLine('Limited to 6 A — 2 devices still limited', true))
      .toBe('Would be limited to 6 A — 2 devices still limited');
  });

  it('flips the swap "Making room …" line for both bare and named-target variants', () => {
    expect(toSimulationReasonLine('Making room for higher-priority device', true))
      .toBe('Would make room for a higher-priority device');
    // Named target: the "(Bedroom)" suffix is carried through the rewrite.
    expect(toSimulationReasonLine('Making room for higher-priority device (Bedroom)', true))
      .toBe('Would make room for a higher-priority device (Bedroom)');
  });

  it('flips the named "Limited so <device> can run" swap line', () => {
    expect(toSimulationReasonLine('Limited so Water Heater can run', true))
      .toBe('Would be limited so Water Heater can run');
  });

  it('flips the deferred-objective "Waiting for cheaper hours" line', () => {
    expect(toSimulationReasonLine('Waiting for cheaper hours', true))
      .toBe('Would wait for cheaper hours');
  });

  it('leaves non-acted reasons factual in simulation (physical / resuming / normal)', () => {
    // Physical capacity constraint — true in simulation or not.
    expect(toSimulationReasonLine('Waiting for available power', true))
      .toBe('Waiting for available power');
    // Resuming / waiting-to-resume / normal operation.
    expect(toSimulationReasonLine('Resuming', true)).toBe('Resuming');
    expect(toSimulationReasonLine('Waiting to resume — 0.8 kW more needed', true))
      .toBe('Waiting to resume — 0.8 kW more needed');
    expect(toSimulationReasonLine('Maintaining level', true)).toBe('Maintaining level');
    // The already-hypothetical held state-action label is not double-tagged.
    expect(toSimulationReasonLine('Would be lowered (simulation)', true))
      .toBe('Would be lowered (simulation)');
    expect(toSimulationReasonLine('', true)).toBe('');
  });

  it('is a no-op outside simulation (every reason stays factual)', () => {
    expect(toSimulationReasonLine(PLAN_STATE_HELD_FALLBACK_STATUS, false))
      .toBe('Limited by the hard cap');
    expect(toSimulationReasonLine('Making room for higher-priority device', false))
      .toBe('Making room for higher-priority device');
    expect(toSimulationReasonLine('Waiting for cheaper hours', false))
      .toBe('Waiting for cheaper hours');
  });
});
