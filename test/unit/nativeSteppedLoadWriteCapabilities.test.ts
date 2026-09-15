import {
  isToggleGatedNativeWriteSet,
  resolveNativeSteppedLoadWriteCapabilities,
} from '../../lib/device/nativeSteppedLoadWiring';

describe('resolveNativeSteppedLoadWriteCapabilities', () => {
  it('returns target_power for a target_power stepper', () => {
    expect(resolveNativeSteppedLoadWriteCapabilities(['measure_power', 'target_power']))
      .toEqual(['target_power']);
  });

  it('prefers target_power even when a max_power cap is also present', () => {
    expect(resolveNativeSteppedLoadWriteCapabilities(['target_power', 'max_power_3000', 'onoff']))
      .toEqual(['target_power']);
  });

  it('returns the present max_power cap plus onoff for a Hoiax stepper', () => {
    expect(resolveNativeSteppedLoadWriteCapabilities(['measure_power', 'max_power_3000', 'onoff']))
      .toEqual(['max_power_3000', 'onoff']);
  });

  it('omits onoff when the device does not expose it', () => {
    expect(resolveNativeSteppedLoadWriteCapabilities(['max_power_2000']))
      .toEqual(['max_power_2000']);
  });

  it('returns empty for a device with no native-write capability', () => {
    expect(resolveNativeSteppedLoadWriteCapabilities(['measure_power', 'onoff'])).toEqual([]);
    expect(resolveNativeSteppedLoadWriteCapabilities([])).toEqual([]);
  });

  it('returns the charger current and its equivalent Flow card for an Easee charger', () => {
    expect(resolveNativeSteppedLoadWriteCapabilities(['onoff', 'target_charger_current', 'evcharger_charging']))
      .toEqual(['target_charger_current', 'setDynamicChargerCurrent']);
  });
});

describe('isToggleGatedNativeWriteSet', () => {
  it('gates Hoiax and Easee native writes behind the built-in control switch', () => {
    expect(isToggleGatedNativeWriteSet(['max_power_3000', 'onoff'])).toBe(true);
    expect(isToggleGatedNativeWriteSet(['target_charger_current', 'setDynamicChargerCurrent'])).toBe(true);
  });

  it('does not gate target_power steppers, which are default-on', () => {
    expect(isToggleGatedNativeWriteSet(['target_power'])).toBe(false);
  });
});
