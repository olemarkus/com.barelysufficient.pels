import { describe, expect, it } from 'vitest';
import {
  rankModeDevices,
  resolveModeTargets,
  type ModeTargetDevice,
} from '../../packages/shared-domain/src/modeCatalogResolution';

// `heldSetpointC` is what the CALLER says PELS holds this device at absent a
// stored target — it has already applied the anchor rule, so these specs only
// exercise stored-vs-filled.
const heldAt = (id: string, heldSetpointC: number): ModeTargetDevice => ({ id, heldSetpointC });

const targets = (
  devices: readonly ModeTargetDevice[],
  stored: Record<string, number> = {},
) => resolveModeTargets({ targetCFor: (deviceId) => stored[deviceId], devices });

describe('rankModeDevices', () => {
  it('ranks every device uniquely and gap-free, stored or not', () => {
    const ranks = rankModeDevices(['c', 'a', 'b'], (id) => ({ b: 1 } as Record<string, number>)[id]);

    // The stored rank wins; the rest fall in behind it by deviceId, and no two
    // devices can come back sharing a rank.
    expect(ranks).toEqual({ b: 1, a: 2, c: 3 });
  });

  it('breaks a stored tie deterministically instead of reporting one', () => {
    const stored: Record<string, number> = { z: 4, a: 4 };
    expect(rankModeDevices(['z', 'a'], (id) => stored[id])).toEqual({ a: 1, z: 2 });
  });

  it('ranks a device whose stored entry is not a finite number', () => {
    const stored: Record<string, unknown> = { a: Number.NaN, b: 'first' };
    expect(rankModeDevices(['a', 'b'], (id) => stored[id])).toEqual({ a: 1, b: 2 });
  });
});

describe('resolveModeTargets', () => {
  it('reports the stored target when there is one', () => {
    const resolved = targets([heldAt('heater', 18)], { heater: 21 });

    expect(resolved.targetByDeviceId.heater).toEqual({ kind: 'stored', targetC: 21 });
    expect(resolved.unstoredTargetsByDeviceId).toEqual({});
  });

  it('fills a missing target from the device setpoint and reports it for persisting', () => {
    const resolved = targets([heldAt('heater', 18)]);

    expect(resolved.targetByDeviceId.heater).toEqual({ kind: 'filled', targetC: 18 });
    expect(resolved.unstoredTargetsByDeviceId).toEqual({ heater: 18 });
  });

  it('prefers a stored target over the held setpoint', () => {
    const resolved = targets([heldAt('heater', 21)], { heater: 22 });

    expect(resolved.targetByDeviceId.heater).toEqual({ kind: 'stored', targetC: 22 });
    expect(resolved.unstoredTargetsByDeviceId).toEqual({});
  });

  it('ignores a non-finite stored target and fills instead', () => {
    const resolved = resolveModeTargets({
      targetCFor: () => Number.NaN,
      devices: [heldAt('heater', 18)],
    });

    expect(resolved.targetByDeviceId.heater).toEqual({ kind: 'filled', targetC: 18 });
  });

  it('answers for every device asked about', () => {
    const resolved = targets([heldAt('a', 20), heldAt('b', 21)], { b: 19 });

    expect(Object.keys(resolved.targetByDeviceId).sort()).toEqual(['a', 'b']);
  });
});
