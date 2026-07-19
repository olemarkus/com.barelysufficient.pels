// Unit coverage for the two pure R7b fix-round-2 primitives:
// - `createFencedActuator` (P0#2): the single-method teardown actuation fence
//   — while fenced, EVERY device write no-ops without touching the base actuator,
//   so a torn-down sub-home bundle's in-flight continuation cannot double-control.
// - `freshnessHeartbeatIntervalMs` (P1#4): a deterministic per-home jitter so N
//   bundles' freshness heartbeats do not fire on the same phase-aligned tick.
import { describe, expect, it, vi } from 'vitest';
import { createFencedActuator } from '../../setup/appInit/createPlanEngine';
import { freshnessHeartbeatIntervalMs } from '../../setup/homeRuntime/homeCapacityBundleReadiness';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorOutcome, DeviceCommand } from '../../lib/actuator/deviceCommand';

const command: DeviceCommand = { kind: 'target', deviceId: 'd1', value: 21 };

describe('createFencedActuator (teardown actuation fence — R7b P0#2)', () => {
  it('delegates to the base actuator while not fenced', async () => {
    const apply = vi.fn(async (): Promise<ActuatorOutcome> => ({ requested: true }));
    const base: Actuator = { apply };
    const outcome = await createFencedActuator(base, () => false).apply(command);
    expect(apply).toHaveBeenCalledWith(command);
    expect(outcome).toEqual({ requested: true });
  });

  it('no-ops (requested:false, base untouched) once fenced', async () => {
    const apply = vi.fn(async (): Promise<ActuatorOutcome> => ({ requested: true }));
    const base: Actuator = { apply };
    let fenced = false;
    const actuator = createFencedActuator(base, () => fenced);
    await actuator.apply(command);
    apply.mockClear();

    fenced = true;
    const outcome = await actuator.apply(command);
    expect(apply).not.toHaveBeenCalled();
    expect(outcome).toEqual({ requested: false });
  });
});

describe('freshnessHeartbeatIntervalMs (per-home jitter — R7b P1#4)', () => {
  it('is deterministic per homeId and within [base, base + base/4)', () => {
    // Test base is 5000 ms (NODE_ENV=test); the jitter is a fraction of the base.
    expect(freshnessHeartbeatIntervalMs('h_a')).toBe(freshnessHeartbeatIntervalMs('h_a'));
    expect(freshnessHeartbeatIntervalMs('h_a')).toBeGreaterThanOrEqual(5000);
    expect(freshnessHeartbeatIntervalMs('h_a')).toBeLessThan(5000 + 5000 / 4);
  });

  it('spreads intervals across homeIds so bundles do not all fire on the same tick', () => {
    const intervals = ['h_a', 'h_b', 'h_c', 'annex', 'cabin'].map(freshnessHeartbeatIntervalMs);
    expect(new Set(intervals).size).toBeGreaterThan(1);
  });
});
