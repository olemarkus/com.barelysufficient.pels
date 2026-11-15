import { describe, expect, it } from 'vitest';
import { getCapabilityAdapter, getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import type { AdapterSnapshot } from '../../lib/device/deviceAdapter';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { partialDouble } from '../helpers/partialDouble';

const AT = '2026-11-15T10:00:00.000Z';
type Status = Readonly<Record<string, string | boolean>>;

/** The 1.3.4 app: custom `charging`, Homey class `other`, no standard EV capabilities. */
const v134 = ['measure_power', 'measure_power.alwayson', 'cable_connected', 'charging', 'charging_mode'];
/** The 1.4.x app: `charging` removed, its own standard EV capabilities, class `evcharger`, LED `dim`. */
const v14 = ['measure_power', 'cable_connected', 'charging_mode', 'evcharger_charging', 'evcharger_charging_state',
  'dim'];

const charger = (capabilities: readonly string[], status: Status): HomeyDeviceLike => ({
  ...HOMEY_DEVICE_FIELDS, id: 'smappee', name: 'EV Wall', class: capabilities.includes('charging') ? 'other' : 'evcharger',
  driverId: 'homey:app:com.smappee:ev-wall', capabilities: [...capabilities],
  capabilitiesObj: Object.fromEntries(Object.entries(status).map(([id, value]) => [id, {
    value, lastUpdated: AT, setable: id === 'charging_mode' || id === 'evcharger_charging' || id === 'dim',
  }])),
});

/** A full read as the parse sees it: the observation, then the overlay on what it returned. */
const read = (device: HomeyDeviceLike) => {
  const adapter = getDeviceAdapter(device);
  const observed = adapter.observation(device);
  return adapter.overlay(device, device.capabilities, observed);
};
const plugState = (device: HomeyDeviceLike) => read(device).capabilityObj.evcharger_charging_state?.value;
const switchOn = (device: HomeyDeviceLike) => read(device).capabilityObj.evcharger_charging?.value;

/** The connector reading under each app generation's own name. */
const generations = [
  { app: '1.3.4', capabilities: v134, connector: (on: boolean): Status => ({ charging: on }) },
  { app: '1.4.x', capabilities: v14, connector: (on: boolean): Status => ({
    evcharger_charging: on, evcharger_charging_state: on ? 'plugged_in_charging' : 'plugged_in',
  }) },
] as const;

describe.each(generations)('Smappee EV Wall on app $app', ({ capabilities, connector }) => {
  const at = (mode: string, cable: boolean, charging: boolean) => charger(capabilities, {
    charging_mode: mode, cable_connected: cable, ...connector(charging),
  });

  it('derives the plug state from the cable, the connector and the mode', () => {
    expect(plugState(at('normal', false, false))).toBe('plugged_out');
    expect(plugState(at('normal', true, true))).toBe('plugged_in_charging');
    expect(plugState(at('paused', true, false))).toBe('plugged_in_paused');
    expect(plugState(at('normal', true, false))).toBe('plugged_in');
    expect(plugState(at('smart', true, false))).toBe('plugged_in');
    expect(plugState(at('eco', true, false))).toBeUndefined();
  });

  it('reads the switch from the mode only, so a finished car stays switched on', () => {
    expect(switchOn(at('normal', true, false))).toBe(true);
    expect(switchOn(at('smart', true, false))).toBe(true);
    expect(switchOn(at('paused', true, false))).toBe(false);
    expect(read(at('normal', true, false))).toMatchObject({ kind: 'adapted', binaryTarget: { kind: 'capability',
      writeCapabilityId: 'charging_mode', observationCapabilityId: 'evcharger_charging' } });
  });

  it('is found by its adapted capabilities', () => {
    expect(getCapabilityAdapter(read(at('normal', true, false)).capabilities))
      .toBe(getDeviceAdapter(at('normal', true, false)));
  });

  it('writes a switch request only as the mode', () => {
    const device = at('normal', true, true);
    const snapshot = partialDouble<TransportDeviceSnapshot>({
      id: 'smappee', binaryCapabilityId: 'evcharger_charging', binaryWriteCapabilityId: 'charging_mode',
    });
    const adapter = getDeviceAdapter(device);
    expect(adapter.switchWrite(snapshot, { capabilityId: 'evcharger_charging', value: false }))
      .toEqual({ kind: 'write', write: { capabilityId: 'charging_mode', value: 'paused' }, readBackAsWritten: false });
    expect(adapter.recoverSwitchWrite(snapshot, device, { capabilityId: 'evcharger_charging', value: true }))
      .toEqual({ kind: 'write', write: { capabilityId: 'charging_mode', value: 'normal' }, readBackAsWritten: false });
    expect(adapter.currentBindings(device)).toEqual([]);
  });
});

describe('Smappee EV Wall realtime reports', () => {
  const control = (device: HomeyDeviceLike): AdapterSnapshot => {
    const overlay = read(device);
    return partialDouble<AdapterSnapshot>({ controlAdapter: overlay.kind === 'adapted' ? overlay.controlAdapter : undefined });
  };

  it('reads the 1.4 app\'s own charging report as the connector only while the mode is normal', () => {
    const device = charger(v14, {
      charging_mode: 'normal', cable_connected: true, evcharger_charging: false, evcharger_charging_state: 'plugged_in',
    });
    const adapter = getDeviceAdapter(device);
    expect(adapter.normalize(control(device), 'evcharger_charging', false, device)).toEqual([
      { capabilityId: 'evcharger_charging_state', value: 'plugged_in' },
    ]);
    expect(adapter.normalize(control(device), 'evcharger_charging_state', 'plugged_in', device)).toEqual([
      { capabilityId: 'evcharger_charging_state', value: 'plugged_in' },
    ]);
    const charging = charger(v14, {
      charging_mode: 'normal', cable_connected: true, evcharger_charging: true,
      evcharger_charging_state: 'plugged_in_charging',
    });
    expect(adapter.normalize(control(charging), 'evcharger_charging', true, charging)).toEqual([
      { capabilityId: 'evcharger_charging_state', value: 'plugged_in_charging' },
    ]);
  });

  it('derives the switch and a paused plug state from a mode report on either app', () => {
    for (const device of [
      charger(v134, { charging_mode: 'paused', cable_connected: true, charging: false }),
      charger(v14, { charging_mode: 'paused', cable_connected: true, evcharger_charging: false,
        evcharger_charging_state: 'plugged_in' }),
    ]) {
      expect(getDeviceAdapter(device).normalize(control(device), 'charging_mode', 'paused', device)).toEqual([
        { capabilityId: 'charging_mode', value: 'paused' },
        { capabilityId: 'evcharger_charging', value: false },
        { capabilityId: 'evcharger_charging_state', value: 'plugged_in_paused' },
      ]);
    }
  });

  it('never publishes the 1.4 app\'s own plug state or switch when the mode is unreadable', () => {
    const device = charger(v14, {
      charging_mode: 'eco', cable_connected: true, evcharger_charging: true,
      evcharger_charging_state: 'plugged_in_charging',
    });
    const values: DeviceCapabilityMap = read(device).capabilityObj;
    expect(values.evcharger_charging).toBeUndefined();
    expect(values.evcharger_charging_state).toBeUndefined();
    expect(read(device).capabilities).not.toContain('evcharger_charging');
  });
});
