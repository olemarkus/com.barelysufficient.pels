import { describe, expect, it } from 'vitest';
import {
  buildReservedForStartReason,
  resolveClaimedReserveKw,
  resolveHeadroomReserves,
  resolveReserveAdmission,
} from '../../lib/plan/admission/headroomReserve';
import { HEADROOM_RESERVE_MAX_MS, RESTORE_ADMISSION_FLOOR_KW } from '../../lib/plan/planConstants';
import { resolveRestoreShortfallKw } from '../../packages/shared-domain/src/planReasonSemantics';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import { buildPlanDevice, steppedProfile } from '../utils/planTestUtils';

// A device that has NOT started: binary control off, drawing nothing. Every reserve case starts
// from here, because a confirmed-on device counts as started and is never reserved for.
const waiting = (over: Parameters<typeof buildPlanDevice>[0]): DevicePlanDevice => buildPlanDevice({
  binaryControl: { on: false },
  measuredPowerKw: 0,
  ...over,
});

const NOW = 1_800_000_000_000;

const run = (devices: DevicePlanDevice[], over?: {
  powerKnown?: boolean;
  armed?: Record<string, number>;
  nowTs?: number;
}) => {
  const state = { headroomReserveArmedMs: over?.armed ?? {} };
  const reserves = resolveHeadroomReserves({
    devices,
    powerIsMeasured: over?.powerKnown ?? true,
    state,
    nowTs: over?.nowTs ?? NOW,
  });
  return { reserves, armed: state.headroomReserveArmedMs };
};

describe('resolveHeadroomReserves', () => {
  it('arms a reserve for the device\'s lowest active step and stamps the clock', () => {
    const { reserves, armed } = run([
      waiting({ id: 'heater', priority: 1, reservesStartupPower: true, steppedLoadProfile: steppedProfile }),
    ]);
    expect(reserves).toEqual([{ deviceId: 'heater', deviceName: 'Device', priority: 1, kw: 1.25 }]);
    expect(armed.heater).toBe(NOW);
  });

  it('reserves the LOWEST active step, never the step the device is heading for', () => {
    // `max` is 3 kW; the reservation is only ever the 1.25 kW needed to get onto step 1.
    const { reserves } = run([waiting({
      id: 'heater',
      priority: 1,
      reservesStartupPower: true,
      steppedLoadProfile: steppedProfile,
      desiredStepId: 'max',
      targetStepId: 'max',
    })]);
    expect(reserves[0]?.kw).toBe(1.25);
  });

  it('reserves the CALIBRATED lowest-step draw, not its nameplate', () => {
    // A charger whose "low" step really pulls 1.9 kW against a 1.25 kW nameplate must reserve the
    // real figure, or the block gets nibbled anyway. Same view the admission gate judges against.
    const { reserves } = run([waiting({
      id: 'charger',
      priority: 1,
      reservesStartupPower: true,
      steppedLoadProfile: steppedProfile,
      stepPowerCalibration: { low: { admissionPowerKw: 1.9, deliveryPowerKw: 1.9 } },
    })]);
    expect(reserves[0]?.kw).toBe(1.9);
  });

  it('does not reserve for a device that never asked', () => {
    expect(run([waiting({ id: 'heater', priority: 1 })]).reserves).toEqual([]);
  });

  it('declines to reserve when power is unknown, but keeps the clock running', () => {
    const { reserves, armed } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { powerKnown: false, armed: { heater: NOW - 1000 } },
    );
    expect(reserves).toEqual([]);
    expect(armed.heater).toBe(NOW - 1000);
  });

  // A non-stepped device can no longer fail to produce a startup estimate: the
  // producer resolves `expectedPowerKw` for every device, ending on a default
  // rather than on absence. Only the stepped arm can still decline, and only
  // because a device with no usable step genuinely has nothing to size against.
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
      { deviceClass: 'evcharger', evChargingState: 'plugged_out' },
    ];
    for (const blocked of blockers) {
      const { reserves } = run(
        [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19, ...blocked })],
        { armed: { heater: NOW - 1000 } },
      );
      expect({ blocked, reserves }).toEqual({ blocked, reserves: [] });
    }
  });

  it('does NOT restart the bound when a flaky read blips a device out of startability', () => {
    // A charger on marginal Wi-Fi reporting `available: false` for one poll must not reset the
    // 15-minute clock — the bound is the only protection against a reserve that never resolves,
    // and re-arming on every blip would make it unreachable.
    const armedAt = NOW - 1000;
    const blips: Parameters<typeof buildPlanDevice>[0][] = [
      { available: false },
      { deviceClass: 'evcharger', evChargingState: 'plugged_out' },
      // No power estimate at all this cycle: the `unknown_device_power` stamp-preservation path.
      { expectedPowerKw: undefined},
    ];
    for (const blip of blips) {
      const { armed } = run(
        [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19, ...blip })],
        { armed: { heater: armedAt } },
      );
      expect(armed.heater).toBe(armedAt);
    }
  });

  it('lapses the reserve once it has been held longer than the bound', () => {
    const armedAt = NOW - HEADROOM_RESERVE_MAX_MS - 1;
    const { reserves, armed } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { armed: { heater: armedAt } },
    );
    expect(reserves).toEqual([]);
    // The stamp is KEPT so the lapse sticks instead of re-arming every cycle.
    expect(armed.heater).toBe(armedAt);
  });

  it('still holds the reserve just inside the bound', () => {
    const { reserves } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { armed: { heater: NOW - HEADROOM_RESERVE_MAX_MS } },
    );
    expect(reserves).toHaveLength(1);
  });

  it('prunes the clock of a device that has left the snapshot', () => {
    const { armed } = run(
      [waiting({ id: 'heater', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { armed: { gone: NOW - 1000, heater: NOW - 1000 } },
    );
    expect(armed.gone).toBeUndefined();
    expect(armed.heater).toBe(NOW - 1000);
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
    const { reserves, armed } = run([atSetpoint], { armed: { heater: NOW - 1000 } });
    expect(reserves).toEqual([]);
    // And it stays released a cycle later, when the element has cut out and draw reads zero.
    expect(run([atSetpoint], { armed, nowTs: NOW + 60_000 }).reserves).toEqual([]);
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
      currentState: 'unknown',
      currentTarget: 21,
      currentTemperature: 21,
      expectedPowerKw: 1.0,
      measuredPowerKw,
    });

    // Cycle 1: element running -> released, and the release is latched.
    const started = run([targetOnly(0.8)], { armed: { panel: NOW - 1000 } });
    expect(started.reserves).toEqual([]);

    // Cycle 2: element cut out at setpoint. Draw alone would re-arm; the latch must hold.
    const cycledOff = run([targetOnly(0)], { armed: started.armed, nowTs: NOW + 60_000 });
    expect(cycledOff.reserves).toEqual([]);
  });

  it('releases the moment the reported step confirms step 1, even while the draw is still low', () => {
    // 0.2 kW is well under the half-of-1.25 draw proxy the old pause-hold used, so a draw-only
    // test would keep holding here. Confirmed step evidence releases immediately.
    const { reserves, armed } = run(
      [waiting({
        id: 'charger',
        priority: 1,
        reservesStartupPower: true,
        steppedLoadProfile: steppedProfile,
        reportedStepId: 'low',
        measuredPowerKw: 0.2,
      })],
      { armed: { charger: NOW - 1000 } },
    );
    expect(reserves).toEqual([]);
    // The arming clock is spent, not merely reset: a later cycle cannot re-arm it.
    expect(run([waiting({ id: 'charger', priority: 1, reservesStartupPower: true, expectedPowerKw: 1.19 })],
      { armed, nowTs: NOW + 60_000 }).reserves).toEqual([]);
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
    // `reportedStepId` is evidence. Same rule as isSwapTargetComplete.
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

  it('defaults a missing priority to 100, so an unranked device yields to a ranked one', () => {
    expect(resolveClaimedReserveKw({
      dev: { id: 'x' }, reserves: [reserve('heater', 1, 1.25)],
    })).toBe(1.25);
  });
});

describe('resolveReserveAdmission', () => {
  const admit = (availableHeadroom: number, neededKw: number, reserves: ReturnType<typeof reserve>[]) => (
    resolveReserveAdmission({ dev: { id: 'thermostat', priority: 10 }, availableHeadroom, neededKw, reserves })
  );

  it('admits when there is room even after the reservation', () => {
    expect(admit(4, 0.8, [reserve('heater', 1, 1.25)]).kind).toBe('admitted');
  });

  it('names the reservation as the sole blocker when the raw power would have sufficed', () => {
    // needed 0.8 + 0.25 admission reserve + 0.25 floor = 1.3 required. Raw 1.6 clears it;
    // effective 0.41 does not.
    const result = admit(1.6, 0.8, [reserve('heater', 1, 1.19)]);
    expect(result.kind).toBe('blocked_by_reserve');
    expect(result.reservedKw).toBeCloseTo(1.19, 5);
  });

  it('reports plain insufficiency when the device is short regardless of any reservation', () => {
    expect(admit(0.5, 2.0, [reserve('heater', 1, 1.19)]).kind).toBe('insufficient');
  });

  it('is untouched when nothing outranks the device', () => {
    const result = admit(1.6, 0.8, [reserve('lesser', 20, 1.19)]);
    expect(result.kind).toBe('admitted');
    expect(result.reservedKw).toBe(0);
    expect(result.effectiveHeadroomKw).toBe(1.6);
  });

  it('keeps the subtraction signed when headroom is already negative', () => {
    // Regression: clamping at zero inverted here — `max(0, -2.6 - 1.4)` is 0, GREATER than -2.6,
    // so a reservation made the swap path more permissive than no reservation at all. A large
    // pending restore can push available headroom negative.
    const result = admit(-2.6, 1.5, [reserve('heater', 1, 1.4)]);
    expect(result.effectiveHeadroomKw).toBeCloseTo(-4.0, 5);
    expect(result.reservedKw).toBeCloseTo(1.4, 5);
    expect(result.kind).toBe('insufficient');
  });

  it('preserves the FULL claim when it exceeds available power', () => {
    // Regression: capping `reservedKw` at `availableHeadroom` let a swap free just enough for
    // itself and quietly consume the unaccounted remainder of the promised block — in exactly the
    // tight-power case the reservation exists for. Callers subtract `reservedKw` before handing
    // headroom to the swap, so it must carry the whole claim.
    const result = admit(0.4, 0.5, [reserve('heater', 1, 3.6)]);
    expect(result.reservedKw).toBeCloseTo(3.6, 5);
    expect(result.effectiveHeadroomKw).toBeCloseTo(-3.2, 5);
  });

  it('names the reservation even when the claim exceeds all available power', () => {
    const result = admit(1.6, 0.8, [reserve('heater', 1, 99)]);
    expect(result.kind).toBe('blocked_by_reserve');
  });

  it('still names the reservation when available power is exactly zero', () => {
    // Regression: deciding "did a reserve apply?" by comparing the two headroom figures misread
    // this case — `max(0, 0 - claimed)` equals the raw 0, so the reservation went unnamed and the
    // device fell through to the swap path with a plain shortfall reason.
    const result = resolveReserveAdmission({
      dev: { id: 'thermostat', priority: 10 },
      availableHeadroom: RESTORE_ADMISSION_FLOOR_KW + 0.25,
      neededKw: 0,
      reserves: [reserve('heater', 1, 10)],
    });
    expect(result.kind).toBe('blocked_by_reserve');
  });
});

describe('buildReservedForStartReason', () => {
  // Holder SELECTION now lives on the admission result (`blocked_by_reserve`
  // carries `holderName`), which is the only branch that can guarantee one
  // exists — so the "names nobody" case it used to cover is gone with the
  // nullable `targetName`.
  it('names the most important device holding power ahead of this one', () => {
    const result = resolveReserveAdmission({
      dev: { id: 'thermostat', priority: 10 },
      availableHeadroom: RESTORE_ADMISSION_FLOOR_KW + 0.25,
      neededKw: 0,
      reserves: [reserve('charger', 3, 1.4), reserve('heater', 1, 1.25)],
    });
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
