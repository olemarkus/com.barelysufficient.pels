import { buildEnergyDebugPayload } from '../../setup/appDebugCompaction';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const asDevice = (device: Partial<HomeyDeviceLike> & Record<string, unknown>): HomeyDeviceLike => (
  device as HomeyDeviceLike
);

describe('buildEnergyDebugPayload energy containers', () => {
  it('reports a meter whose container declares only its role', () => {
    // The case the dump used to drop entirely: an AMS/HAN meter has no
    // `approximation` and no `W`, only the role declaration — which is exactly
    // what identifies how Homey Energy will classify it.
    const payload = buildEnergyDebugPayload(asDevice({
      id: 'han-1',
      energy: {
        cumulative: true,
        cumulativeImportedCapability: 'meter_power',
        cumulativeExportedCapability: 'meter_power.surplus',
      },
    }));

    expect(payload).not.toBeNull();
    expect(payload?.containers.energy).toEqual({
      cumulative: true,
      cumulativeImportedCapability: 'meter_power',
      cumulativeExportedCapability: 'meter_power.surplus',
    });
    expect(payload?.containers.energyObj).toBeNull();
    expect(payload?.usageOnW).toBeNull();
    expect(payload?.energyW).toBeNull();
    expect(payload?.inferredExpectedW).toBeNull();
  });

  it('reports BOTH containers, so an empty energyObj cannot hide the role on energy', () => {
    // Homey can expose both at once, and the runtime's own role detection reads
    // them independently for exactly this shape (`isHomeBatteryDevice`,
    // lib/device/managerEnergy.ts). Reporting only the first one found would
    // print `{}` here and read as "this device declared nothing" — which is how
    // a mock of it gets built with the wrong role.
    const payload = buildEnergyDebugPayload(asDevice({
      id: 'battery-1',
      energyObj: {},
      energy: { homeBattery: true },
    }));

    expect(payload?.containers.energyObj).toEqual({});
    expect(payload?.containers.energy).toEqual({ homeBattery: true });
  });

  it('reads a container from energyObj alone', () => {
    const payload = buildEnergyDebugPayload(asDevice({
      id: 'battery-2',
      energyObj: { homeBattery: true },
    }));
    expect(payload?.containers.energyObj).toEqual({ homeBattery: true });
    expect(payload?.containers.energy).toBeNull();
  });

  it('keeps resolving the approximation values alongside the containers', () => {
    const payload = buildEnergyDebugPayload(asDevice({
      id: 'socket-1',
      capabilitiesObj: { onoff: { value: true } },
      energy: { W: 42, approximation: { usageOn: 900, usageOff: 100 } },
    }));

    expect(payload?.containers.energy).toEqual({ W: 42 });
    expect(payload?.usageOnW).toBe(900);
    expect(payload?.usageOffW).toBe(100);
    expect(payload?.energyW).toBe(42);
    expect(payload?.inferredExpectedW).toBe(800);
    expect(payload?.inferredSource).toBe('approximation_delta');
  });

  it('copies primitives only, so a nested structure cannot balloon the dump', () => {
    const payload = buildEnergyDebugPayload(asDevice({
      id: 'odd-1',
      energy: {
        cumulative: true,
        batteries: ['AA', 'AA'],
        approximation: { usageOn: 10 },
        missing: null,
      },
    }));
    expect(payload?.containers.energy).toEqual({ cumulative: true, missing: null });
  });

  it('carries a non-finite number as text, so it cannot be read as a declared null', () => {
    // `safeJsonStringify` is `JSON.stringify`, which renders NaN/Infinity as
    // `null` — the same thing a genuinely declared `null` serializes to. In a
    // dump whose whole job is "what did this device declare", those two must
    // not collide, and an omitted key would read as "declared nothing".
    const payload = buildEnergyDebugPayload(asDevice({
      id: 'broken-1',
      energy: {
        W: Number.NaN,
        usageOff: Number.POSITIVE_INFINITY,
        declaredNull: null,
        usageOn: 900,
      },
    }));

    expect(payload?.containers.energy).toEqual({
      W: 'NaN',
      usageOff: 'Infinity',
      declaredNull: null,
      usageOn: 900,
    });
    expect(JSON.parse(JSON.stringify(payload?.containers.energy)).W).toBe('NaN');
  });

  it('returns null only when the device has neither container', () => {
    expect(buildEnergyDebugPayload(asDevice({ id: 'plain-1' }))).toBeNull();
    expect(buildEnergyDebugPayload(asDevice({ id: 'plain-2', energyObj: null }))).toBeNull();
  });

  it('reports an empty container as present rather than absent', () => {
    // `{}` is a real declaration ("this device has an energy object and it says
    // nothing"), which is different from having none — the distinction matters
    // when deciding what a mock of the device must declare.
    const payload = buildEnergyDebugPayload(asDevice({ id: 'empty-1', energy: {} }));
    expect(payload).not.toBeNull();
    expect(payload?.containers.energy).toEqual({});
    expect(payload?.containers.energyObj).toBeNull();
  });
});
