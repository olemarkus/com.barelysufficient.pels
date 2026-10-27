import { describe, expect, it } from 'vitest';
import {
  resolveInverterControl, updateInverterObservation, withInverterParseFields,
} from '../../lib/device/transport/solarInverterObservation';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import { partialDouble } from '../helpers/partialDouble';

const NOW = 1_800_000_000_000;
const device: HomeyDeviceLike = {
  id: 'pv', name: 'Inverter', class: 'solarpanel', capabilities: ['measure_power', 'target_power'],
};
const values: DeviceCapabilityMap = {
  measure_power: { value: -5000, lastUpdated: new Date(NOW).toISOString() },
  target_power: { value: 6000, lastUpdated: new Date(NOW).toISOString(),
    setable: true, max: 6000, min: 0, step: 1 },
};

describe('standard Homey inverter control boundary', () => {
  it('accepts an explicit writable solar cap, never a battery or an unbounded target', () => {
    expect(resolveInverterControl(device, values)).toEqual({ maxW: 6000, stepW: 1, mode: 'direct', authority: 'limit_and_release' });
    expect(resolveInverterControl({ ...device, class: 'battery' }, values)).toBeNull();
    expect(resolveInverterControl(device, { ...values, target_power: { value: 6000, setable: true } })).toBeNull();
    expect(resolveInverterControl({ ...device, driverId: 'homey:app:sma.modbus:pv' }, values)).toBeNull();
  });

  it('keeps physical production and the reported cap separate, retaining newer observations', () => {
    const snapshot = partialDouble<TransportDeviceSnapshot>({ id: 'pv' });
    const parsed = withInverterParseFields(snapshot, device, values, undefined);
    expect(parsed.inverterObservation?.production.value).toBe(5000);
    expect(parsed.inverterObservation?.limit.value).toBe(6000);
    const old = { ...values, target_power: { ...values.target_power,
      value: 1000, lastUpdated: new Date(NOW - 1000).toISOString() } };
    expect(withInverterParseFields(snapshot, device, old, parsed).inverterObservation?.limit.value).toBe(6000);
    const missing = { ...values, measure_power: { value: null } };
    expect(withInverterParseFields(snapshot, device, missing, parsed).inverterObservation?.production.value).toBe(5000);
    const unreadableCap = { ...values, target_power: { value: null } };
    const retained = withInverterParseFields(snapshot, device, unreadableCap, parsed);
    expect(retained.inverterControl).toEqual({ ...parsed.inverterControl, authority: 'release_only' });
    expect(withInverterParseFields(snapshot, { ...device, capabilities: ['measure_power'] }, values, parsed)
      .inverterControl).toBeUndefined();
    expect(retained.inverterObservation).toEqual(parsed.inverterObservation);
  });

  it('accepts newer cap telemetry with incomplete metadata while allowing only hand-back', () => {
    const snapshot = partialDouble<TransportDeviceSnapshot>({ id: 'pv' });
    const limited = withInverterParseFields(snapshot, device, { ...values,
      target_power: { ...values.target_power, value: 2050 },
    }, undefined);
    const released = withInverterParseFields(snapshot, device, { ...values,
      target_power: { value: 6000, lastUpdated: new Date(NOW + 1000).toISOString() },
    }, limited);
    expect(released.inverterControl?.authority).toBe('release_only');
    expect(released.inverterObservation?.limit).toEqual({ value: 6000, observedAtMs: NOW + 1000 });
  });

  it('accepts a later pulled owner mode despite realtime receipt-time skew, retaining genuinely older reads', () => {
    const snapshot = partialDouble<TransportDeviceSnapshot>({ id: 'pv' });
    const switchable = { ...device, capabilities: ['measure_power', 'target_power', 'target_power_mode'] };
    const withMode = (value: string, stamp: number) => ({ ...values,
      target_power_mode: { value, lastUpdated: new Date(stamp).toISOString(), setable: true,
        values: [{ id: 'homey' }, { id: 'device' }, { id: 'eco' }] },
    });
    const parsed = withInverterParseFields(snapshot, switchable, withMode('homey', NOW), undefined);
    updateInverterObservation(parsed, 'target_power_mode', 'homey', NOW + 1000);
    const owner = withInverterParseFields(snapshot, switchable, withMode('eco', NOW + 500), parsed);
    expect(owner.inverterObservation?.mode).toEqual({ kind: 'autonomous', value: 'eco', observedAtMs: NOW + 500 });
    expect(withInverterParseFields(snapshot, switchable, withMode('homey', NOW - 10_000), owner)
      .inverterObservation?.mode).toEqual(owner.inverterObservation?.mode);
    expect(withInverterParseFields(snapshot, switchable, withMode('eco', NOW - 10_000), owner)
      .inverterObservation?.mode).toEqual(owner.inverterObservation?.mode);
  });
});
