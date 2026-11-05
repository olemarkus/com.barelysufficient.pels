import { describe, expect, it } from 'vitest';
import { decideStorageRelief, resolveStorageSurplus, resumeContinuousStorage } from '../../lib/plan/battery/storageRelief';
import { applyStorageHandBacks, applyStorageLimits } from '../../lib/plan/battery/storageLimit';
import { buildStorageCandidate, resolveStorageSpend } from '../../lib/plan/shedding/storageCandidate';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { StorageLeverState } from '../../lib/plan/planState';
import type { ObservedStorageInput } from '../../packages/planner-types/src/planInputDevice';
import { buildPlanInputDevice } from '../utils/planTestUtils';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';

const NOW = 1_000_000;
const battery = (overrides: Partial<ObservedStorageInput> = {}, id = 'battery'): PlanInputDevice & { storage: ObservedStorageInput } => ({
  ...buildPlanInputDevice({ id, name: id, isBatteryOrSolar: true, commandAuthority: false, currentDrawKw: 0 }),
  storage: {
    reading: 'observed', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false, signedPowerW: 0, observedAtMs: 0, claimHeld: true, admissible: true,
    verdict: 'responding', deliveryCeilingW: 2500, chargeCeilingW: 2500, powerLimitControl: true,
    continuousPlan: { setpointW: 0, validUntilMs: NOW + 60_000, reason: 'hold_energy', storesSurplus: true },
    ...overrides,
  },
});
const offers = (ids = ['battery']) => new Map(ids.map(id => [id, {
  availableW: 0, addedBackW: 0, belowW: 0, demandAbove: 'none' as const,
}]));

describe('continuous battery execution decisions', () => {
  it('retains the original own-mode power across limit hand-back and later idle release', () => {
    const native = battery();
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: 3 });
    const original = decideStorageRelief([native], power, {}, offers(), NOW);
    const limited = applyStorageLimits(original,
      new Map([['battery', { setpointW: -1000, banked: true, storage: native.storage }]]), NOW);
    const supplying = battery({ signedPowerW: -1000,
      continuousPlan: { setpointW: -1000, validUntilMs: NOW + 60_000, reason: 'supply_house', storesSurplus: true },
    });
    const resumed = resumeContinuousStorage(applyStorageHandBacks(limited, new Set(['battery'])),
      limited, [supplying], power, offers(), NOW + 1000);
    expect(resumed.levers.battery.preClaimSignedW).toBe(0);
    expect(resumed.batteries[0].decision).toMatchObject({ kind: 'setpoint', restored: true });
    const released = decideStorageRelief([battery({ signedPowerW: -1000, continuousPlan: undefined })],
      power, resumed.levers, offers(), NOW + 2000);
    expect(released.batteries[0].decision).toEqual({ kind: 'release', reason: 'idle' });
    expect(released.shed.netCreditKw).toBe(-1);
  });

  it('opens a fresh discharge credit after a long zero hold without extending an unanswered window', () => {
    const plan = (setpointW: number) => ({ setpointW, validUntilMs: NOW + 600_000, reason: 'supply_house' as const, storesSurplus: true });
    const idle = decideStorageRelief([battery({ continuousPlan: plan(0) })], buildMeasuredPower(), {}, offers(), NOW);
    const supplying = decideStorageRelief([battery({ continuousPlan: plan(-1000) })],
      buildMeasuredPower({ drawKw: 3 }), idle.levers, offers(), NOW + 60_000);
    expect(supplying.shed.netCreditKw).toBe(1);
    expect(supplying.levers.battery.increaseDecidedAtMs).toBe(NOW + 60_000);
    const deeper = decideStorageRelief([battery({ continuousPlan: plan(-1500) })],
      buildMeasuredPower({ drawKw: 3 }), supplying.levers, offers(), NOW + 70_000);
    expect(deeper.levers.battery.increaseDecidedAtMs).toBe(NOW + 60_000);
    const unanswered = decideStorageRelief([battery({ continuousPlan: plan(-2000) })],
      buildMeasuredPower({ drawKw: 3 }), deeper.levers, offers(), NOW + 91_000);
    expect(unanswered.shed.netCreditKw).toBe(0);
    const delivered = decideStorageRelief([battery({ signedPowerW: -1500, continuousPlan: plan(-2000) })],
      buildMeasuredPower({ drawKw: 3 }), deeper.levers, offers(), NOW + 91_000);
    expect(delivered.shed.netCreditKw).toBe(0.5);
  });

  it('retains a zero-watt hold between windows, including a full battery', () => {
    const result = decideStorageRelief([battery({ chargeCeilingW: 0 })], buildMeasuredPower(), {}, offers(), NOW);
    expect(result.batteries[0].decision).toEqual({ kind: 'setpoint', setpointW: 0, stepW: 5 });
    expect(result.levers.battery.purpose).toBe('continuous');
  });

  it('never invents capacity discharge when a charging window has no room', () => {
    const result = decideStorageRelief([battery({
      continuousPlan: { setpointW: 2000, validUntilMs: NOW + 60_000, reason: 'charge_grid' },
    })], buildMeasuredPower({ headroomKw: 0 }), {}, offers(), NOW);
    expect(result.batteries[0].setpointW).toBe(0);
    expect(result.levers.battery.purpose).toBe('continuous');
  });

  it('bounds economic discharge to actual house import and the configured reserve ceiling', () => {
    const input = battery({ continuousPlan: { setpointW: -2500, validUntilMs: NOW + 60_000, reason: 'supply_house', storesSurplus: true } });
    const power = buildMeasuredPower({ drawKw: 0.5 });
    expect(decideStorageRelief([input], power, {}, offers(), NOW).batteries[0].setpointW).toBe(-400);
    const reserved = battery({
      deliveryCeilingW: 0,
      continuousPlan: { setpointW: -2500, validUntilMs: NOW + 60_000, reason: 'supply_house', storesSurplus: true },
    });
    expect(decideStorageRelief([reserved], power, {}, offers(), NOW).batteries[0].setpointW).toBe(0);
  });

  describe('measured export in a supply or hold period', () => {
    const supply = (storesSurplus: boolean, setpointW = -2500) => (
      { setpointW, validUntilMs: NOW + 60_000, reason: 'supply_house' as const, storesSurplus }
    );
    const exporting = buildMeasuredPower({ drawKw: -1, headroomKw: 10 });
    const offer = (availableW: number, belowW = 0) => new Map([['battery', {
      availableW, addedBackW: 0, belowW, demandAbove: 'none' as const,
    }]]);

    it('stores the export its offer leaves instead of waiting at 0 W, less the draw margin', () => {
      const result = decideStorageRelief([battery({ continuousPlan: supply(true) })], exporting, {}, offer(1000), NOW);
      expect(result.batteries[0]).toMatchObject({ setpointW: 900, claim: 'plan_solar' });
      expect(result.levers.battery.continuousReason).toBe('supply_house');
      const hold = battery({ continuousPlan: { setpointW: 0, validUntilMs: NOW + 60_000, reason: 'hold_energy', storesSurplus: true } });
      expect(decideStorageRelief([hold], exporting, {}, offer(1000), NOW).batteries[0].setpointW).toBe(900);
    });

    it('keeps storing what it already charges once the meter no longer shows it', () => {
      // Charging 900 W: the pool counts that charge back, so the meter's last 100 W does not shrink it.
      const charging = battery({ signedPowerW: 900, continuousPlan: supply(true) });
      const steady = new Map([['battery', { availableW: 1000, addedBackW: 900, belowW: 0, demandAbove: 'none' as const }]]);
      expect(decideStorageRelief([charging], buildMeasuredPower({ drawKw: -0.1, headroomKw: 10 }), {}, steady, NOW)
        .batteries[0].setpointW).toBe(900);
    });

    it('leaves what the devices ranked below it take, and stays within its charge ceiling', () => {
      expect(decideStorageRelief([battery({ continuousPlan: supply(true) })], exporting, {}, offer(1000, 400), NOW)
        .batteries[0].setpointW).toBe(500);
      expect(decideStorageRelief([battery({ chargeCeilingW: 300, continuousPlan: supply(true) })], exporting, {},
        offer(1000), NOW).batteries[0].setpointW).toBe(300);
      // Under the deadband the battery waits rather than chase noise.
      expect(decideStorageRelief([battery({ continuousPlan: supply(true) })], exporting, {}, offer(120), NOW)
        .batteries[0].setpointW).toBe(0);
    });

    it('exports when the export is worth more than storing it, and never discharges into the export', () => {
      const result = decideStorageRelief([battery({ continuousPlan: supply(false) })], exporting, {}, offer(1000), NOW);
      expect(result.batteries[0]).toMatchObject({ setpointW: 0, claim: 'plan_wait' });
    });

    it('still supplies the house, not storage, when the house imports', () => {
      const importing = buildMeasuredPower({ drawKw: 0.5 });
      expect(decideStorageRelief([battery({ continuousPlan: supply(true) })], importing, {}, offer(0), NOW)
        .batteries[0].setpointW).toBe(-400);
    });

    it('never stores export in a selling period', () => {
      const sale = { setpointW: -2000, validUntilMs: NOW + 60_000, reason: 'export_energy' as const, netExportCeilingW: 1500 };
      expect(decideStorageRelief([battery({ continuousPlan: sale })], exporting, {}, offer(1000), NOW)
        .batteries[0].setpointW).toBeLessThan(0);
    });
  });

  it('lets a selling period export up to the owner ceiling on top of the house, never past the plan or reserve', () => {
    const sell = (setpointW: number, netExportCeilingW: number) => (
      { setpointW, validUntilMs: NOW + 60_000, reason: 'export_energy' as const, netExportCeilingW }
    );
    const power = buildMeasuredPower({ drawKw: 0.5 });
    // 0.5 kW of house draw plus 1.5 kW of export, less the 100 W response margin.
    const selling = decideStorageRelief([battery({ continuousPlan: sell(-2500, 1500) })], power, {}, offers(), NOW);
    expect(selling.batteries[0]).toMatchObject({ setpointW: -1900, claim: 'plan_export' });
    expect(selling.levers.battery.continuousReason).toBe('export_energy');
    // The plan's own setpoint and the reserve ceiling still bound the sale.
    expect(decideStorageRelief([battery({ continuousPlan: sell(-1000, 1500) })], power, {}, offers(), NOW)
      .batteries[0].setpointW).toBe(-1000);
    expect(decideStorageRelief([battery({ deliveryCeilingW: 0, continuousPlan: sell(-2500, 1500) })], power, {},
      offers(), NOW).batteries[0].setpointW).toBe(0);
  });

  it('takes measured house demand out of a sale rather than raising discharge to keep the forecast export', () => {
    const plan = { setpointW: -2000, validUntilMs: NOW + 60_000, reason: 'export_energy' as const, netExportCeilingW: 1500 };
    const quiet = decideStorageRelief([battery({ continuousPlan: plan })], buildMeasuredPower({ drawKw: 0 }), {}, offers(), NOW);
    expect(quiet.batteries[0].setpointW).toBe(-1400);
    const busy = decideStorageRelief([battery({ continuousPlan: plan })], buildMeasuredPower({ drawKw: 1.8 }), {}, offers(), NOW);
    expect(busy.batteries[0].setpointW).toBe(-2000);
  });

  it('banks no speculative credit for a sale and withholds its discharge from restores', () => {
    const plan = { setpointW: -1500, validUntilMs: NOW + 600_000, reason: 'export_energy' as const, netExportCeilingW: 3000 };
    const idle = decideStorageRelief([battery()], buildMeasuredPower({ drawKw: 3 }), {}, offers(), NOW);
    const selling = decideStorageRelief([battery({ continuousPlan: plan })], buildMeasuredPower({ drawKw: 3 }),
      idle.levers, offers(), NOW + 60_000);
    expect(selling.batteries[0].setpointW).toBe(-1500);
    expect(selling.shed.netCreditKw).toBe(0);
    expect(selling.batteries[0].withheldW).toBe(1500);
  });

  describe('a sale PELS cannot read', () => {
    const sale = { setpointW: -2000, validUntilMs: NOW + 600_000, reason: 'export_energy' as const, netExportCeilingW: 3000 };
    const selling = () => decideStorageRelief([battery({ continuousPlan: sale })],
      buildMeasuredPower({ drawKw: 0 }), {}, offers(), NOW);
    const unread = (id = 'battery') => ({
      ...battery({}, id), storage: { reading: 'missing' as const, handBackDeferred: false, claimHeld: true as const, admissible: true },
    });

    it('steps a missing sale to 0 W at once, and keeps it there, rather than resending it for the window', () => {
      const first = selling();
      expect(first.levers.battery.setpointW).toBe(-2000);
      const missing = decideStorageRelief([unread()], buildMeasuredPower({ drawKw: -2 }), first.levers, offers(), NOW + 10_000);
      expect(missing.batteries[0]).toMatchObject({
        decision: { kind: 'setpoint', setpointW: 0 }, claim: 'plan_wait', withheldW: 2000,
      });
      // Whatever happened to the plan meanwhile, an unread sale stays stopped until its hold is released.
      const later = decideStorageRelief([unread()], buildMeasuredPower({ drawKw: 0 }), missing.levers, offers(),
        NOW + 20_000);
      expect(later.batteries[0]).toMatchObject({ decision: { kind: 'setpoint', setpointW: 0 }, claim: 'plan_wait' });
    });

    it('stops the sale of a battery that left the plan too, sending nothing', () => {
      const absent = decideStorageRelief([], buildMeasuredPower({ drawKw: -2 }), selling().levers, offers(), NOW + 10_000);
      expect(absent.levers.battery.setpointW).toBe(0);
      expect(absent.batteries[0]).toMatchObject({ decision: { kind: 'none' }, claim: 'plan_wait' });
    });

    it('never lets an unread held discharge look like solar surplus', () => {
      const { levers } = selling();
      expect(resolveStorageSurplus([unread()], levers, -2000).dischargeW).toBe(2000);
      expect(resolveStorageSurplus([], levers, -2000).dischargeW).toBe(2000);
      // A battery read this cycle counts its own observed discharge instead.
      expect(resolveStorageSurplus([battery({ signedPowerW: -1500 })], levers, -1500).dischargeW).toBe(1500);
    });
  });

  it('holds but never raises a discharge while the battery reading lags the meter sample', () => {
    const supply = { setpointW: -2500, validUntilMs: NOW + 60_000, reason: 'supply_house' as const, storesSurplus: true };
    const sale = { setpointW: -2500, validUntilMs: NOW + 600_000, reason: 'export_energy' as const, netExportCeilingW: 1500 };
    const meter = (sampledAtMs: number) => buildMeasuredPower({ drawKw: 0.2, sampledAtMs });
    const lagging = (plan: typeof supply | typeof sale) => battery({ signedPowerW: -300, observedAtMs: NOW - 20_000, continuousPlan: plan });
    expect(decideStorageRelief([lagging(supply)], meter(NOW), {}, offers(), NOW).batteries[0].setpointW).toBe(-300);
    expect(decideStorageRelief([lagging(sale)], meter(NOW), {}, offers(), NOW).batteries[0].setpointW).toBe(-300);
    // In step with the meter (within the tolerance), the room is the house's draw plus the ceiling.
    const fresh = battery({ signedPowerW: -300, observedAtMs: NOW - 5_000, continuousPlan: sale });
    expect(decideStorageRelief([fresh], meter(NOW), {}, offers(), NOW).batteries[0].setpointW).toBe(-1900);
    // A battery steady at the setpoint PELS holds it to reads old without lagging behind it.
    const held = decideStorageRelief([fresh], meter(NOW), {}, offers(), NOW).levers;
    const steady = battery({ signedPowerW: -1900, observedAtMs: NOW - 60_000, continuousPlan: sale });
    expect(decideStorageRelief([steady], meter(NOW + 60_000), held, offers(), NOW + 60_000).batteries[0].setpointW)
      .toBe(-2500);
    // One that has not reached it yet is held where it is.
    const behind = battery({ signedPowerW: -1000, observedAtMs: NOW - 60_000, continuousPlan: sale });
    expect(decideStorageRelief([behind], meter(NOW + 60_000), held, offers(), NOW + 60_000).batteries[0].setpointW)
      .toBe(-1000);
  });

  it('withholds pending charge every cycle while the meter has not observed it', () => {
    const plan = { setpointW: 1500, validUntilMs: NOW + 60_000, reason: 'charge_grid' as const };
    const devices = [battery({ continuousPlan: plan }, 'a'), battery({ continuousPlan: plan }, 'b')];
    const power = buildMeasuredPower({ drawKw: 3, headroomKw: 2 });
    const first = decideStorageRelief(devices, power, {}, offers(['a', 'b']), NOW);
    expect(first.batteries.map(item => item.setpointW)).toEqual([1500, 400]);
    const next = decideStorageRelief(devices, power, first.levers, offers(['a', 'b']), NOW + 1000);
    expect(next.batteries.map(item => item.setpointW)).toEqual([1500, 400]);
  });

  it('prices capacity relief from the new routine target when stopping an observed discharge', () => {
    const input = battery({ signedPowerW: -2000 });
    const result = decideStorageRelief([input], buildMeasuredPower({ drawKw: 3, headroomKw: 1 }), {}, offers(), NOW);
    expect(result.shed.netCreditKw).toBe(-2);
    const candidate = buildStorageCandidate(input, result.levers.battery, 3, false, NOW);
    if (typeof candidate === 'string') throw new Error('Expected battery capacity candidate');
    expect(candidate.baseW).toBe(0);
    expect(resolveStorageSpend(candidate, 1)?.setpointW).toBe(-1100);
  });

  it('releases the routine hold when its plan ends or the owner disables control', () => {
    const previous: Record<string, StorageLeverState> = decideStorageRelief([battery()], buildMeasuredPower(), {}, offers(), NOW).levers;
    const expired = battery({ continuousPlan: { setpointW: 0, validUntilMs: NOW, reason: 'hold_energy', storesSurplus: true } });
    expect(decideStorageRelief([expired], buildMeasuredPower(), previous, offers(), NOW).batteries[0].decision)
      .toEqual({ kind: 'release', reason: 'idle' });
    expect(decideStorageRelief([battery({ powerLimitControl: false })], buildMeasuredPower(), previous, offers(), NOW).batteries[0].decision)
      .toEqual({ kind: 'release', reason: 'limit_off' });
  });
});
