/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  compareSmartTaskPickerRows,
  resolveSmartTaskDeviceGroup,
  resolveSmartTaskDeviceGroupIconLabel,
  SMART_TASK_DEVICE_GROUP_ORDER,
} from '../../packages/shared-domain/src/smartTaskDevicePickerOrder';

describe('resolveSmartTaskDeviceGroup', () => {
  it('maps an EV charger to the ev_charger group, whatever goal it is offered', () => {
    expect(resolveSmartTaskDeviceGroup({ isEvCharger: true })).toBe('ev_charger');
  });

  it('maps every other device to the heating group', () => {
    // The runtime normalizes device classes into a fixed set with no
    // water-heater class, so thermostats, water heaters and relays all group
    // as heating.
    expect(resolveSmartTaskDeviceGroup({ isEvCharger: false })).toBe('heating');
  });
});

describe('compareSmartTaskPickerRows', () => {
  it('orders by the intentional group order, then by name within a group', () => {
    const rows = [
      { group: 'ev_charger' as const, deviceName: 'Zoe' },
      { group: 'heating' as const, deviceName: 'Bedroom' },
      { group: 'ev_charger' as const, deviceName: 'Audi' },
      { group: 'heating' as const, deviceName: 'Attic' },
    ];
    expect([...rows].sort(compareSmartTaskPickerRows)).toEqual([
      { group: 'heating', deviceName: 'Attic' },
      { group: 'heating', deviceName: 'Bedroom' },
      { group: 'ev_charger', deviceName: 'Audi' },
      { group: 'ev_charger', deviceName: 'Zoe' },
    ]);
  });

  it('matches the declared display order constant', () => {
    expect(SMART_TASK_DEVICE_GROUP_ORDER).toEqual(['heating', 'ev_charger']);
  });
});

describe('resolveSmartTaskDeviceGroupIconLabel', () => {
  it('returns a human label for each group', () => {
    expect(resolveSmartTaskDeviceGroupIconLabel('heating')).toBe('Heating');
    expect(resolveSmartTaskDeviceGroupIconLabel('ev_charger')).toBe('EV charger');
  });
});
