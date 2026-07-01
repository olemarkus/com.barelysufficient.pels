import { describe, expect, it } from 'vitest';
import { resolvePauseHold } from '../../lib/plan/shedding/pauseHold';
import type { PlanInputDevice } from '../../lib/plan/planTypes';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';

// Minimal plan-input device; only the fields resolvePauseHold reads are set.
const dev = (over: Partial<PlanInputDevice> & { id: string }): PlanInputDevice => ({
  name: over.id,
  targets: [],
  managed: true,
  controllable: true,
  ...over,
}) as PlanInputDevice;

const STEP_PROFILE: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'max', planningPowerW: 3000 },
  ],
} as unknown as SteppedLoadProfile;

// priority: reserved heater = 1 (top); thermostats lower (higher number).
const PRIORITIES: Record<string, number> = {
  heater: 1, higher: 0, peer: 1, t5: 5, t9: 9, unmanaged: 20,
};
const getPriorityForDevice = (id: string): number => PRIORITIES[id] ?? 100;

const run = (devices: PlanInputDevice[], over: { total: number | null; hardCapKw: number; powerKnown?: boolean }) =>
  resolvePauseHold({
    devices,
    total: over.total,
    powerKnown: over.powerKnown ?? true,
    hardCapKw: over.hardCapKw,
    marginKw: 0.5,
    getPriorityForDevice,
  });

describe('resolvePauseHold', () => {
  it('holds every lower-priority managed device (incl. idle) when the reserved device is inactive and feasible', () => {
    const devices = [
      dev({ id: 'heater', priority: 1, holdLowerPriority: true, measuredPowerKw: 0, expectedPowerKw: 1.19 }),
      dev({ id: 't5', priority: 5, measuredPowerKw: 0.3 }),
      dev({ id: 't9', priority: 9, measuredPowerKw: 0 }), // idle — must still be held
      dev({ id: 'higher', priority: 0, measuredPowerKw: 0.4 }), // higher priority — never held
      dev({ id: 'peer', priority: 1, measuredPowerKw: 0.2 }), // equal priority — never held
      dev({ id: 'unmanaged', priority: 20, managed: false, measuredPowerKw: 0.6 }), // not managed — never held
    ];
    const { holdIds, decisions } = run(devices, { total: 0.8, hardCapKw: 3 });
    expect([...holdIds].sort()).toEqual(['t5', 't9']);
    expect(holdIds.has('heater')).toBe(false);
    expect(holdIds.has('higher')).toBe(false);
    expect(holdIds.has('peer')).toBe(false);
    expect(holdIds.has('unmanaged')).toBe(false);
    expect(decisions[0]).toMatchObject({ deviceId: 'heater', outcome: 'held', heldCount: 2 });
  });

  it('LIFTS the hold when it is mathematically impossible to admit the device even with all lower-priority off', () => {
    // ceiling = 2 - 0.5 = 1.5; otherLoad = 0.8 - 0 - 0.3 = 0.5; 0.5 + 1.19 = 1.69 > 1.5 → infeasible.
    const devices = [
      dev({ id: 'heater', priority: 1, holdLowerPriority: true, measuredPowerKw: 0, expectedPowerKw: 1.19 }),
      dev({ id: 't5', priority: 5, measuredPowerKw: 0.3 }),
    ];
    const { holdIds, decisions } = run(devices, { total: 0.8, hardCapKw: 2 });
    expect(holdIds.size).toBe(0);
    expect(decisions[0]).toMatchObject({ deviceId: 'heater', outcome: 'infeasible' });
  });

  it('RELEASES the hold once the reserved device is genuinely running (drawing at ~its lowest step)', () => {
    const devices = [
      dev({ id: 'heater', priority: 1, holdLowerPriority: true, measuredPowerKw: 1.19, expectedPowerKw: 1.19 }),
      dev({ id: 't5', priority: 5, measuredPowerKw: 0.3 }),
    ];
    const { holdIds, decisions } = run(devices, { total: 2.0, hardCapKw: 3 });
    expect(holdIds.size).toBe(0);
    expect(decisions[0]).toMatchObject({ deviceId: 'heater', outcome: 'released_active' });
  });

  it('does NOT release on a standby/trickle draw below ~its lowest step (keeps holding)', () => {
    // 1.19 kW device metering 0.06 kW standby: threshold = max(0.05, 1.19*0.5)=0.595 → still held.
    const devices = [
      dev({ id: 'heater', priority: 1, holdLowerPriority: true, measuredPowerKw: 0.06, expectedPowerKw: 1.19 }),
      dev({ id: 't5', priority: 5, measuredPowerKw: 0.3 }),
    ];
    const { holdIds, decisions } = run(devices, { total: 1.0, hardCapKw: 5 });
    expect([...holdIds]).toEqual(['t5']);
    expect(decisions[0]).toMatchObject({ outcome: 'held' });
  });

  it('resolves the lowest step from a stepped profile (planningPowerW)', () => {
    const devices = [
      dev({ id: 'heater', priority: 1, holdLowerPriority: true, measuredPowerKw: 0, steppedLoadProfile: STEP_PROFILE }),
      dev({ id: 't5', priority: 5, measuredPowerKw: 0.2 }),
    ];
    // lowest active step = 1.25 kW; ceiling = 3 - 0.5 = 2.5; otherLoad = 0.7 - 0 - 0.2 = 0.5;
    // 0.5 + 1.25 = 1.75 <= 2.5 → feasible → hold t5.
    const { holdIds, decisions } = run(devices, { total: 0.7, hardCapKw: 3 });
    expect([...holdIds]).toEqual(['t5']);
    expect(decisions[0]).toMatchObject({ outcome: 'held', lowestStepKw: 1.25 });
  });

  it('does not hold when total power is unknown/stale or non-finite', () => {
    const devices = [
      dev({ id: 'heater', priority: 1, holdLowerPriority: true, measuredPowerKw: 0, expectedPowerKw: 1.0 }),
      dev({ id: 't5', priority: 5, measuredPowerKw: 0.3 }),
    ];
    // powerKnown=false (stale-but-finite total) → no hold.
    expect(run(devices, { total: 0.8, hardCapKw: 5, powerKnown: false }).holdIds.size).toBe(0);
    // null / NaN total → no hold.
    expect(run(devices, { total: null, hardCapKw: 5 }).holdIds.size).toBe(0);
    expect(run(devices, { total: Number.NaN, hardCapKw: 5 }).holdIds.size).toBe(0);
  });

  it('is a no-op when no device carries the hold flag', () => {
    const devices = [
      dev({ id: 't5', priority: 5, measuredPowerKw: 0.3 }),
      dev({ id: 't9', priority: 9, measuredPowerKw: 0.2 }),
    ];
    const { holdIds, decisions } = run(devices, { total: 1, hardCapKw: 3 });
    expect(holdIds.size).toBe(0);
    expect(decisions).toEqual([]);
  });
});
