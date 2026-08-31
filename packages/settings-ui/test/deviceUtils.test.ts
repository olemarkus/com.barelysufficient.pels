import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils.ts';
import { isGrayStateDevice, requiresNativeWiringForActivation } from '../src/ui/deviceUtils.ts';

describe('isGrayStateDevice', () => {
  it('flags unavailable and disappeared devices as gray', () => {
    expect(isGrayStateDevice({ available: false })).toBe(true);
    expect(isGrayStateDevice({ currentState: 'unknown' })).toBe(true);
    expect(isGrayStateDevice({ currentState: 'disappeared' })).toBe(true);
  });

  it('keeps active devices out of the gray state', () => {
    expect(isGrayStateDevice({ available: true, currentState: 'on' })).toBe(false);
    expect(isGrayStateDevice({ available: true, currentState: 'off' })).toBe(false);
  });
});

describe('requiresNativeWiringForActivation', () => {
  it('requires native wiring only when Zaptec-style support exists without an effective EV control capability', () => {
    expect(requiresNativeWiringForActivation({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: false },
      binaryControllable: false,
    } as SettingsUiDeviceListItem)).toBe(true);
    expect(requiresNativeWiringForActivation({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: true },
      binaryControllable: false,
    } as SettingsUiDeviceListItem)).toBe(false);
    expect(requiresNativeWiringForActivation({
      controlAdapter: { kind: 'capability_adapter', activationRequired: true, activationEnabled: false },
      binaryControllable: true,
      deviceRole: 'ev_charger',
    } as SettingsUiDeviceListItem)).toBe(false);
  });
});
