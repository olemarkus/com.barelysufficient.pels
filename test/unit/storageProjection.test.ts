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
import { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } from '../../packages/shared-domain/src/settings/continuousBatteryPlan';
import { partialDouble } from '../helpers/partialDouble';

const BATTERY = 'battery-1';

const source = partialDouble<PlanInputProjectionSource>({
  deviceControl: partialDouble<PlanInputProjectionSource['deviceControl']>({ controllableDevices: {} }),
  getNow: () => new Date(1000),
  readContinuousBatteryPlan: () => ({ status: 'disabled', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG }),
});

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

describe('continuous battery reserve projection', () => {
  const nowMs = 12 * 60 * 60 * 1000;
  const planSource = partialDouble<PlanInputProjectionSource>({
    deviceControl: partialDouble<PlanInputProjectionSource['deviceControl']>({ controllableDevices: {} }),
    getNow: () => new Date(nowMs),
    readContinuousBatteryPlan: () => ({
      status: 'waiting', reason: 'prices_unavailable',
      config: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR/kWh' },
    }),
  });
  const control: BatteryLeverRead = {
    kind: 'setpoint', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    deliveryCeilingW: 2500, chargeCeilingW: 2500, claimHeld: true,
    handBackDeferred: false, claimEngaged: true, admissible: true, verdict: 'responding',
  };

  it('keeps an accepted unchanged charge level usable after hours of waiting', () => {
    const cluster = resolveStorageCluster(planSource, device({
      batteryPower: { signedW: 0, observedAtMs: nowMs },
      batteryLevel: { percent: 60, observedAtMs: 1000 },
    }), options(control));
    expect(cluster).toMatchObject({ storage: { reading: 'observed', deliveryCeilingW: 2500 } });
  });

  it('still authorizes no discharge when no battery level was accepted', () => {
    const cluster = resolveStorageCluster(planSource, device({
      batteryPower: { signedW: 0, observedAtMs: nowMs },
    }), options(control));
    expect(cluster).toMatchObject({ storage: { reading: 'observed', deliveryCeilingW: 0 } });
  });
});
