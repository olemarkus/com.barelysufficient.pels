import { describe, expect, it } from 'vitest';
import { withEaseeChargingState } from '../../lib/device/easee/chargingState';
import { findDeviceReadContractViolation } from '../../lib/device/transport/deviceReadContract';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const at = '2026-10-01T12:00:00Z';
const device = (status: unknown): HomeyDeviceLike => ({ ...HOMEY_DEVICE_FIELDS,
  id: 'charger', name: 'Charger', class: 'evcharger', driverId: 'homey:app:no.easee:charger',
  capabilities: ['charger_status', 'evcharger_charging', 'evcharger_charging_state', 'target_charger_current'],
  capabilitiesObj: {
    charger_status: { value: status, lastUpdated: at },
    evcharger_charging: { value: false, lastUpdated: at },
    evcharger_charging_state: { value: 'plugged_out', lastUpdated: at },
    target_charger_current: { value: 16, lastUpdated: at },
  },
});

describe('Easee physical connection state', () => {
  it.each([
    ['Completed', 'plugged_in_finished'], ['Standby', 'plugged_out'], ['Paused', 'plugged_in_paused'],
    ['Charging', 'plugged_in_charging'], ['Car connected', 'plugged_in_awaiting_start'],
    ['Awaiting Authentication', 'plugged_in_awaiting_start'],
  ])('resolves %s at its own observation date', (status, state) => {
    const values: DeviceCapabilityMap = {
      charger_status: { value: status, lastUpdated: at },
      evcharger_charging_state: { value: 'plugged_out', lastUpdated: '2026-10-01T11:00:00Z' },
    };
    expect(withEaseeChargingState(['charger_status'], values).evcharger_charging_state)
      .toEqual({ value: state, lastUpdated: at });
  });

  it('leaves devices without a declared vendor status as reported', () => {
    const values = device('Completed').capabilitiesObj as DeviceCapabilityMap;
    expect(withEaseeChargingState([], values)).toBe(values);
  });

  it('does not read a leftover status entry once the capability is no longer declared', () => {
    const read = device(null);
    read.capabilities = read.capabilities?.filter(id => id !== 'charger_status');
    expect(findDeviceReadContractViolation(read)).toBeNull();
  });

  it.each([null, 4])('rejects a complete read with malformed declared status %s', status => {
    expect(findDeviceReadContractViolation(device(status))).toEqual({
      reason: 'unexpected_value', capabilityId: 'charger_status',
    });
  });

  it('accepts a mode the adapter does not know and keeps the app\'s own plug state', () => {
    // The Easee app names a mode it does not know `UNKNOWN (n)`.
    const read = device('UNKNOWN (9)');
    expect(findDeviceReadContractViolation(read)).toBeNull();
    const values = read.capabilitiesObj as DeviceCapabilityMap;
    expect(withEaseeChargingState(read.capabilities ?? [], values)).toBe(values);
  });

  it('rejects an undated status even when the app dated its lossy standard state', () => {
    const read = device('Completed');
    delete read.capabilitiesObj!.charger_status!.lastUpdated;
    expect(findDeviceReadContractViolation(read)).toEqual({ reason: 'missing_stamp', capabilityId: 'charger_status' });
  });
});
