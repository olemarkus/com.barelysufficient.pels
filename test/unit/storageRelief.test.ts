import {
  STORAGE_DECREASE_MIN_INTERVAL_MS,
  STORAGE_IDLE_RELEASE_MS,
  STORAGE_INPUT_MISSING_RELEASE_MS,
  STORAGE_RELIEF_SETTLE_WINDOW_MS,
  decideStorageRelief,
  releaseStorageOnSilentMeter,
  withoutHeldStorageDischarge,
  type StorageRelief,
} from '../../lib/plan/battery/storageRelief';
import type { StorageLeverState } from '../../lib/plan/planState';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type {
  ObservedStorageInput,
  StoragePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';
import { buildPlanInputDevice } from '../utils/planTestUtils';

const NOW = 10_000_000;

const batteryDevice = (): PlanInputDevice => buildPlanInputDevice({
  id: 'battery',
  name: 'Battery',
  observeOnly: true,
  commandAuthority: false,
  binaryControllable: false,
  currentDrawKw: 0,
});

const battery = (overrides: Partial<ObservedStorageInput> = {}): PlanInputDevice & StoragePlanInputKind => ({
  ...batteryDevice(),
  storage: {
    reading: 'observed',
    stepW: 5,
    signedPowerW: 0,
    claimHeld: false,
    admissible: true,
    verdict: 'unverified',
    deliveryCeilingW: 2500,
    ...overrides,
  },
});

const unreadBattery = (admissible = true): PlanInputDevice & StoragePlanInputKind => ({
  ...batteryDevice(),
  storage: { reading: 'missing', claimHeld: true, admissible },
});

/** A cycle against the binding pace: negative headroom is the deficit, kW. */
const cycle = (
  device: PlanInputDevice,
  headroomKw: number,
  levers: Record<string, StorageLeverState> = {},
  nowTs = NOW,
  drawKw = 5,
): StorageRelief => decideStorageRelief([device], buildMeasuredPower({ drawKw, headroomKw }), levers, nowTs);

const lever = (overrides: Partial<StorageLeverState> = {}): StorageLeverState => ({
  dischargeW: 1500,
  increaseDecidedAtMs: NOW - 10 * 60_000,
  creditBaseW: 0,
  lastDecreaseAtMs: NOW - 10 * 60_000,
  lastNeedAtMs: NOW,
  preClaimSignedW: 0,
  stepW: 5,
  reading: { kind: 'read' },
  ...overrides,
});

describe('storage relief arithmetic', () => {
  it('asks for its own discharge plus the deficit and half the deadband, and credits the undelivered part', () => {
    const relief = cycle(battery({ signedPowerW: -300 }), -1.2);

    expect(relief.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: -1600, stepW: 5 });
    expect(relief.shed).toEqual({ netCreditKw: 1.3, relieving: true, drawMarginKw: 0.1 });
    expect(relief.levers.battery).toMatchObject({ dischargeW: 1600, increaseDecidedAtMs: NOW, preClaimSignedW: -300 });
  });

  it('bounds the setpoint by the delivery ceiling and the house draw less half the deadband', () => {
    expect(cycle(battery(), -4).decisions.get('battery')).toMatchObject({ setpointW: -2500 });
    expect(cycle(battery({ deliveryCeilingW: 900 }), -4).decisions.get('battery')).toMatchObject({ setpointW: -900 });
    // Relief never tips the house into export: a 0.4 kW draw leaves 0.1 kW of it.
    expect(cycle(battery(), -2, {}, NOW, 0.4).decisions.get('battery')).toMatchObject({ setpointW: -300 });
  });

  it('credits only what the battery has not delivered yet, and nothing once the window lapses', () => {
    const settling = cycle(battery({ signedPowerW: -1000 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });
    expect(settling.shed.netCreditKw).toBeCloseTo(0.5);

    const lapsed = cycle(battery({ signedPowerW: -1000 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - STORAGE_RELIEF_SETTLE_WINDOW_MS }),
    });
    expect(lapsed.shed.netCreditKw).toBe(0);
  });

  it('does not renew credit for an increase the battery never delivered', () => {
    const relief = cycle(battery({ signedPowerW: 0 }), -2, { battery: lever({ increaseDecidedAtMs: NOW - 60_000 }) });

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -2100 });
    expect(relief.shed.netCreditKw).toBeCloseTo(0.6);
  });

  it('keeps the window stamp when the ask grows while it is still settling', () => {
    const relief = cycle(battery({ signedPowerW: -200 }), -1.8, {
      battery: lever({ dischargeW: 1000, increaseDecidedAtMs: NOW - 20_000 }),
    });

    expect(relief.levers.battery?.increaseDecidedAtMs).toBe(NOW - 20_000);
    expect(relief.shed.netCreditKw).toBeCloseTo(1.9);
  });

  it('turns a charging battery off to relieve, but never commands a charge', () => {
    const relief = cycle(battery({ signedPowerW: 800 }), -0.5);

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 0 });
    expect(relief.shed.netCreditKw).toBeCloseTo(0.8);
  });

  it('drives a re-probed battery without crediting it', () => {
    const relief = cycle(battery({ verdict: 'reprobing' }), -1);

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -1100 });
    expect(relief.shed.netCreditKw).toBe(0);
  });

  it('makes no raise smaller than the setpoint tolerance', () => {
    const held = { battery: lever() };
    expect(cycle(battery({ signedPowerW: -1500 }), -0.03, held).decisions.get('battery'))
      .toMatchObject({ setpointW: -1500 });
    expect(cycle(battery({ signedPowerW: -1500 }), -0.08, held).decisions.get('battery'))
      .toMatchObject({ setpointW: -1680 });
    // A deficit too small to answer visibly claims nothing.
    expect(cycle(battery(), -0.02).decisions.size).toBe(0);
  });
});

describe('storage relief hysteresis', () => {
  it('holds the setpoint inside the deadband', () => {
    expect(cycle(battery({ signedPowerW: -1500 }), 0.15, { battery: lever() }).decisions.get('battery'))
      .toMatchObject({ setpointW: -1500 });
  });

  it('steps down past the deadband, leaving the deadband as headroom', () => {
    const relief = cycle(battery({ signedPowerW: -1500 }), 0.7, { battery: lever() });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -1000 });
    expect(relief.levers.battery?.lastDecreaseAtMs).toBe(NOW);
  });

  it('steps to 0 W once the discharge needed is under the deadband, so the idle clock runs', () => {
    const relief = cycle(battery({ signedPowerW: -300 }), 0.15, { battery: lever({ dischargeW: 300 }) });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 0 });
  });

  it('paces step-downs but never increases', () => {
    const recent = { battery: lever({ lastDecreaseAtMs: NOW - STORAGE_DECREASE_MIN_INTERVAL_MS + 1_000 }) };
    expect(cycle(battery({ signedPowerW: -1500 }), 0.7, recent).decisions.get('battery'))
      .toMatchObject({ setpointW: -1500 });
    expect(cycle(battery({ signedPowerW: -1500 }), -0.4, recent).decisions.get('battery'))
      .toMatchObject({ setpointW: -2000 });
  });

  it('does not step down while an increase is still settling', () => {
    expect(cycle(battery({ signedPowerW: -1500 }), 0.7, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    }).decisions.get('battery')).toMatchObject({ setpointW: -1500 });
  });
});

describe('storage relief release', () => {
  const idleLever = (preClaimSignedW: number) => ({
    battery: lever({ dischargeW: 0, lastNeedAtMs: NOW - STORAGE_IDLE_RELEASE_MS, preClaimSignedW }),
  });

  it('hands the battery back after the idle window at 0 W', () => {
    const relief = cycle(battery({ claimHeld: true }), 1, idleLever(0));

    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason: 'idle' });
    expect(relief.levers).toEqual({});
  });

  it('keeps a battery stopped from charging while handing it back would recreate the deficit', () => {
    // It charged at 800 W before PELS stopped it; 0.5 kW of headroom has no room for that.
    const holding = cycle(battery({ claimHeld: true }), 0.5, idleLever(800));
    expect(holding.decisions.get('battery')).toMatchObject({ kind: 'setpoint', setpointW: 0 });
    expect(holding.levers.battery?.lastNeedAtMs).toBe(NOW);

    expect(cycle(battery({ claimHeld: true }), 1.2, idleLever(800)).decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'idle' });
  });

  it.each([
    ['not_responding', { verdict: 'not_responding' as const }],
    ['sign_inverted', { verdict: 'sign_inverted' as const }],
    ['not_admissible', { admissible: false }],
  ])('releases a discharging %s battery and counts its discharge as deficit', (reason, overrides) => {
    const relief = cycle(battery({ claimHeld: true, signedPowerW: -1500, ...overrides }), 0.1, { battery: lever() });

    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason });
    expect(relief.shed).toEqual({ netCreditKw: -1.5, relieving: false, drawMarginKw: 0 });
    expect(relief.heldDischargeKw).toBeCloseTo(1.5);
  });

  it('decides nothing for a battery it neither drives nor holds', () => {
    expect(cycle(battery({ verdict: 'not_responding' }), -2).decisions.size).toBe(0);
    expect(cycle(battery(), 1).decisions.size).toBe(0);
  });

  it('hands back every held battery on meter silence', () => {
    const relief = releaseStorageOnSilentMeter([battery({ claimHeld: true })], { battery: lever() });
    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason: 'meter_silent' });
    expect(relief.levers).toEqual({});
  });
});

describe('storage relief without a reading', () => {
  it('keeps the last hold uncredited, then releases it once the reading has been missing too long', () => {
    const kept = cycle(unreadBattery(), -1, { battery: lever({ increaseDecidedAtMs: NOW - 5_000 }) });
    expect(kept.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: -1500, stepW: 5 });
    expect(kept.shed.netCreditKw).toBe(0);
    expect(kept.heldDischargeKw).toBeCloseTo(1.5);
    expect(kept.levers.battery?.reading).toEqual({ kind: 'unread', sinceMs: NOW });

    const released = cycle(unreadBattery(), -1, kept.levers, NOW + STORAGE_INPUT_MISSING_RELEASE_MS);
    expect(released.decisions.get('battery')).toEqual({ kind: 'release', reason: 'input_missing' });
    expect(released.shed.netCreditKw).toBeCloseTo(-1.5);
  });

  it('releases at once when the unread battery is no longer admissible', () => {
    expect(cycle(unreadBattery(false), -1, { battery: lever() }).decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'not_admissible' });
  });

  it('keeps a hold whose battery left the plan, then drops it, saying so', () => {
    const heater = buildPlanInputDevice({ id: 'heater', controllable: true });
    const kept = decideStorageRelief([heater], buildMeasuredPower(), { battery: lever() }, NOW);
    expect(kept.levers.battery).toBeDefined();
    expect(kept.decisions.size).toBe(0);

    const dropped = decideStorageRelief(
      [heater], buildMeasuredPower(), kept.levers, NOW + STORAGE_INPUT_MISSING_RELEASE_MS,
    );
    expect(dropped.levers).toEqual({});
  });
});

describe('storage discharge as restore sees it', () => {
  it('takes the held discharge off every headroom axis and leaves the draw measured', () => {
    const power = buildMeasuredPower({ drawKw: 2, headroomKw: 1, capacityHeadroomKw: 1, budgetHeadroomKw: 0.5 });
    const relief = cycle(battery({ signedPowerW: -1500 }), 1, { battery: lever() });

    expect(withoutHeldStorageDischarge(power, relief)).toEqual({
      ...power, headroomKw: -0.5, capacityHeadroomKw: -0.5, budgetHeadroomKw: -1,
    });
  });
});
