import { describe, expect, it } from 'vitest';
import {
  buildReservedForStartReason,
  type HeadroomReserveClock,
  resolveClaimedReserveKw,
  resolveHeadroomReserves,
  resolveReserveAdmission,
} from '../../lib/plan/admission/headroomReserve';
import { HEADROOM_RESERVE_MAX_MS } from '../../lib/plan/planConstants';
import { buildBasePlanDevice } from '../../lib/plan/planDevicesBase';
import { NO_SHEDDING_OUTCOME } from '../../lib/plan/planState';
import type { SheddingPlan } from '../../lib/plan/shedding/types';
import { resolveRestoreShortfallKw } from '../../packages/shared-domain/src/planReasonSemantics';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice, steppedInputDevice, steppedProfile } from '../utils/planTestUtils';

// A device that has NOT started: binary control off, drawing nothing. Every reserve case starts
// from here, because a confirmed-on device counts as started and is never reserved for.
const waiting = (over: Parameters<typeof buildPlanDevice>[0]): DevicePlanDevice => buildPlanDevice({
  binaryControl: { on: false },
  measuredPowerKw: 0,
  ...over,
});

const NOW = 1_800_000_000_000;

const HOUR = '2027-01-15T08';

/**
 * A reserve already holding in this hour, last ticked ten seconds ago on a cycle that held, unless a
 * case says otherwise.
 */
const holding = (heldMs: number, lastTickMs = NOW - 10_000, heldLastCycle = true): HeadroomReserveClock => (
  { kind: 'holding', heldMs, lastTickMs, heldLastCycle, hourBucketKey: HOUR }
);

/** The clock a cycle at NOW leaves behind. */
const tickedAt = (heldMs: number, heldLastCycle = true): HeadroomReserveClock => (
  { kind: 'holding', heldMs, lastTickMs: NOW, heldLastCycle, hourBucketKey: HOUR }
);

// `restoresRun` stands in for the restore pass's answer to whether any restore lane runs this
// cycle; every case is one where it does unless it says otherwise.
const run = (devices: DevicePlanDevice[], over?: {
  clocks?: Record<string, HeadroomReserveClock>;
  nowTs?: number;
  restoresRun?: boolean;
  hourBucketKey?: string;
}) => {
  const state = { headroomReserveClocks: over?.clocks ?? {} };
  const reserves = resolveHeadroomReserves(
    devices,
    state,
    { nowTs: over?.nowTs ?? NOW, hourBucketKey: over?.hourBucketKey ?? HOUR },
    over?.restoresRun ?? true,
  );
  return { reserves, clocks: state.headroomReserveClocks };
};

describe('resolveHeadroomReserves', () => {
  it('arms a reserve for the device\'s lowest active step and starts its clock', () => {
    const { reserves, clocks } = run([
      waiting({ id: 'heater', priority: 1, reservesStartupPower: true, steppedLoadProfile: steppedProfile }),
    ]);
    expect(reserves).toEqual([{ deviceId: 'heater', deviceName: 'Device', priority: 1, kw: 1.25 }]);
    expect(clocks.heater).toEqual(tickedAt(0));
  });

  it('reserves the LOWEST active step, never the step the device is heading for', () => {
    // `max` is 3 kW; the reservation is only ever the 1.25 kW needed to get onto step 1.
    const { reserves } = run([waiting({
      id: 'heater',
      priority: 1,
      reservesStartupPower: true,
      steppedLoadProfile: steppedProfile,
      desiredStepId: 'max',
    })]);
    expect(reserves[0]?.kw).toBe(1.25);
  });

  it('reserves the lowest step\'s NAMEPLATE, not a lower learned figure its input carries', () => {
    // Production 2026-10-01: a charger's `6a` rung (1.38 kW nameplate) had learned 0.79 kW from
    // trickle samples. The block has to hold what the start needs, and a learned figure is never
    // above nameplate, so reserving it could only let the block get nibbled. Built through the real
    // plan-device producer, because the INPUT is where the learned figure arrives.
    const input = steppedInputDevice({
      id: 'charger',
      priority: 1,
      reservesStartupPower: true,
      steppedLoadProfile: {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: '6a', planningPowerW: 1380 },
          { id: '10a', planningPowerW: 2300 },
        ],
      },
      selectedStepId: 'off',
      binaryControl: { on: false },
      currentState: 'off',
      currentDrawKw: 0,
      targets: [],
      stepPowerCalibration: { '6a': 0.7878, '10a': 1.9 },
    });
    const noShedding: SheddingPlan = {
      shedSet: new Set<string>(),
      shedReasons: new Map(),
      shedStepTargets: new Map(),
      storageSetpoints: new Map(),
      sheddingActive: false,
      guardInShortfall: false,
      outcome: NO_SHEDDING_OUTCOME,
      recoveredAtMs: null,
    };
    const charger = buildBasePlanDevice({
      dev: input,
      recentlyRestored: false,
      binaryCommandPending: false,
      plannedTarget: undefined,
      shedBehavior: { action: 'turn_off' },
      sheddingPlan: noShedding,
      anyOtherDeviceLimited: false,
      boostActive: false,
      surplusHoldShed: false,
      surplusAbsorbActive: false,
      surplusCeilingStepId: undefined,
    });
    expect(run([charger]).reserves.map((reserve) => reserve.kw)).toEqual([1.38]);
  });

  it('does not reserve for a device that never asked', () => {
    expect(run([waiting({ id: 'heater', priority: 1 })]).reserves).toEqual([]);
  });

  it('reserves the producer-resolved expected power when no other estimate exists', () => {
    const { reserves } = run([waiting({ id: 'heater', priority: 1, reservesStartupPower: true })]);
    expect(reserves).toHaveLength(1);
    expect(reserves[0].kw).toBe(1);
  });

  it('withholds the reserve for a device that cannot start', () => {
    const blockers: Parameters<typeof buildPlanDevice>[0][] = [
      { externalOffHoldActive: true },
      { available: false },
      { plannedState: 'shed' },
      { plannedState: 'inactive' },
      // `commandableNow` is producer-derived, so drive it the way the producer does: an unplugged
      // charger is not commandable, and reserving a block for it costs everyone else for nothing.
      { isEvCharger: true, evChargingState: 'plugged_out' },
    ];
    for (const blocked of blockers) {
      const { reserves } = run(
        [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19, ...blocked })],
        { clocks: { heater: holding(1_000) } },
      );
      expect({ blocked, reserves }).toEqual({ blocked, reserves: [] });
    }
  });

  it('does NOT restart the bound when a flaky read blips a device out of startability', () => {
    // A charger on marginal Wi-Fi reporting `available: false` for one poll must not reset the
    // 15-minute clock — the bound is the only protection against a reserve that never resolves,
    // and re-arming on every blip would make it unreachable.
    const clock = holding(5_000);
    const blips: Parameters<typeof buildPlanDevice>[0][] = [
      { available: false },
      { isEvCharger: true, evChargingState: 'plugged_out' },
      // No power estimate at all this cycle: the `unknown_device_power` stamp-preservation path.
      { expectedPowerKw: undefined},
    ];
    for (const blip of blips) {
      const { clocks } = run(
        [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19, ...blip })],
        { clocks: { heater: clock } },
      );
      // Kept, or advanced by a held cycle: never back to nothing held.
      const after = clocks.heater;
      expect(after?.kind === 'holding' && after.heldMs >= 5_000).toBe(true);
    }
  });

  it('lapses the reserve once it has been held longer than the bound', () => {
    const { reserves, clocks } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { clocks: { heater: holding(HEADROOM_RESERVE_MAX_MS - 5_000) } },
    );
    expect(reserves).toEqual([]);
    // The lapse is KEPT for the hour so it sticks instead of re-arming every cycle.
    expect(clocks.heater).toEqual({ kind: 'expired', hourBucketKey: HOUR });
  });

  it('still holds the reserve just inside the bound', () => {
    const { reserves } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { clocks: { heater: holding(HEADROOM_RESERVE_MAX_MS - 10_000) } },
    );
    expect(reserves).toHaveLength(1);
  });

  it('counts no time after a cycle in which no restore lane ran', () => {
    // Shortfall, an overshoot or a cooldown: nothing is restored, so the reserve holds nobody
    // back, and a tight hour full of those cycles must not use up its window.
    const heater = waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 });
    const { reserves, clocks } = run(
      [heater],
      { clocks: { heater: holding(HEADROOM_RESERVE_MAX_MS - 1_000, NOW - 30_000, false) } },
    );
    expect(reserves).toHaveLength(1);
    expect(clocks.heater).toEqual(tickedAt(HEADROOM_RESERVE_MAX_MS - 1_000));
    // And this cycle's own answer governs the time to the next one.
    expect(run([heater], { restoresRun: false }).clocks.heater).toEqual(tickedAt(0, false));
  });

  it('counts the whole gap after a cycle that held, as a slow Flow source holds devices that long', () => {
    // Reported every 5 minutes, the plan made under the reserve kept lower-priority devices off for
    // all of them: the reserve lapses on its window, not after an hour and more of such gaps.
    const { clocks } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { clocks: { heater: holding(0, NOW - 5 * 60_000) } },
    );
    expect(clocks.heater).toEqual(tickedAt(5 * 60_000));
  });

  it('counts at most the meter-silence timeout for one gap', () => {
    // Past ten minutes without a reading the meter counts as stopped and the fail-closed pass
    // takes over, so the reserve held nobody back for the rest of the gap.
    const { clocks } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { clocks: { heater: holding(0, NOW - 20 * 60_000) } },
    );
    expect(clocks.heater).toEqual(tickedAt(10 * 60_000));
  });

  it('starts a clock held in an earlier hour over', () => {
    const { clocks } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { clocks: { heater: holding(14 * 60_000) }, hourBucketKey: '2027-01-15T09' },
    );
    expect(clocks.heater).toEqual({ ...tickedAt(0), hourBucketKey: '2027-01-15T09' });
  });

  it('stays lapsed for the rest of the hour, and arms afresh in a later one', () => {
    const heater = waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 });
    const lapsed: HeadroomReserveClock = { kind: 'expired', hourBucketKey: HOUR };

    expect(run([heater], { clocks: { heater: lapsed } }).reserves).toEqual([]);

    const nextHour = run([heater], { clocks: { heater: lapsed }, hourBucketKey: '2027-01-15T09' });
    expect(nextHour.reserves).toHaveLength(1);
    expect(nextHour.clocks.heater).toEqual({ ...tickedAt(0), hourBucketKey: '2027-01-15T09' });
  });

  it('prunes the clock of a device that has left the snapshot', () => {
    const { clocks } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { clocks: { gone: holding(1_000), heater: holding(1_000) } },
    );
    expect(clocks.gone).toBeUndefined();
    expect(clocks.heater).toEqual(tickedAt(11_000));
  });
});

describe('resolveHeadroomReserves — release, and the step-1 boundary', () => {
  it('treats a confirmed-on device as started, so a duty-cycling load cannot re-arm forever', () => {
    // Regression: releasing purely on instantaneous draw made the bound unreachable. A water
    // heater PELS keeps ON draws its element power (released, clock cleared), then cuts out at
    // setpoint (0 W) — which re-armed a fresh 15-minute window every cycle and withheld its block
    // from every lower-priority device for the whole task.
    const atSetpoint = buildPlanDevice({
      id: 'heater',
      priority: 1,
      reservesStartupPower: true,
      binaryControl: { on: true },
      measuredPowerKw: 0,
      expectedPowerKw: 1.19,
    });
    const { reserves, clocks } = run([atSetpoint], { clocks: { heater: holding(1_000) } });
    expect(reserves).toEqual([]);
    // And it stays released a cycle later, when the element has cut out and draw reads zero.
    expect(run([atSetpoint], { clocks, nowTs: NOW + 60_000 }).reserves).toEqual([]);
  });

  it('stays released once started, so a target-only thermostat cannot re-arm as its element cycles', () => {
    // A thermostat with only `target_temperature` + `measure_power` has no binary handle and no
    // step axis, so instantaneous draw is its ONLY start evidence. Without a latch it alternates
    // between satisfied and waiting every duty cycle, minting a fresh bound each time and holding
    // lower-priority devices out for the whole task window.
    const targetOnly = (measuredPowerKw: number) => buildPlanDevice({
      id: 'panel',
      priority: 1,
      reservesStartupPower: true,
      deviceType: 'temperature',
      binaryCapabilityId: undefined,
      currentState: 'not_applicable',
      currentTarget: 21,
      currentTemperature: 21,
      expectedPowerKw: 1.0,
      measuredPowerKw,
    });

    // Cycle 1: element running -> released, and the release is latched.
    const started = run([targetOnly(0.8)], { clocks: { panel: holding(1_000) } });
    expect(started.reserves).toEqual([]);

    // Cycle 2: element cut out at setpoint. Draw alone would re-arm; the latch must hold.
    const cycledOff = run([targetOnly(0)], { clocks: started.clocks, nowTs: NOW + 60_000 });
    expect(cycledOff.reserves).toEqual([]);
  });

  it('releases the moment the reported step confirms step 1, even while the draw is still low', () => {
    // 0.2 kW is well under the half-of-1.25 draw proxy the old pause-hold used, so a draw-only
    // test would keep holding here. Confirmed step evidence releases immediately.
    const { reserves, clocks } = run(
      [waiting({
        id: 'charger',
        priority: 1,
        reservesStartupPower: true,
        steppedLoadProfile: steppedProfile,
        reportedStepId: 'low',
        measuredPowerKw: 0.2,
      })],
      { clocks: { charger: holding(1_000) } },
    );
    expect(reserves).toEqual([]);
    // The clock is spent, not merely reset: a later cycle cannot re-arm it.
    expect(run([waiting({ id: 'charger', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { clocks, nowTs: NOW + 60_000 }).reserves).toEqual([]);
  });

  it('releases at a step ABOVE step 1 too — nothing is reserved while the device climbs', () => {
    const { reserves } = run([waiting({
      id: 'charger',
      priority: 1,
      reservesStartupPower: true,
      steppedLoadProfile: steppedProfile,
      reportedStepId: 'max',
      measuredPowerKw: 2.9,
    })]);
    expect(reserves).toEqual([]);
  });

  it('keeps holding while the device is still reported at its off step', () => {
    const { reserves } = run([waiting({
      id: 'charger',
      priority: 1,
      reservesStartupPower: true,
      steppedLoadProfile: steppedProfile,
      reportedStepId: 'off',
    })]);
    expect(reserves).toHaveLength(1);
  });

  it('keeps holding when the step is unconfirmed — an unknown position is not a start', () => {
    // `selectedStepId` is the planner-effective position and can be a planning fallback; only
    // `reportedStepId` is evidence. Same rule as `isPromiseKept`.
    const { reserves } = run([waiting({
      id: 'charger',
      priority: 1,
      reservesStartupPower: true,
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
    })]);
    expect(reserves).toHaveLength(1);
  });

  it('falls back to observed draw for a device with no step axis', () => {
    const boiler = (measuredPowerKw: number) => waiting({
      id: 'boiler', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.0, measuredPowerKw,
    });
    expect(run([boiler(0.6)]).reserves).toEqual([]);
    // A standby trickle is not a start.
    expect(run([boiler(0.06)]).reserves).toHaveLength(1);
  });
});

const reserve = (deviceId: string, priority: number, kw: number) => ({
  deviceId, deviceName: deviceId, priority, kw,
});

describe('resolveClaimedReserveKw', () => {
  it('claims only for STRICTLY more important devices', () => {
    const reserves = [reserve('heater', 1, 1.25), reserve('peer', 5, 0.9), reserve('lesser', 20, 0.4)];
    expect(resolveClaimedReserveKw({ dev: { id: 'a', priority: 5 }, reserves })).toBe(1.25);
  });

  it('ignores the device\'s own reserve', () => {
    expect(resolveClaimedReserveKw({
      dev: { id: 'heater', priority: 1 }, reserves: [reserve('heater', 1, 1.25)],
    })).toBe(0);
  });

  it('sums — two devices each waiting for their own block each need it', () => {
    expect(resolveClaimedReserveKw({
      dev: { id: 'x', priority: 10 }, reserves: [reserve('a', 1, 1.25), reserve('b', 2, 1.4)],
    })).toBeCloseTo(2.65, 5);
  });

  it('yields to a reserve held by a higher-ranked device', () => {
    // Every device carries a rank now — the producer ranks the whole planned set
    // before admission runs — so there is no "unranked" case left to default.
    expect(resolveClaimedReserveKw({
      dev: { id: 'x', priority: 9 }, reserves: [reserve('heater', 1, 1.25)],
    })).toBe(1.25);
  });
});

describe('resolveReserveAdmission', () => {
  // A headroom figure always constrains: only a `null` one is `unconstrained` (the case below), so
  // the numeric cases read the constrained variants' figures directly.
  const admit = (availableHeadroom: number, neededKw: number, reserves: ReturnType<typeof reserve>[]) => {
    const result = resolveReserveAdmission({ id: 'thermostat', priority: 10 }, availableHeadroom, neededKw, reserves);
    if (result.kind === 'unconstrained') throw new Error('a numeric headroom resolved unconstrained');
    return result;
  };

  it('is unconstrained when there is no headroom figure, whatever the reservations', () => {
    expect(resolveReserveAdmission(
      { id: 'thermostat', priority: 10 },
      null,
      0.8,
      [reserve('heater', 1, 1.25)],
    )).toEqual({ kind: 'unconstrained' });
  });

  it('admits when there is room even after the reservation', () => {
    expect(admit(4, 0.8, [reserve('heater', 1, 1.25)]).kind).toBe('admitted');
  });

  it('names the reservation as the sole blocker when the raw power would have sufficed', () => {
    // needed 0.8 + 0.25 admission reserve + 0.25 floor = 1.3 required. Raw 1.6 clears it;
    // effective 0.41 does not.
    const result = admit(1.6, 0.8, [reserve('heater', 1, 1.19)]);
    if (result.kind !== 'blocked_by_reserve') throw new Error(`expected blocked_by_reserve, got ${result.kind}`);
    expect(result.reservedKw).toBeCloseTo(1.19, 5);
  });

  it('reports plain insufficiency when the device is short regardless of any reservation', () => {
    expect(admit(0.5, 2.0, [reserve('heater', 1, 1.19)]).kind).toBe('insufficient');
  });

  it('is untouched when nothing outranks the device', () => {
    const result = admit(1.6, 0.8, [reserve('lesser', 20, 1.19)]);
    if (result.kind !== 'admitted') throw new Error(`expected admitted, got ${result.kind}`);
    // Admitted against the raw figure: nothing was taken off it.
    expect(result.effectiveHeadroomKw).toBe(1.6);
  });

  it('keeps the subtraction signed when headroom is already negative', () => {
    // Regression: clamping at zero inverted here — `max(0, -2.6 - 1.4)` is 0, GREATER than -2.6,
    // so a reservation made the swap path more permissive than no reservation at all. A large
    // pending restore can push available headroom negative.
    const result = admit(-2.6, 1.5, [reserve('heater', 1, 1.4)]);
    if (result.kind !== 'insufficient') throw new Error(`expected insufficient, got ${result.kind}`);
    expect(result.availableKw).toBe(-2.6);
    expect(result.reservedKw).toBeCloseTo(1.4, 5);
    // The figure the callers hand the swap path.
    expect(result.availableKw - result.reservedKw).toBeCloseTo(-4.0, 5);
  });

  it('preserves the FULL claim when it exceeds available power', () => {
    // Regression: capping `reservedKw` at `availableHeadroom` let a swap free just enough for
    // itself and quietly consume the unaccounted remainder of the promised block — in exactly the
    // tight-power case the reservation exists for. Callers subtract `reservedKw` before handing
    // headroom to the swap, so it must carry the whole claim.
    const result = admit(0.4, 0.5, [reserve('heater', 1, 3.6)]);
    if (result.kind !== 'insufficient') throw new Error(`expected insufficient, got ${result.kind}`);
    expect(result.reservedKw).toBeCloseTo(3.6, 5);
    expect(result.availableKw - result.reservedKw).toBeCloseTo(-3.2, 5);
  });

  it('names the reservation even when the claim exceeds all available power', () => {
    const result = admit(1.6, 0.8, [reserve('heater', 1, 99)]);
    expect(result.kind).toBe('blocked_by_reserve');
  });

  it('still names the reservation when available power is exactly zero', () => {
    // Regression: deciding "did a reserve apply?" by comparing the two headroom figures misread
    // this case — `max(0, 0 - claimed)` equals the raw 0, so the reservation went unnamed and the
    // device fell through to the swap path with a plain shortfall reason.
    const result = resolveReserveAdmission(
      { id: 'thermostat', priority: 10 },
      0.5,
      0,
      [reserve('heater', 1, 10)],
    );
    expect(result.kind).toBe('blocked_by_reserve');
  });
});

describe('buildReservedForStartReason', () => {
  // Holder SELECTION now lives on the admission result (`blocked_by_reserve`
  // carries `holderName`), which is the only branch that can guarantee one
  // exists — so the "names nobody" case it used to cover is gone with the
  // nullable `targetName`.
  it('names the most important device holding power ahead of this one', () => {
    const result = resolveReserveAdmission(
      { id: 'thermostat', priority: 10 },
      0.5,
      0,
      [reserve('charger', 3, 1.4), reserve('heater', 1, 1.25)],
    );
    expect(result.kind).toBe('blocked_by_reserve');
    const holderName = result.kind === 'blocked_by_reserve' ? result.holderName : null;
    expect(buildReservedForStartReason(holderName ?? ''))
      .toEqual({ code: PLAN_REASON_CODES.reservedForStart, targetName: 'heater' });
  });

  // Carries the holder's name and NOTHING numeric, on purpose. A gap that would
  // admit this device through the reservation is dominated by the holder's
  // reserved block, so surfacing one states another device's quantity as this
  // one's — the error the swap reasons avoid the same way.
  it('carries no kW figure, so the card cannot state another device’s reserve as this one’s need', () => {
    const reason = buildReservedForStartReason('thermostat');
    expect(Object.keys(reason).sort()).toEqual(['code', 'targetName']);
    expect(resolveRestoreShortfallKw(reason)).toBeNull();
  });
});
