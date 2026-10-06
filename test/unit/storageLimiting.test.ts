// A home battery as a ranked limiting candidate (owner ruling, 2026-10-06):
// its candidate and what it is spent for, the limit hold shedding's choice
// becomes, the credit split between pending relief and the storage term, and
// the restore hand-back.
import { buildStorageCandidate, resolveStorageSpend } from '../../lib/plan/shedding/storageCandidate';
import { selectShedDevices } from '../../lib/plan/shedding/selection';
import { resolvePendingShedRelief } from '../../lib/plan/shedding/pendingRelief';
import { applyStorageHandBacks, applyStorageLimits } from '../../lib/plan/battery/storageLimit';
import {
  decideStorageRelief,
  type StorageRelief,
} from '../../lib/plan/battery/storageRelief';
import { resolveStorageHandBack } from '../../lib/plan/restore/devices';
import type { StorageLeverState } from '../../lib/plan/planState';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { ShedCandidate, StorageShedCandidate } from '../../lib/plan/shedding/types';
import type { ObservedStorageInput } from '../../packages/planner-types/src/planInputDevice';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { STORAGE_RELIEF_SETTLE_WINDOW_MS } from '../../lib/plan/battery/storageLadder';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';
import { buildPlanDevice, buildPlanInputDevice } from '../utils/planTestUtils';

const NOW = 10_000_000;

const battery = (overrides: Partial<ObservedStorageInput> = {}): PlanInputDevice & { storage: ObservedStorageInput } => ({
  ...buildPlanInputDevice({
    id: 'battery',
    name: 'Battery',
    isBatteryOrSolar: true,
    commandAuthority: false,
    binaryControllable: false,
    currentDrawKw: 0,
    priority: 3,
  }),
  storage: {
    reading: 'observed',
    range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false,
    stepW: 5,
    signedPowerW: 0,
    claimHeld: false,
    admissible: true,
    powerLimitControl: true,
    verdict: 'unverified',
    deliveryCeilingW: 2500,
    chargeCeilingW: 2500,
    ...overrides,
  },
});

const lever = (overrides: Partial<StorageLeverState> = {}): StorageLeverState => ({
  setpointW: 0,
  purpose: 'limit',
  increaseDecidedAtMs: NOW - 10 * 60_000,
  creditBaseW: 0,
  lastDecreaseAtMs: NOW - 10 * 60_000,
  chargeRaisedAtMs: NOW - 10 * 60_000,
  lastNeedAtMs: NOW,
  preClaimSignedW: 0,
  ownModeChargeW: 0,
  stepW: 5,
  reading: { kind: 'read' },
  ...overrides,
});

const candidateFor = (
  device: PlanInputDevice & { storage: ObservedStorageInput },
  drawKw: number,
  held?: StorageLeverState,
): StorageShedCandidate => {
  const built = buildStorageCandidate(device, held, drawKw, false, NOW);
  if (typeof built === 'string') throw new Error(`expected a candidate, got ${built}`);
  return built;
};

const heater = (priority: number, kw: number, id = `heater-${priority}`): ShedCandidate => ({
  ...buildPlanInputDevice({ id, name: id, controllable: true, currentDrawKw: kw, priority }),
  kind: 'binary',
  priority,
  effectivePower: kw,
  recentlyRestored: false,
  unconfirmedRelief: false,
});

const CAPACITY = { code: PLAN_REASON_CODES.capacity };

describe('the battery candidate', () => {
  it('prices its whole ladder: its charge, then its discharge, bounded by the draw less half the deadband', () => {
    // Charging 2 kW in a house drawing 6 kW: 2 kW of charge and 2.5 kW of discharge.
    expect(candidateFor(battery({ signedPowerW: 2000 }), 6).effectivePower).toBeCloseTo(4.5);
    // Never into export: a house drawing 1 kW offers 0.9 kW.
    expect(candidateFor(battery(), 1).effectivePower).toBeCloseTo(0.9);
    expect(candidateFor(battery({ deliveryCeilingW: 900 }), 6).effectivePower).toBeCloseTo(0.9);
  });

  it('starts below a hold already decided: credited relief is never offered again', () => {
    // Held at 500 W of charge while it still charges 2 kW: 1.5 kW is pending relief.
    const held = candidateFor(battery({ signedPowerW: 2000 }), 6, lever({ setpointW: 500 }));
    expect(held.baseW).toBe(500);
    expect(held.effectivePower).toBeCloseTo(3);
  });

  it.each([
    ['not admissible (Managed off, simulation, claim lost)', { admissible: false }],
    ['a hand-back deferred', { handBackDeferred: true }],
    ['not responding', { verdict: 'not_responding' as const }],
    ['sign-inverted', { verdict: 'sign_inverted' as const }],
  ])('is not offered while %s', (_label, overrides) => {
    expect(buildStorageCandidate(battery(overrides), undefined, 6, false, NOW))
      .toBe('storage_not_drivable');
  });

  it('offers a re-probing battery without banking its relief', () => {
    expect(candidateFor(battery({ verdict: 'reprobing' }), 6).unconfirmedRelief).toBe(true);
  });

  it('banks nothing once it has not followed its limit within the credit\'s window', () => {
    const chosenAt = (atMs: number) => lever({ setpointW: -1300, lastNeedAtMs: atMs });
    expect(candidateFor(battery({ signedPowerW: 0 }), 6, chosenAt(NOW - 5_000)).unconfirmedRelief).toBe(false);
    expect(candidateFor(battery({ signedPowerW: 0 }), 6, chosenAt(NOW - STORAGE_RELIEF_SETTLE_WINDOW_MS)).unconfirmedRelief)
      .toBe(true);
    expect(candidateFor(battery({ signedPowerW: -1300 }), 6, chosenAt(NOW - STORAGE_RELIEF_SETTLE_WINDOW_MS)).unconfirmedRelief)
      .toBe(false);
  });

  it('is not offered when it could not visibly answer anything', () => {
    expect(buildStorageCandidate(battery(), undefined, 0.2, false, NOW))
      .toBe('storage_nothing_to_release');
  });
});

describe('spending the battery', () => {
  it('caps part of its charge for a deficit its charge covers', () => {
    const spend = resolveStorageSpend(candidateFor(battery({ signedPowerW: 2000 }), 6), 0.8);
    // The 0.8 kW deficit plus half the 200 W deadband: capped at 1.1 kW, no discharge.
    expect(spend).toEqual({ setpointW: 1100, reliefKw: 0.9, chargeReliefKw: 0.9 });
  });

  it('caps its charge and discharges in one decision for a deficit beyond its charge', () => {
    const spend = resolveStorageSpend(candidateFor(battery({ signedPowerW: 1000 }), 6), 2.2);
    expect(spend).toEqual({ setpointW: -1300, reliefKw: 2.3, chargeReliefKw: 1 });
  });

  it('asks at least a step it could visibly answer', () => {
    const spend = resolveStorageSpend(candidateFor(battery({ signedPowerW: -1500 }), 6, lever({ setpointW: -1500 })), 0.01);
    expect(spend?.setpointW).toBe(-1670);
  });

  it('never asks past its ladder', () => {
    expect(resolveStorageSpend(candidateFor(battery(), 6), 10)).toEqual({
      setpointW: -2500, reliefKw: 2.5, chargeReliefKw: 0,
    });
  });
});

describe('the battery in the priority order', () => {
  const charging = (): StorageShedCandidate => candidateFor(battery({ signedPowerW: 2000 }), 6);

  it('last in the list (the default), it is limited first and covers the deficit alone', () => {
    const selection = selectShedDevices([charging(), heater(2, 2), heater(1, 2)], 1.5, CAPACITY, false);

    expect(selection.shedSet.size).toBe(0);
    expect(selection.storageSetpoints.get('battery')).toEqual({ setpointW: 400, banked: true });
    // The stopped charge is banked for pending relief, as a load's relief is.
    expect(selection.creditedKw.get('battery')).toBeCloseTo(1.6);
  });

  it('first in the list, the devices below it are limited first and it discharges only for what they leave', () => {
    const candidates = [heater(5, 1, 'lamp'), heater(4, 2, 'heater'), { ...charging(), priority: 1 }];
    const selection = selectShedDevices(candidates, 4, CAPACITY, false);

    expect([...selection.shedSet]).toEqual(['lamp', 'heater']);
    // 1 kW left: covered by its charge alone.
    expect(selection.storageSetpoints.get('battery')).toEqual({ setpointW: 900, banked: true });
  });

  it('is never in the shed set: the executor never sees a shed for it', () => {
    const selection = selectShedDevices([charging()], 4, CAPACITY, true);
    expect(selection.shedSet.has('battery')).toBe(false);
    expect(selection.shedReasons.has('battery')).toBe(false);
  });

  it('a re-probing battery is still asked, but the next device sheds as without it', () => {
    const reprobing = candidateFor(battery({ signedPowerW: 2000, verdict: 'reprobing' }), 6);
    const selection = selectShedDevices([reprobing, heater(1, 2)], 1.5, CAPACITY, false);

    expect(selection.storageSetpoints.get('battery')).toMatchObject({ banked: false });
    expect([...selection.shedSet]).toEqual(['heater-1']);
    expect(selection.creditedKw.has('battery')).toBe(false);
  });
});

describe('an unconfirmed battery PELS already holds', () => {
  it('is held where it is, unbanked, never asked deeper', () => {
    const held = lever({ setpointW: -1300, lastNeedAtMs: NOW - STORAGE_RELIEF_SETTLE_WINDOW_MS });
    const unanswered = candidateFor(battery({ signedPowerW: 0 }), 6, held);
    const selection = selectShedDevices([unanswered, heater(1, 2)], 1.5, CAPACITY, false);

    expect(selection.storageSetpoints.get('battery')).toEqual({ setpointW: -1300, banked: false });
    expect([...selection.shedSet]).toEqual(['heater-1']);
  });

  it('re-asserts a re-probing battery at its hold, never at a deeper reading', () => {
    const reprobing = candidateFor(battery({ signedPowerW: -1500, verdict: 'reprobing' }), 6, lever({ setpointW: -1300 }));
    const selection = selectShedDevices([reprobing], 1, CAPACITY, false);
    expect(selection.storageSetpoints.get('battery')).toEqual({ setpointW: -1300, banked: false });
  });

  it('opens no credit window and keeps when it was last banked', () => {
    const device = battery({ signedPowerW: 0 });
    const held = lever({ setpointW: -1300, lastNeedAtMs: NOW - 40_000, increaseDecidedAtMs: NOW - 40_000 });
    const relief = applyStorageLimits(
      decideStorageRelief([device], buildMeasuredPower({ drawKw: 6, headroomKw: -2 }), { battery: held },
        { leftoverW: -5000, deviceDemand: 'none' }, NOW),
      [device], new Map([['battery', { setpointW: -1300, banked: false }]]), NOW,
    );
    expect(relief.levers.battery).toMatchObject({ lastNeedAtMs: NOW - 40_000, creditBaseW: 1300 });
    const next = decideStorageRelief(
      [device], buildMeasuredPower({ drawKw: 6, headroomKw: -2 }), relief.levers,
      { leftoverW: -5000, deviceDemand: 'none' }, NOW + 5_000,
    );
    expect(next.shed.netCreditKw).toBe(0);
  });
});

describe('the limit hold and its credit', () => {
  const NO_SURPLUS = { leftoverW: -5000, deviceDemand: 'none' as const };
  const held = (device: PlanInputDevice, levers: Record<string, StorageLeverState> = {}): StorageRelief => (
    decideStorageRelief([device], buildMeasuredPower({ drawKw: 6, headroomKw: -2 }), levers, NO_SURPLUS, NOW)
  );

  it('turns the chosen setpoint into a limit hold, keeping the charge its own mode took', () => {
    const device = battery({ signedPowerW: 1000 });
    const relief = applyStorageLimits(held(device), [device], new Map([['battery', { setpointW: -1300, banked: true }]]), NOW);

    expect(relief.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: -1300, stepW: 5 });
    expect(relief.levers.battery).toMatchObject({
      purpose: 'limit', setpointW: -1300, increaseDecidedAtMs: NOW, creditBaseW: 0, preClaimSignedW: 1000, ownModeChargeW: 1000,
    });
    // Restore may not spend the discharge it now holds.
    expect(relief.withheldKw).toBeCloseTo(1.3);
  });

  it('splits the credit: the stopped charge is pending relief, the discharge is the storage term', () => {
    const device = battery({ signedPowerW: 1000 });
    const limited = applyStorageLimits(held(device), [device], new Map([['battery', { setpointW: -1300, banked: true }]]), NOW);
    // Five seconds on the battery has not moved yet.
    const later = decideStorageRelief(
      [device], buildMeasuredPower({ drawKw: 6, headroomKw: -2.3 }), limited.levers, NO_SURPLUS, NOW + 5_000,
    );
    expect(later.shed.netCreditKw).toBeCloseTo(1.3);

    const latch = { powerW: 6000, decisions: new Map([['battery', [{ decidedAtMs: NOW, creditedKw: 1 }]]]), stepTargets: new Map() };
    const pending = resolvePendingShedRelief(latch, [device], 6000, NOW + 5_000, later.levers);
    expect(pending?.totalKw).toBeCloseTo(1);
    // Together exactly the 2.3 kW it was spent for, never a watt twice.
    expect((pending?.totalKw ?? 0) + later.shed.netCreditKw).toBeCloseTo(2.3);
  });

  it('keeps an earlier discharge\'s window when shedding deepens it while it settles', () => {
    const device = battery({ signedPowerW: -200 });
    const settling = { battery: lever({ setpointW: -1000, increaseDecidedAtMs: NOW - 20_000, creditBaseW: 0 }) };
    const relief = applyStorageLimits(held(device, settling), [device], new Map([['battery', { setpointW: -2000, banked: true }]]), NOW);

    expect(relief.levers.battery).toMatchObject({ increaseDecidedAtMs: NOW - 20_000, creditBaseW: 0 });
  });

  it('credits nothing to pending relief for a battery PELS no longer holds', () => {
    const latch = { powerW: 6000, decisions: new Map([['battery', [{ decidedAtMs: NOW, creditedKw: 1 }]]]), stepTargets: new Map() };
    const pending = resolvePendingShedRelief(latch, [battery({ signedPowerW: 2000 })], 6000, NOW + 5_000, {});
    expect(pending?.totalKw).toBe(0);
    expect(pending?.held.size).toBe(0);
  });

  it('opens no settle window for a hold that only caps the charge', () => {
    const device = battery({ signedPowerW: 2000 });
    const relief = applyStorageLimits(held(device), [device], new Map([['battery', { setpointW: 400, banked: true }]]), NOW);

    expect(relief.levers.battery?.increaseDecidedAtMs).toBe(NOW - STORAGE_RELIEF_SETTLE_WINDOW_MS);
    expect(relief.batteries[0]).toMatchObject({ claim: 'charge_limit', heldBackChargeW: 1600 });
  });
});

describe('the restore hand-back', () => {
  const planBattery = (managed = true) => buildPlanDevice({
    id: 'battery', name: 'Battery', isBatteryOrSolar: true, controllable: managed, managed,
  });

  it('is sized as the charge its own mode takes once handed back', () => {
    expect(resolveStorageHandBack(planBattery(), { battery: lever({ ownModeChargeW: 2000 }) })).toEqual({ needKw: 2 });
  });

  it('sizes a battery not seen charging at the claim on its charge ceiling', () => {
    const idle = battery({ signedPowerW: 0, chargeCeilingW: 2500 });
    const relief = applyStorageLimits(
      decideStorageRelief([idle], buildMeasuredPower({ drawKw: 6, headroomKw: -2 }), {},
        { leftoverW: -5000, deviceDemand: 'none' }, NOW),
      [idle], new Map([['battery', { setpointW: -1300, banked: true }]]), NOW,
    );
    expect(relief.levers.battery?.ownModeChargeW).toBe(2500);
    const charging = battery({ signedPowerW: 1500, chargeCeilingW: 2500 });
    const capped = applyStorageLimits(
      decideStorageRelief([charging], buildMeasuredPower({ drawKw: 6, headroomKw: -1 }), {},
        { leftoverW: -5000, deviceDemand: 'none' }, NOW),
      [charging], new Map([['battery', { setpointW: 400, banked: true }]]), NOW,
    );
    expect(capped.levers.battery?.ownModeChargeW).toBe(1500);
  });

  it('sizes a battery that was discharging in its own mode at the claim at nothing', () => {
    const discharging = battery({ signedPowerW: -2000 });
    const relief = applyStorageLimits(
      decideStorageRelief([discharging], buildMeasuredPower({ drawKw: 6, headroomKw: -1 }), {},
        { leftoverW: -5000, deviceDemand: 'none' }, NOW),
      [discharging], new Map([['battery', { setpointW: -2500, banked: true }]]), NOW,
    );
    expect(relief.levers.battery?.ownModeChargeW).toBe(0);
  });

  it('is offered only for a read limit hold on a managed battery', () => {
    expect(resolveStorageHandBack(planBattery(), { battery: lever({ purpose: 'surplus' }) })).toBeNull();
    expect(resolveStorageHandBack(planBattery(), { battery: lever({ reading: { kind: 'unread', sinceMs: NOW } }) }))
      .toBeNull();
    expect(resolveStorageHandBack(planBattery(), {})).toBeNull();
  });

  it('releases the hold it admitted as restored', () => {
    const device = battery({ signedPowerW: 0, claimHeld: true });
    const relief = decideStorageRelief(
      [device], buildMeasuredPower({ drawKw: 1, headroomKw: 4 }), { battery: lever() },
      { leftoverW: -1000, deviceDemand: 'none' }, NOW,
    );
    const handedBack = applyStorageHandBacks(relief, new Set(['battery']));

    expect(handedBack.decisions.get('battery')).toEqual({ kind: 'release', reason: 'restored' });
    expect(handedBack.levers).toEqual({});
    expect(handedBack.batteries[0]).toMatchObject({ claim: 'none', setpointW: 0 });
  });
});
