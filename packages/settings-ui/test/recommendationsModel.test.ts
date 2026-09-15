import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import {
  groupSetupRecommendations,
  normalizeRecommendationDismissals,
  parseSupportedCars,
  resolveSetupRecommendations,
  type RecommendationContext,
} from '../src/ui/recommendationsModel.ts';

const device = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Connected 300',
  available: true,
  expectedPowerKw: 2,
  expectedPowerSource: 'default',
  targets: [],
  ...overrides,
} as TargetDeviceSnapshot);

const context = (overrides: Partial<RecommendationContext> = {}): RecommendationContext => ({
  devices: [],
  cars: [],
  associations: {},
  nativeWiringEnabledByDeviceId: {},
  ...overrides,
});

describe('setup recommendations', () => {
  it('recommends built-in control for each device held on a conflicting Flow', () => {
    const recommendations = resolveSetupRecommendations(context({
      devices: [device({
        flowConflict: {
          conflictingCapabilities: ['max_power_3000'],
          flowName: 'Limit water heater',
        },
      })],
    }));

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      title: 'Use built-in control for Connected 300',
      actionLabel: 'Review device',
      target: { kind: 'device', deviceId: 'device-1' },
    });
    expect(recommendations[0]?.body).toContain('Limit water heater');
    expect(recommendations[0]?.body).not.toContain('max_power_3000');
  });

  it('does not recommend changing a Flow once built-in control is enabled', () => {
    const recommendations = resolveSetupRecommendations(context({
      devices: [device({ flowConflict: { conflictingCapabilities: ['target_charger_current'] } })],
      nativeWiringEnabledByDeviceId: { 'device-1': true },
    }));

    expect(recommendations).toEqual([]);
  });

  it('recommends connecting each supported, unconfigured car to an available charger', () => {
    const recommendations = resolveSetupRecommendations(context({
      devices: [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger' })],
      cars: [{ id: 'car-1', name: 'Polestar 3' }, { id: 'car-2', name: 'ID.4' }],
      associations: { 'charger-1': { carIds: ['car-2'] } },
    }));

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      title: 'Connect Polestar 3 to a charger',
      actionLabel: 'Choose charger',
      target: { kind: 'device', deviceId: 'charger-1' },
    });
  });

  it('routes an unconfigured car to the device list when several chargers are available', () => {
    const recommendations = resolveSetupRecommendations(context({
      devices: [
        device({ id: 'charger-1', deviceClass: 'evcharger' }),
        device({ id: 'charger-2', deviceClass: 'evcharger' }),
      ],
      cars: [{ id: 'car-1', name: 'Polestar 3' }],
    }));

    expect(recommendations[0]?.target).toEqual({ kind: 'devices' });
  });

  it('recommends adding a charger when a supported car has none to connect to', () => {
    const recommendations = resolveSetupRecommendations(context({
      cars: [{ id: 'car-1', name: 'Polestar 3' }],
    }));

    expect(recommendations[0]).toMatchObject({
      title: 'Connect Polestar 3 to a charger',
      body: 'Add a compatible charger to PELS, then choose this car on the charger page.',
      actionLabel: 'Review devices',
      target: { kind: 'devices' },
    });
  });

  it('keeps matching-version acknowledgements dismissed and resurfaces newer versions', () => {
    const [recommendation] = resolveSetupRecommendations(context({
      devices: [device({ flowConflict: { conflictingCapabilities: ['max_power_3000'] } })],
    }));
    if (!recommendation) throw new Error('Expected a built-in control recommendation.');
    const groups = groupSetupRecommendations(
      [recommendation],
      { [recommendation.id]: recommendation.version },
    );
    const resurfaced = groupSetupRecommendations(
      [{ ...recommendation, version: recommendation.version + 1 }],
      { [recommendation.id]: recommendation.version },
    );

    expect(groups.active).toEqual([]);
    expect(groups.dismissed).toEqual([recommendation]);
    expect(resurfaced.active).toHaveLength(1);
  });

  it('validates acknowledgements and Homey car entries at their input boundaries', () => {
    expect(normalizeRecommendationDismissals({ good: 2, zero: 0, float: 1.5, text: '1' }))
      .toEqual({ good: 2 });
    expect(parseSupportedCars([
      { id: 'car-1', name: 'Polestar 3', class: 'car', hasCarAssociationSupport: true },
      { id: 'car-2', name: 'Old EV', class: 'car', hasCarAssociationSupport: false },
      { id: 'heater', name: 'Tank', class: 'heater', hasCarAssociationSupport: false },
    ])).toEqual([{ id: 'car-1', name: 'Polestar 3' }]);
    expect(parseSupportedCars([{ id: 'car-1', name: 'Polestar 3' }])).toEqual([]);
    expect(parseSupportedCars({})).toBeNull();
  });
});
