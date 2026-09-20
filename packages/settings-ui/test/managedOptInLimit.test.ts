import { resolveManagedOptInLimit } from '../src/ui/deviceDetail/managedOptInLimit.ts';

type OptInDevice = Parameters<typeof resolveManagedOptInLimit>[0];

const device = (overrides: Partial<OptInDevice> = {}): OptInDevice => ({
  id: 'heater-1',
  powerCapable: true,
  ...overrides,
} as OptInDevice);

describe('resolveManagedOptInLimit', () => {
  it('turns Limit on for a device nobody has made a Limit choice for', () => {
    // The point of marking a device Managed is to let PELS turn it down; as a
    // separate second tap, a new device sat managed and unlimitable.
    expect(resolveManagedOptInLimit(device(), {})).toBe('enable');
  });

  it('turns Limit on over an explicit off, because that off is not reliably the owner\'s', () => {
    // When a device loses its power reading the runtime writes `false` over the
    // owner's `true`. Honouring it later would strand the owner who HAD Limit
    // on with Managed-but-unlimitable once the device came back.
    expect(resolveManagedOptInLimit(device(), { 'heater-1': false })).toBe('enable');
  });

  it('leaves Limit alone when it is already on, so nothing is written', () => {
    expect(resolveManagedOptInLimit(device(), { 'heater-1': true })).toBe('leave');
  });

  it('judges only this device, not a neighbour\'s choice', () => {
    expect(resolveManagedOptInLimit(device(), { 'other-device': false })).toBe('enable');
  });

  it('leaves a device with no power reading alone: Limit is not available to it', () => {
    // A temperature-only device is managed for its mode targets and price
    // response. The row already says what Limit needs.
    expect(resolveManagedOptInLimit(device({ powerCapable: false }), {})).toBe('leave');
  });
});
