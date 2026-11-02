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
    deliveryCeilingW: 2500, chargeCeiling: { everyLevelW: 2500, taper: [], planningTaper: [] }, claimHeld: true,
    handBackDeferred: false, claimEngaged: true, admissible: true, verdict: 'responding',
  };

  it('keeps an accepted unchanged charge level usable after hours of waiting', () => {
    const cluster = resolveStorageCluster(planSource, device({
      batteryPower: { signedW: 0, observedAtMs: nowMs },
      batteryLevel: { percent: 60, observedAtMs: 1000 },
    }), options(control));
    expect(cluster).toMatchObject({ storage: { reading: 'observed', deliveryCeilingW: 2500 } });
  });

  it('caps charging by the taper band of the current level', () => {
    const tapered: BatteryLeverRead = {
      ...control,
      chargeCeiling: {
        everyLevelW: 2500, taper: [{ fromPercent: 90, ceilingW: 800 }], planningTaper: [{ fromPercent: 90, ceilingW: 800 }],
      },
    };
    const at = (percent: number) => resolveStorageCluster(planSource, device({
      batteryPower: { signedW: 0, observedAtMs: nowMs },
      batteryLevel: { percent, observedAtMs: nowMs },
    }), options(tapered));
    expect(at(85)).toMatchObject({ storage: { chargeCeilingW: 2500 } });
    expect(at(92)).toMatchObject({ storage: { chargeCeilingW: 800 } });
  });

  it('still authorizes no discharge when no battery level was accepted', () => {
    const cluster = resolveStorageCluster(planSource, device({
      batteryPower: { signedW: 0, observedAtMs: nowMs },
    }), options(control));
    expect(cluster).toMatchObject({ storage: { reading: 'observed', deliveryCeilingW: 0 } });
  });
});

describe('continuous battery selling projection', () => {
  const nowMs = 12 * 60 * 60 * 1000;
  const period = {
    startsAtMs: nowMs - 60_000, durationMs: 3_600_000, batteryPowerKW: -2, energyBeforeKWh: 6, energyAfterKWh: 4,
    gridImportKWh: 0, gridExportKWh: 1.5, importCost: 0, exportRevenue: 1.5, wearCost: 0.06, reason: 'export_energy' as const,
  };
  const plannedSource = (exportPolicy: typeof DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG.exportPolicy) => (
    partialDouble<PlanInputProjectionSource>({
      deviceControl: partialDouble<PlanInputProjectionSource['deviceControl']>({ controllableDevices: {} }),
      getNow: () => new Date(nowMs),
      readContinuousBatteryPlan: () => ({
        status: 'planned', generatedAtMs: nowMs, priceUnit: 'EUR/kWh',
        config: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR/kWh', exportPolicy },
        exportDecision: { kind: 'selling', estimatedSavings: 0.4 },
        plan: {
          status: 'planned', periods: [period], importCost: 0, exportRevenue: 1.5, wearCost: 0.06, energyCost: -1.44,
          terminalEnergyValue: 0, objectiveCost: -1.44, terminalEnergyKWh: 4, resolutionKWh: 0.05,
        },
      }),
    })
  );
  const control: BatteryLeverRead = {
    kind: 'setpoint', range: { minW: -2500, maxW: 2500, stepW: 5, excludeMinW: 0, excludeMaxW: 0 },
    deliveryCeilingW: 2500, chargeCeiling: { everyLevelW: 2500, taper: [], planningTaper: [] }, claimHeld: true,
    handBackDeferred: false, claimEngaged: true, admissible: true, verdict: 'responding',
  };
  const input = device({ batteryPower: { signedW: 0, observedAtMs: nowMs }, batteryLevel: { percent: 60, observedAtMs: nowMs } });

  it('carries the owner export ceiling with a selling period', () => {
    const cluster = resolveStorageCluster(
      plannedSource({ kind: 'price_export', netExportCeilingKW: 3 }), input, options(control),
    );
    expect(cluster).toMatchObject({ storage: { continuousPlan: {
      setpointW: -2000, validUntilMs: period.startsAtMs + period.durationMs, reason: 'export_energy', netExportCeilingW: 3000,
    } } });
  });

  it('supplies the house only when a selling period has no price-export policy behind it', () => {
    const cluster = resolveStorageCluster(plannedSource({ kind: 'household_only' }), input, options(control));
    expect(cluster).toMatchObject({ storage: { continuousPlan: { setpointW: -2000, reason: 'supply_house' } } });
    expect(cluster.storage).not.toHaveProperty('continuousPlan.netExportCeilingW');
  });
});
