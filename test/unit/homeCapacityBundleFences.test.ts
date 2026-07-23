// Unit coverage for home-runtime fencing and heartbeat cadence:
// - createFencedActuator: final point-of-use actuator gate. It passes the
//   command device id to the caller so ownership, source-epoch, and teardown
//   changes can decline stale writes without touching the base actuator.
// - freshnessHeartbeatIntervalMs: deterministic per-home jitter so bundles'
//   freshness heartbeats do not fire on one phase-aligned tick.
import { describe, expect, it, vi } from 'vitest';
import { createFencedActuator } from '../../setup/appInit/createPlanEngine';
import { createPreparedBundleSampleFence } from '../../setup/homeRuntime/homeCapacityBundleApi';
import { freshnessHeartbeatIntervalMs } from '../../setup/homeRuntime/homeCapacityBundleReadiness';
import type { Actuator } from '../../lib/actuator/deviceActuator';
import type { ActuatorOutcome, DeviceCommand } from '../../lib/actuator/deviceCommand';
import type { StableSampleRevision } from '../../setup/powerSamplePipeline';

const command: DeviceCommand = { kind: 'target', deviceId: 'd1', value: 21 };

describe('createFencedActuator (point-of-use actuation fence)', () => {
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

  it('passes the command device id to the point-of-use fence', async () => {
    const apply = vi.fn(async (): Promise<ActuatorOutcome> => ({ requested: true }));
    const base: Actuator = { apply };
    const seenDeviceIds: string[] = [];
    const actuator = createFencedActuator(base, (deviceId) => {
      seenDeviceIds.push(deviceId);
      return deviceId === 'moved-device';
    });

    await actuator.apply(command);
    const movedCommand: DeviceCommand = { ...command, deviceId: 'moved-device' };
    const outcome = await actuator.apply(movedCommand);

    expect(seenDeviceIds).toEqual(['d1', 'moved-device']);
    expect(apply).toHaveBeenCalledExactlyOnceWith(command);
    expect(outcome).toEqual({ requested: false });
  });
});

describe('prepared bundle sample fence', () => {
  it('keeps overlapping same-revision handles independent until each owner ends', async () => {
    let sample: StableSampleRevision = { state: 'stable', revision: 7 };
    const fence = createPreparedBundleSampleFence();
    fence.bindReader(() => sample);
    const endFirst = fence.begin(7);
    const endSecond = fence.begin(7);
    const apply = vi.fn(async (): Promise<ActuatorOutcome> => ({ requested: true }));
    const actuator = createFencedActuator({ apply }, () => fence.isSuperseded());

    sample = { state: 'pending' };
    await expect(actuator.apply(command)).resolves.toEqual({ requested: false });
    endFirst();
    expect(fence.isActive()).toBe(true);
    await expect(actuator.apply(command)).resolves.toEqual({ requested: false });

    endSecond();
    expect(fence.isActive()).toBe(false);
    await expect(actuator.apply(command)).resolves.toEqual({ requested: true });
    expect(apply).toHaveBeenCalledExactlyOnceWith(command);
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
