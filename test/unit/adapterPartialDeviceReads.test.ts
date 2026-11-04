import { describe, expect, it } from 'vitest';
import { teslaAdapter } from '../../lib/device/tesla';
import { zaptecAdapter } from '../../lib/device/zaptec';
import { withEaseeObservedCharging } from '../../lib/device/easee/switch';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const STAMP = '2026-10-01T12:00:00.000Z';
const entry = (value: unknown) => ({ value, lastUpdated: STAMP });
const tesla = (values: DeviceCapabilityMap): HomeyDeviceLike => ({
  id: 'tesla-battery', name: 'Tesla battery', class: 'sensor',
  driverId: 'homey:app:com.tesla.car:battery',
  capabilities: Object.keys(values), capabilitiesObj: values,
});
const zaptec = (values: DeviceCapabilityMap): HomeyDeviceLike => ({
  id: 'zaptec', name: 'Zaptec', class: 'evcharger',
  driverId: 'homey:app:com.zaptec:go',
  capabilities: Object.keys(values), capabilitiesObj: values,
});

describe('adapter observations after one source field is withheld', () => {
  it.each(['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'])(
    'keeps Tesla charging identity when %s has no accepted observation', missing => {
      const all: DeviceCapabilityMap = {
        charging_on: entry(true), charging_state: entry('Charging'),
        measure_charge_power: entry(4), measure_soc_level: entry(55),
      };
      const values = Object.fromEntries(Object.entries(all).filter(([id]) => id !== missing));
      const read = tesla(values);
      const overlay = teslaAdapter.overlay(read, read.capabilities!, values);

      expect(teslaAdapter.identity(read).class).toBe('evcharger');
      expect(overlay.kind).toBe('adapted');
      if (missing === 'charging_on') {
        expect(overlay.capabilityObj).not.toHaveProperty('evcharger_charging');
        expect(overlay.capabilities).not.toContain('evcharger_charging');
      } else expect(overlay.capabilityObj.evcharger_charging).toMatchObject({ value: true, lastUpdated: STAMP });
      if (missing === 'charging_state') {
        expect(overlay.capabilityObj).not.toHaveProperty('evcharger_charging_state');
        expect(overlay.capabilities).not.toContain('evcharger_charging_state');
      } else {
        expect(overlay.capabilityObj.evcharger_charging_state)
          .toMatchObject({ value: 'plugged_in_charging', lastUpdated: STAMP });
      }
      if (missing === 'measure_charge_power') {
        expect(overlay.capabilityObj).not.toHaveProperty('measure_power');
        expect(overlay.capabilities).not.toContain('measure_power');
      } else expect(overlay.capabilityObj.measure_power).toMatchObject({ value: 4000, lastUpdated: STAMP });
    },
  );

  it('does not turn a Tesla state without an EV equivalent into a disconnect', () => {
    const values = { charging_state: entry('Unknown'), measure_charge_power: entry(0) };
    const read = tesla(values);
    const overlay = teslaAdapter.overlay(read, read.capabilities!, values);

    expect(overlay.capabilityObj).not.toHaveProperty('evcharger_charging_state');
    expect(overlay.capabilities).not.toContain('evcharger_charging_state');
    expect(overlay.capabilityObj.measure_power).toMatchObject({ value: 0, lastUpdated: STAMP });
  });

  it('does not publish an overflowing Tesla watt conversion as measured power', () => {
    const values = { charging_on: entry(true), measure_charge_power: entry(Number.MAX_VALUE) };
    const read = tesla(values);
    const overlay = teslaAdapter.overlay(read, read.capabilities!, values);

    expect(overlay.capabilityObj).not.toHaveProperty('measure_power');
    expect(overlay.capabilityObj.evcharger_charging).toMatchObject({ value: true, lastUpdated: STAMP });
  });

  it('keeps Zaptec switch and power observations when neither plug-state source is readable', () => {
    const values = { charging_button: entry(false), measure_power: entry(7200) };
    const read = zaptec(values);
    const overlay = zaptecAdapter.overlay(read, read.capabilities!, values);

    expect(overlay.kind).toBe('adapted');
    expect(overlay.capabilityObj.evcharger_charging).toMatchObject({ value: false, lastUpdated: STAMP });
    expect(overlay.capabilityObj.measure_power).toEqual(values.measure_power);
    expect(overlay.capabilityObj).not.toHaveProperty('evcharger_charging_state');
    expect(overlay.capabilities).not.toContain('evcharger_charging_state');
  });

  it('keeps a Zaptec plug observation when the button has no accepted observation', () => {
    const values = { charge_mode: entry('Connected_Finishing'), measure_power: entry(0) };
    const read = zaptec(values);
    const overlay = zaptecAdapter.overlay(read, read.capabilities!, values);

    expect(overlay.kind).toBe('adapted');
    expect(overlay.capabilityObj.evcharger_charging_state).toMatchObject({ value: 'plugged_in', lastUpdated: STAMP });
    expect(overlay.capabilityObj).not.toHaveProperty('evcharger_charging');
    expect(overlay.capabilities).not.toContain('evcharger_charging');
  });

  it('uses an accepted Zaptec connected alarm without claiming a running or paused session', () => {
    const values = { 'alarm_generic.car_connected': entry(true), measure_power: entry(0) };
    const read = zaptec(values);
    const overlay = zaptecAdapter.overlay(read, read.capabilities!, values);

    expect(overlay.capabilityObj.evcharger_charging_state).toMatchObject({ value: 'plugged_in', lastUpdated: STAMP });
    expect(overlay.capabilityObj).not.toHaveProperty('evcharger_charging');
  });

  it('does not treat a withheld Easee current as zero when the charger is paused', () => {
    const values = {
      evcharger_charging: entry(true), evcharger_charging_state: entry('plugged_in_paused'),
    };

    expect(withEaseeObservedCharging(values)).toBe(values);
    expect(withEaseeObservedCharging(values).evcharger_charging).toEqual(values.evcharger_charging);
  });

  it('still observes an Easee charging session independently of its current', () => {
    const values = {
      evcharger_charging: entry(false), evcharger_charging_state: entry('plugged_in_charging'),
    };

    expect(withEaseeObservedCharging(values).evcharger_charging).toMatchObject({ value: true, lastUpdated: STAMP });
  });
});
