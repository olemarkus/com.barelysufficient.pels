import { withoutStorageWithheld } from '../../lib/plan/battery/storageLimit';
import { decideStorageReliefFixture as decideStorageRelief } from '../helpers/storageReliefFixture';
import { phaseExportRoomKw } from '../../lib/plan/phase/phasePower';
import { resolvePhaseRoomAxis } from '../../lib/plan/phase/phaseRoom';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';
import { planStorageHandBack } from '../../lib/plan/restore/storageHandBack';
import type { RestoreCycle } from '../../lib/plan/restore/types';
import { buildPlanDevice, buildPlanInputDevice, restoreCycleFixture } from '../utils/planTestUtils';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import type { ContinuousStoragePlan, ObservedStorageInput } from '../../packages/planner-types/src/planInputDevice';
import type { StorageLeverState } from '../../lib/plan/planState';

const lever = (overrides: Partial<StorageLeverState>): StorageLeverState => ({
  setpointW: -500,
  purpose: 'limit',
  increaseDecidedAtMs: 0,
  creditBaseW: 0,
  lastDecreaseAtMs: 0,
  chargeRaisedAtMs: 0,
  lastNeedAtMs: 0,
  limitedChargeW: 0,
  stepW: 5,
  reading: { kind: 'read' },
  exportPhase: 'L1',
  ...overrides,
});

function restoresToIdle(held: StorageLeverState, phaseRoomKw = 2, continuousPlan?: ContinuousStoragePlan): boolean {
  const state = createPlanEngineState();
  const device = buildPlanDevice({ id: 'battery', phaseFootprint: { kind: 'single', phase: 'L1' } });
  const power = buildMeasuredPower({ drawKw: 2, headroomKw: 10, phase: {
    kind: 'on',
    phases: (['L1', 'L2', 'L3'] as const).map((phase) => ({
      phase, drawKw: 5.5 - phaseRoomKw, roomKw: phaseRoomKw, targetKw: 5.5,
      breached: false, exportBreached: false, exportExcessKw: 0,
    })),
  } });
  const storage: ObservedStorageInput = {
    reading: 'observed', claimHeld: true, signedPowerW: held.setpointW, observedAtMs: 10_000,
    powerLimitControl: true, admissible: true, handBackDeferred: false, verdict: 'responding',
    range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    deliveryCeilingW: 2500, canSetDischargePower: true, chargeCeilingW: 2500, ownModeGridCharge: { kind: 'observed' },
    continuousPlan,
  };
  const battery = { ...buildPlanInputDevice({ id: 'battery', phaseFootprint: device.phaseFootprint }), storage };
  const offers = new Map([['battery', { availableW: 0, addedBackW: 0, belowW: 0, demandAbove: 'none' as const }]]);
  const relief = decideStorageRelief([battery], power, { battery: held }, offers, 10_000, 0);
  const admissionPower = withoutStorageWithheld(power, relief, [battery], 0);
  const cycle: RestoreCycle = {
    ...restoreCycleFixture(new Map([['battery', device]]), state, { nowTs: 10_000 }),
    readPhaseRoom: () => resolvePhaseRoomAxis(admissionPower.phase),
    readPhaseExportRoomKw: (phase) => phaseExportRoomKw(admissionPower.phase, phase),
  };
  planStorageHandBack(cycle, device, relief.levers.battery, {
    availableHeadroom: 10, restoredOneThisCycle: false,
  });
  return cycle.storageHandedBack.has('battery');
}

describe('returning a battery from a limit to managed idle', () => {
  it('can return from an export limit once the phase can absorb the loss of discharge', () => {
    const held = lever({ setpointW: -1500 });
    expect(restoresToIdle(held, 0.5)).toBe(false);
    expect(restoresToIdle(held, 2)).toBe(true);
  });

  it('waits while an active economic period would exceed the phase export room after restore', () => {
    const held = lever({});
    const sale: ContinuousStoragePlan = {
      reason: 'export_energy', setpointW: -2000, validUntilMs: 20_000, netExportCeilingW: 2000,
    };
    // Raw phase export room is 0.75 kW; after the clear band only 0.35 kW remains.
    expect(restoresToIdle(held, 10.25, sale)).toBe(false);
    expect(restoresToIdle(held, 8, sale)).toBe(true);
    expect(restoresToIdle(held, 10.25, { ...sale, validUntilMs: 9_000 })).toBe(true);
  });

  it('caps household supply resume by the delivery ceiling instead of the forecast demand', () => {
    const supply: ContinuousStoragePlan = {
      reason: 'supply_house', setpointW: -600, validUntilMs: 20_000, storesSurplus: false,
    };
    expect(restoresToIdle(lever({}), 10, supply)).toBe(false);
  });

  it('waits for an ordinary capacity discharge to be eased to zero', () => {
    expect(restoresToIdle(lever({ exportPhase: undefined }))).toBe(false);
    expect(restoresToIdle(lever({ setpointW: 0, exportPhase: undefined }))).toBe(true);
  });
});
