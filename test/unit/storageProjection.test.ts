// The storage cluster a home battery projects into planner input
// (`resolveStorageCluster`): a battery PELS can only watch carries its signed
// power alone, so its discharge counts against surplus devices whenever it is
// read and in the Main home. Managed is the plan's managed filter, not this
// projection's.
import { resolveStorageCluster } from '../../lib/planInput/storageProjection';
import type {
  PlanInputProjectionSource,
  ToPlanDeviceInput,
  ToPlanDeviceOptions,
} from '../../lib/planInput/planInputDeviceTypes';
import type { BatteryControlOwner, BatteryLeverRead } from '../../lib/ports/batteryControlOwner';

const BATTERY = 'battery-1';

const source = { getControllableDevices: () => ({}) } as unknown as PlanInputProjectionSource;

const device = (overrides: Partial<ToPlanDeviceInput> = {}): ToPlanDeviceInput => ({
  id: BATTERY,
  available: true,
  batteryPower: { signedW: -2000, observedAtMs: 1_000 },
  ...overrides,
} as ToPlanDeviceInput);

const options = (control: BatteryLeverRead = { kind: 'none' }): ToPlanDeviceOptions => ({
  storage: {
    kind: 'battery_control',
    owner: { readControl: () => control } as unknown as BatteryControlOwner,
  },
} as ToPlanDeviceOptions);

describe('resolveStorageCluster for a battery PELS can only watch', () => {
  it('carries the signed power of a battery the owner reads no lever on', () => {
    expect(resolveStorageCluster(source, device(), options()))
      .toEqual({ storage: { reading: 'watched', signedPowerW: -2000 } });
  });

  it.each([
    ['unavailable', device({ available: false }), options()],
    ['without a power reading', device({ batteryPower: undefined }), options()],
    ['in a meter area', device(), { storage: { kind: 'none' } } as ToPlanDeviceOptions],
  ])('projects nothing for one %s', (_label, input, projection) => {
    expect(resolveStorageCluster(source, input, projection)).toEqual({});
  });
});
