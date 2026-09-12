import { describe, expect, it } from 'vitest';
import {
  joinDeviceSurfaces,
  projectDeviceSurfaces,
  readDeviceSurfaces,
} from '../../lib/device/deviceSurfaces';
import type {
  DeviceDescriptorRead,
  ProjectedObservedDeviceState,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';

// The plan input is the join of the two projected surfaces. These pin what the
// join physically carries — the property the carried-key gate on `toPlanDevice`
// stands on — not what the surfaces mean.

const descriptor = (id: string, name = id): DeviceDescriptorRead => ({
  id,
  name,
  deviceClass: 'heater',
  capabilities: ['onoff'],
  expectedPowerKw: 2,
  expectedPowerSource: 'manual',
});

const observed = (id: string): ProjectedObservedDeviceState => ({
  id,
  name: `${id} (observed)`,
  targets: [],
  binaryControl: { on: true },
  available: true,
  measuredPowerKw: 1.5,
});

describe('joinDeviceSurfaces', () => {
  it('carries both surfaces, identity from the descriptor', () => {
    const joined = joinDeviceSurfaces(descriptor('a', 'Heater'), observed('a'));
    expect(joined).toEqual({
      id: 'a',
      name: 'Heater',
      deviceClass: 'heater',
      capabilities: ['onoff'],
      expectedPowerKw: 2,
      expectedPowerSource: 'manual',
      targets: [],
      binaryControl: { on: true },
      available: true,
      measuredPowerKw: 1.5,
    });
  });
});

describe('readDeviceSurfaces', () => {
  it('joins every device in snapshot order, falling back to the snapshot when unrecorded', () => {
    const snapshots = ['a', 'b', 'c'].map((id) => ({
      ...descriptor(id), ...observed(id), binaryCapabilityId: 'onoff',
    } as unknown as TargetDeviceSnapshot));
    const recorded: Record<string, ProjectedObservedDeviceState> = { a: observed('a'), c: observed('c') };
    const surfaces = readDeviceSurfaces(
      { getSnapshot: () => snapshots, getSnapshotByDeviceId: (id) => snapshots.find((s) => s.id === id) },
      (id) => recorded[id],
    );
    // `b` has no observer record: it is NOT dropped — the plan input and the UI
    // list must not lose a tracked device — and its observed half comes from the
    // snapshot, exactly as the boot seed would have filled it.
    expect(surfaces.map((device) => device.id)).toEqual(['a', 'b', 'c']);
    expect(surfaces[1]).toMatchObject({ id: 'b', binaryControl: { on: true }, available: true });
    // The fallback must carry the observed CLUSTERS too, not just the base
    // fields: they live on the probes, and reading them through a narrower type
    // is how a later narrowing of the store would empty them silently.
    expect(surfaces[1]).toMatchObject({ measuredPowerKw: 1.5 });
    // And no transport-internal key reaches the join on any path.
    expect(surfaces.every((device) => !('binaryCapabilityId' in device))).toBe(true);
    // The descriptor half is projected, so a transport-internal key on the
    // snapshot is not on the join for a rest-spread to sweep up.
    expect(surfaces.every((device) => !('binaryCapabilityId' in device))).toBe(true);
  });
});

describe('projectDeviceSurfaces', () => {
  it('bounds an untracked (picker) device the same way as a join', () => {
    const parsed = {
      ...descriptor('p'),
      ...observed('p'),
      binaryCapabilityId: 'onoff',
      flowBackedCapabilityIds: ['onoff'],
    } as unknown as TransportDeviceSnapshot;
    const [surfaces] = projectDeviceSurfaces([parsed]);
    expect(Object.keys(surfaces!).sort()).toEqual([
      'available', 'binaryControl', 'capabilities', 'deviceClass', 'expectedPowerKw',
      'expectedPowerSource', 'id', 'measuredPowerKw', 'name', 'targets',
    ]);
    expect(surfaces).not.toBe(parsed);
    expect(projectDeviceSurfaces([])).toEqual([]);
  });
});
