import { describe, expect, it } from 'vitest';
import { decideStorageRelief } from '../../lib/plan/battery/storageRelief';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { PhasePower } from '../../lib/plan/phase/phasePower';
import type { ObservedStorageInput } from '../../packages/planner-types/src/planInputDevice';
import type { PhaseFootprint, PhaseName } from '../../packages/planner-types/src/phaseFootprint';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';

const NOW = 1_000_000;
const charging = { setpointW: 2000, validUntilMs: NOW + 600_000, reason: 'charge_grid' as const };

const battery = (id: string, phaseFootprint: PhaseFootprint): PlanInputDevice & { storage: ObservedStorageInput } => ({
  ...buildPlanInputDevice({ id, name: id, isBatteryOrSolar: true, commandAuthority: false, currentDrawKw: 0, phaseFootprint }),
  storage: {
    reading: 'observed', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false, signedPowerW: 0, observedAtMs: NOW, claimHeld: true, admissible: true,
    verdict: 'responding', deliveryCeilingW: 2500, chargeCeilingW: 2500, powerLimitControl: true,
    continuousPlan: charging,
  },
});

const offers = (ids: readonly string[]) => new Map(ids.map(id => [id, {
  availableW: 0, addedBackW: 0, belowW: 0, demandAbove: 'none' as const,
}]));

/** Each phase's room under its target, kW, against a 5.5 kW target. */
const phases = (roomKw: Record<PhaseName, number>): PhasePower => ({
  kind: 'on',
  phases: (['L1', 'L2', 'L3'] as const).map(phase => ({
    phase, drawKw: 5.5 - roomKw[phase], targetKw: 5.5, roomKw: roomKw[phase],
    breached: false, exportBreached: false, exportExcessKw: 0,
  })),
});

// Each phase keeps its clear band (`SHEDDING_CLEAR_THRESHOLD_KW`, 0.4 kW) free.
const decide = (devices: readonly PlanInputDevice[], roomKw: Record<PhaseName, number>) => decideStorageRelief(
  devices, buildMeasuredPower({ drawKw: 3, headroomKw: 10, phase: phases(roomKw) }), {},
  offers(devices.map(device => device.id)), NOW,
).levers;

describe('battery charge within its phases', () => {
  it('shares one phase\'s room between batteries on it, in decision order', () => {
    const levers = decide(
      [battery('first', { kind: 'single', phase: 'L1' }), battery('second', { kind: 'single', phase: 'L1' })],
      { L1: 3, L2: 5, L3: 5 },
    );
    expect(levers.first.setpointW).toBe(2000);
    expect(levers.second.setpointW).toBe(600);
  });

  it('keeps batteries on different phases apart', () => {
    const levers = decide(
      [battery('first', { kind: 'single', phase: 'L1' }), battery('second', { kind: 'single', phase: 'L2' })],
      { L1: 1, L2: 5, L3: 5 },
    );
    expect(levers.first.setpointW).toBe(600);
    expect(levers.second.setpointW).toBe(2000);
  });

  it('bounds a three-phase battery by three times the lowest phase', () => {
    const levers = decide([battery('first', { kind: 'all_three' })], { L1: 1, L2: 5, L3: 5 });
    expect(levers.first.setpointW).toBe(1800);
  });

  it('leaves a battery on an unknown phase unbounded, so it keeps storing solar', () => {
    const levers = decide([battery('first', { kind: 'unknown' })], { L1: 0.5, L2: 5, L3: 5 });
    expect(levers.first.setpointW).toBe(2000);
  });

  it('charges as before when phases are not protected', () => {
    const levers = decideStorageRelief([battery('first', { kind: 'single', phase: 'L1' })],
      buildMeasuredPower({ drawKw: 3, headroomKw: 10 }), {}, offers(['first']), NOW).levers;
    expect(levers.first.setpointW).toBe(2000);
  });
});
