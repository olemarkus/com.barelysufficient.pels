import {
  STORAGE_DECREASE_MIN_INTERVAL_MS,
  STORAGE_INPUT_MISSING_RELEASE_MS,
  STORAGE_SURPLUS_RELEASE_DWELL_MS,
  decideStorageRelief,
  releaseStorageOnSilentMeter,
  sumStorageSurplusW,
  withoutStorageWithheld,
  attachStorageDecisions,
  type StorageRelief,
} from '../../lib/plan/battery/storageRelief';
import type { SurplusDemand, SurplusLeftover } from '../../lib/plan/planSurplusAbsorb';
import { SURPLUS_TRACK_STEP_MIN_INTERVAL_MS } from '../../lib/plan/admission';
import type { StorageLeverState } from '../../lib/plan/planState';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type {
  ObservedStorageInput,
  StoragePlanInputKind,
} from '../../packages/planner-types/src/planInputDevice';
import { STORAGE_RELIEF_SETTLE_WINDOW_MS } from '../../lib/plan/battery/storageLadder';
import { buildMeasuredPower } from '../utils/planContextPowerFixture';
import { buildPlanDevice, buildPlanInputDevice } from '../utils/planTestUtils';

const NOW = 10_000_000;

const batteryDevice = (): PlanInputDevice => buildPlanInputDevice({
  id: 'battery',
  name: 'Battery',
  isBatteryOrSolar: true,
  commandAuthority: false,
  binaryControllable: false,
  currentDrawKw: 0,
});

const battery = (overrides: Partial<ObservedStorageInput> = {}): PlanInputDevice & StoragePlanInputKind => ({
  ...batteryDevice(),
  storage: {
    reading: 'observed',
    range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    handBackDeferred: false,
    stepW: 5,
    signedPowerW: 0,
    claimHeld: false,
    admissible: true,
    verdict: 'unverified',
    deliveryCeilingW: 2500,
    chargeCeilingW: 2500,
    powerLimitControl: true,
    ...overrides,
  },
});

const unreadBattery = (admissible = true): PlanInputDevice & StoragePlanInputKind => ({
  ...batteryDevice(),
  storage: { reading: 'missing', handBackDeferred: false, claimHeld: true, admissible },
});

/** No willing device, and the house importing: nothing to store. */
const NO_SURPLUS: SurplusLeftover = { leftoverW: -5000, deviceDemand: 'none' };

/** A cycle against the binding pace: negative headroom is the deficit, kW. */
const cycle = (
  device: PlanInputDevice,
  headroomKw: number,
  levers: Record<string, StorageLeverState> = {},
  nowTs = NOW,
  drawKw = 5,
  surplus: SurplusLeftover = NO_SURPLUS,
): StorageRelief => decideStorageRelief([device], buildMeasuredPower({ drawKw, headroomKw }), levers, surplus, nowTs);

/** A cycle in an exporting house with this much leftover surplus, W, after the willing devices. */
const exporting = (
  device: PlanInputDevice,
  leftoverW: number,
  levers: Record<string, StorageLeverState> = {},
  nowTs = NOW,
  deviceDemand: SurplusDemand = 'waiting',
): StorageRelief => cycle(device, 8, levers, nowTs, -1.5, { leftoverW, deviceDemand });

const lever = (overrides: Partial<StorageLeverState> = {}): StorageLeverState => ({
  setpointW: -1500,
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

describe('the storage stage before shedding', () => {
  it('never limits a battery for a deficit: that is shedding\'s choice, at its place in the order', () => {
    const relief = cycle(battery({ signedPowerW: 800 }), -1.2, {}, NOW, 5, { leftoverW: 2000, deviceDemand: 'waiting' });

    expect(relief.decisions.size).toBe(0);
    expect(relief.levers).toEqual({});
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
  });

  it('keeps a limit hold where shedding put it on a deficit, and raises nothing', () => {
    const relief = cycle(battery({ signedPowerW: -1500 }), -0.8, { battery: lever() });

    expect(relief.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: -1500, stepW: 5 });
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: true, drawMarginKw: 0.1 });
  });

  it('credits only the discharge the battery has not delivered yet, and nothing once the window lapses', () => {
    const settling = cycle(battery({ signedPowerW: -1000 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });
    expect(settling.shed.netCreditKw).toBeCloseTo(0.5);

    const lapsed = cycle(battery({ signedPowerW: -1000 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - STORAGE_RELIEF_SETTLE_WINDOW_MS }),
    });
    expect(lapsed.shed.netCreditKw).toBe(0);
  });

  it('credits above what was already accounted for, never a charge it has not stopped yet', () => {
    // Asked for 1.5 kW of discharge while it still charged 800 W: the stopped
    // charge is pending relief's, so only the discharge is this term's.
    const charging = cycle(battery({ signedPowerW: 800 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });
    expect(charging.shed.netCreditKw).toBeCloseTo(1.5);

    const raised = cycle(battery({ signedPowerW: -200 }), -0.2, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000, creditBaseW: 1000 }),
    });
    expect(raised.shed.netCreditKw).toBeCloseTo(0.5);
  });

  it('credits nothing for a capped charge: its fall is pending relief\'s', () => {
    const relief = cycle(battery({ signedPowerW: 2000 }), -0.2, {
      battery: lever({ setpointW: 500, increaseDecidedAtMs: NOW - 5_000 }),
    });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 500 });
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'charge_limit' });
  });

  it('credits nothing for a re-probing battery', () => {
    const relief = cycle(battery({ verdict: 'reprobing' }), -1, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    });

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -1500 });
    expect(relief.shed.netCreditKw).toBe(0);
  });
});

describe('how the overview names a battery PELS does not hold', () => {
  const holdOf = (relief: StorageRelief) => attachStorageDecisions([
    buildPlanDevice({ id: 'battery', name: 'Battery', isBatteryOrSolar: true }),
  ], relief)[0]?.storageHold;

  it('names one with Power-limit control off as storing spare solar only', () => {
    expect(holdOf(cycle(battery({ powerLimitControl: false, claimHeld: true }), 1))).toEqual({ kind: 'solar_only' });
  });

  it('names one with Power-limit control on as waiting for the limit or solar', () => {
    expect(holdOf(cycle(battery({ claimHeld: true }), 1))).toEqual({ kind: 'none' });
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

  it('steps to 0 W once the discharge needed is under the deadband, the charge still stopped', () => {
    const relief = cycle(battery({ signedPowerW: -300 }), 0.15, { battery: lever({ setpointW: -300 }) });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 0 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'charge_limit' });
  });

  it('paces step-downs', () => {
    const recent = { battery: lever({ lastDecreaseAtMs: NOW - STORAGE_DECREASE_MIN_INTERVAL_MS + 1_000 }) };
    expect(cycle(battery({ signedPowerW: -1500 }), 0.7, recent).decisions.get('battery'))
      .toMatchObject({ setpointW: -1500 });
  });

  it('does not step down while an increase is still settling', () => {
    expect(cycle(battery({ signedPowerW: -1500 }), 0.7, {
      battery: lever({ increaseDecidedAtMs: NOW - 5_000 }),
    }).decisions.get('battery')).toMatchObject({ setpointW: -1500 });
  });
});

describe('storage relief release', () => {
  it('keeps a limit hold at 0 W however long: only the restore lane hands it back', () => {
    const held = { battery: lever({ setpointW: 0, lastNeedAtMs: NOW - 60 * 60_000, preClaimSignedW: 800 }) };
    const relief = cycle(battery({ claimHeld: true }), 5, held);

    expect(relief.decisions.get('battery')).toMatchObject({ kind: 'setpoint', setpointW: 0 });
    expect(relief.levers.battery?.purpose).toBe('limit');
  });

  it('hands a limit hold back at once when the owner turns Power-limit control off', () => {
    const relief = cycle(battery({ claimHeld: true, signedPowerW: -1500, powerLimitControl: false }), 0.1, {
      battery: lever(),
    });

    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason: 'limit_off' });
    expect(relief.levers).toEqual({});
    expect(relief.shed.netCreditKw).toBeCloseTo(-1.5);
  });

  it.each([
    ['not_responding', { verdict: 'not_responding' as const }],
    ['sign_inverted', { verdict: 'sign_inverted' as const }],
    ['not_admissible', { admissible: false }],
  ])('releases a discharging %s battery and counts its discharge as deficit', (reason, overrides) => {
    const relief = cycle(battery({ claimHeld: true, signedPowerW: -1500, ...overrides }), 0.1, { battery: lever() });

    expect(relief.decisions.get('battery')).toEqual({ kind: 'release', reason });
    expect(relief.shed).toEqual({ netCreditKw: -1.5, relieving: false, drawMarginKw: 0 });
    expect(relief.withheldKw).toBeCloseTo(1.5);
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
    expect(kept.withheldKw).toBeCloseTo(1.5);
    expect(kept.levers.battery?.reading).toEqual({ kind: 'unread', sinceMs: NOW });

    const released = cycle(unreadBattery(), -1, kept.levers, NOW + STORAGE_INPUT_MISSING_RELEASE_MS);
    expect(released.decisions.get('battery')).toEqual({ kind: 'release', reason: 'input_missing' });
    expect(released.shed.netCreditKw).toBeCloseTo(-1.5);
  });

  it('releases at once when the unread battery is no longer admissible', () => {
    expect(cycle(unreadBattery(false), -1, { battery: lever() }).decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'not_admissible' });
  });

  it('hands back a hold whose battery left the plan after the missing-input window', () => {
    const heater = buildPlanInputDevice({ id: 'heater', controllable: true });
    const kept = decideStorageRelief([heater], buildMeasuredPower(), { battery: lever() }, NO_SURPLUS, NOW);
    expect(kept.levers.battery).toBeDefined();
    expect(kept.decisions.size).toBe(0);

    const dropped = decideStorageRelief(
      [heater], buildMeasuredPower(), kept.levers, NO_SURPLUS, NOW + STORAGE_INPUT_MISSING_RELEASE_MS,
    );
    expect(dropped.levers).toEqual({});
    expect(dropped.decisions.get('battery')).toEqual({ kind: 'release', reason: 'not_admissible' });
  });

  it('withholds deferred discharge from restores without adding it to the shed deficit', () => {
    const relief = cycle(battery({
      claimHeld: true, signedPowerW: -1500, admissible: false, handBackDeferred: true,
    }), 0.5, { battery: lever() });
    expect(relief.shed.netCreditKw).toBe(0);
    expect(relief.withheldKw).toBe(1.5);
  });

  it('never funds charge inside the battery exclusion band', () => {
    const range = { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: -1000, excludeMaxW: 1000 };
    const charge = exporting(battery({ range, signedPowerW: 2000 }), 700);
    expect(charge.decisions.get('battery')).toMatchObject({ setpointW: 0 });
  });

  it.each([-1, 0.5])('keeps a learned off-grid ceiling writable with %s kW headroom', (headroomKw) => {
    const range = { minW: -2500, maxW: 2500, stepW: 500, excludeMinW: 0, excludeMaxW: 0 };
    const relief = cycle(battery({
      range, stepW: 500, signedPowerW: -2000, claimHeld: true, deliveryCeilingW: 1900,
    }), headroomKw, { battery: lever({ setpointW: -2000, stepW: 500 }) });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: -1500 });
  });
});

describe('storage charge for the devices', () => {
  /** A battery PELS took from its own mode's 2 kW charge and holds at 400 W for a device. */
  const capped = (overrides: Partial<StorageLeverState> = {}): Record<string, StorageLeverState> => ({
    battery: lever({ setpointW: 400, purpose: 'surplus', preClaimSignedW: 2000, ...overrides }),
  });
  const following = (signedPowerW = 400): PlanInputDevice => battery({ signedPowerW, claimHeld: true });

  it('caps the charge its own mode takes to what a device waiting to start leaves', () => {
    // Its own mode stores 2 kW, of which a waiting device needs 1.5 kW.
    const relief = exporting(battery({ signedPowerW: 2000 }), 500);

    expect(relief.decisions.get('battery')).toEqual({ kind: 'setpoint', setpointW: 400, stepW: 5 });
    expect(relief.levers.battery).toMatchObject({ purpose: 'surplus', preClaimSignedW: 2000 });
    expect(relief.batteries[0]).toMatchObject({ claim: 'cap_for_device', setpointW: 400 });
    expect(relief.shed).toEqual({ netCreditKw: 0, relieving: false, drawMarginKw: 0 });
  });

  it('never claims to store more than its own mode does, or for a device already running', () => {
    expect(exporting(battery({ signedPowerW: 1000 }), 1500).decisions.size).toBe(0);
    expect(exporting(battery({ signedPowerW: 2000 }), 500, {}, NOW, 'running').decisions.size).toBe(0);
    expect(exporting(battery({ signedPowerW: 2000 }), 500, {}, NOW, 'none').decisions.size).toBe(0);
  });

  it('never claims a discharging battery, a full one, or one charging from the grid', () => {
    expect(exporting(battery({ signedPowerW: -500 }), 500).decisions.size).toBe(0);
    expect(exporting(battery({ signedPowerW: 2000, chargeCeilingW: 0 }), 500).decisions.size).toBe(0);
    // The house imports more than it charges: none of it is solar.
    const grid = cycle(battery({ signedPowerW: 2000 }), 3, {}, NOW, 3, { leftoverW: -3000, deviceDemand: 'waiting' });
    expect(grid.decisions.size).toBe(0);
  });

  it('keeps a capped charge steady while the device runs on the rest, and counts it needed', () => {
    const relief = exporting(following(), 500, capped({ lastNeedAtMs: NOW - 60_000 }), NOW, 'running');

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 400 });
    expect(relief.levers.battery?.lastNeedAtMs).toBe(NOW);
  });

  it('paces a rise like a surplus climb, and withholds the increase from restore', () => {
    const recent = capped({ chargeRaisedAtMs: NOW - 60_000 });
    expect(exporting(following(), 2500, recent, NOW, 'running').decisions.get('battery'))
      .toMatchObject({ setpointW: 400 });

    const due = exporting(following(), 2500, capped({ chargeRaisedAtMs: NOW - SURPLUS_TRACK_STEP_MIN_INTERVAL_MS }), NOW, 'running');
    expect(due.decisions.get('battery')).toMatchObject({ setpointW: 2400 });
    expect(due.levers.battery?.chargeRaisedAtMs).toBe(NOW);
    expect(due.batteries[0]).toMatchObject({ claim: 'raise_charge' });
    // 2 kW more charge than the battery takes now: restore may not spend it.
    expect(due.withheldKw).toBeCloseTo(2);
  });

  it('falls at once when a device takes its share, but not inside the margin it leaves', () => {
    const held = following(1400);
    const justRaised = capped({ setpointW: 1400, chargeRaisedAtMs: NOW });
    expect(exporting(held, 1200, justRaised).decisions.get('battery')).toMatchObject({ setpointW: 1100 });
    expect(exporting(held, 1450, justRaised).decisions.get('battery')).toMatchObject({ setpointW: 1400 });
    expect(exporting(held, 150, justRaised).decisions.get('battery')).toMatchObject({ setpointW: 0 });
  });

  it('keeps a held charge where it is on a deficit, for shedding to decide in priority order', () => {
    const relief = cycle(following(1400), -0.5, capped({ setpointW: 1400 }), NOW, 3, {
      leftoverW: 1500, deviceDemand: 'waiting',
    });

    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 1400 });
    expect(relief.shed.netCreditKw).toBe(0);
    expect(relief.levers.battery?.purpose).toBe('surplus');
  });

  it('drops a charge raised past its own mode\'s at once on a deficit, and keeps a cap below it', () => {
    const raised = capped({ setpointW: 2400 });
    const relief = cycle(following(2400), -0.5, raised, NOW, 3, { leftoverW: 1500, deviceDemand: 'running' });
    expect(relief.decisions.get('battery')).toMatchObject({ setpointW: 2000 });

    const cap = cycle(following(400), -0.5, capped(), NOW, 3, { leftoverW: 1500, deviceDemand: 'waiting' });
    expect(cap.decisions.get('battery')).toMatchObject({ setpointW: 400 });
  });

  it('hands a full battery\'s surplus hold back on a deficit too', () => {
    const full = battery({ signedPowerW: 0, claimHeld: true, chargeCeilingW: 0 });
    expect(cycle(full, -0.5, capped(), NOW, 3).decisions.get('battery')).toEqual({ kind: 'release', reason: 'full' });
  });

  it('hands a surplus hold back after a short dwell once no device needs the cap', () => {
    const quiet = capped({ lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS + 10_000 });
    expect(exporting(following(), 500, quiet, NOW, 'none').decisions.get('battery')).toMatchObject({ setpointW: 400 });

    const dwelt = capped({ lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS });
    expect(exporting(following(), 500, dwelt, NOW, 'none').decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'surplus_dwell' });
    // A charge raised past its own mode's does no device any good: not needed either.
    const raised = capped({ setpointW: 2400, lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS });
    expect(exporting(following(2400), 2500, raised, NOW, 'running').decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'surplus_dwell' });
    // A limit hold answers to the restore lane, never to the dwell.
    const limit = { battery: lever({ setpointW: 0, lastNeedAtMs: NOW - STORAGE_SURPLUS_RELEASE_DWELL_MS }) };
    expect(exporting(battery({ claimHeld: true }), 0, limit, NOW, 'none').decisions.get('battery'))
      .toMatchObject({ kind: 'setpoint', setpointW: 0 });
  });

  it('hands a surplus hold back at once when the battery stops taking charge', () => {
    const full = battery({ signedPowerW: 0, claimHeld: true, chargeCeilingW: 0 });
    expect(exporting(full, 500, capped(), NOW, 'running').decisions.get('battery'))
      .toEqual({ kind: 'release', reason: 'full' });
  });
});

describe('the batteries\' term in the surplus pool', () => {
  it('counts what PELS charges a held battery with, up to what it asked', () => {
    expect(sumStorageSurplusW([battery({ signedPowerW: 1200 })], { battery: lever({ setpointW: 1500 }) }, 0)).toBe(1200);
    expect(sumStorageSurplusW([battery({ signedPowerW: 1800 })], { battery: lever({ setpointW: 1500 }) }, 0)).toBe(1500);
  });

  it('counts the solar a claimable battery stores in its own mode, less any import, smoothly', () => {
    const own = [battery({ signedPowerW: 2000 })];
    expect(sumStorageSurplusW(own, {}, 0)).toBe(2000);
    expect(sumStorageSurplusW(own, {}, 300)).toBe(1700);
    expect(sumStorageSurplusW(own, {}, 350)).toBe(1650);
    expect(sumStorageSurplusW(own, {}, 400)).toBe(1600);
    // Charging from the grid: none of it is surplus.
    expect(sumStorageSurplusW(own, {}, 2500)).toBe(0);
    // One PELS may not claim frees nothing.
    expect(sumStorageSurplusW([battery({ signedPowerW: 2000, admissible: false })], {}, 0)).toBe(0);
  });

  it('takes every battery\'s own discharge out of the export', () => {
    expect(sumStorageSurplusW([battery({ signedPowerW: -5000 })], {}, -5000)).toBe(-5000);
    // A held discharge stepping down offers the devices none of it either.
    expect(sumStorageSurplusW([battery({ signedPowerW: -800 })], { battery: lever() }, -800)).toBe(-800);
    expect(sumStorageSurplusW([battery({ signedPowerW: -800, admissible: false })], {}, -800)).toBe(-800);
  });
});

describe('storage discharge as restore sees it', () => {
  it('takes the held discharge off every headroom axis and leaves the draw measured', () => {
    const power = buildMeasuredPower({ drawKw: 2, headroomKw: 1, capacityHeadroomKw: 1, budgetHeadroomKw: 0.5 });
    const relief = cycle(battery({ signedPowerW: -1500 }), 1, { battery: lever() });

    expect(withoutStorageWithheld(power, relief)).toEqual({
      ...power, headroomKw: -0.5, capacityHeadroomKw: -0.5, budgetHeadroomKw: -1,
    });
  });
});
