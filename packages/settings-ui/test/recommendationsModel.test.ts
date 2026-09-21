import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import {
  groupSetupRecommendations,
  normalizeRecommendationDismissals,
  parseRecommendationCarsRead,
  resolveSetupRecommendations,
} from '../src/ui/recommendationsModel.ts';
import type { EvCarAssociations } from '../../contracts/src/types.ts';
import type { SettingsUiRecommendationCar } from '../../contracts/src/settingsUiApi.ts';

const device = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Connected 300',
  available: true,
  expectedPowerKw: 2,
  expectedPowerSource: 'default',
  targets: [],
  ...overrides,
} as TargetDeviceSnapshot);

const resolve = (
  devices: readonly TargetDeviceSnapshot[] = [],
  cars: readonly SettingsUiRecommendationCar[] = [],
  associations: EvCarAssociations = {},
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>> = {},
) => resolveSetupRecommendations(devices, cars, associations, nativeWiringEnabledByDeviceId);

describe('setup recommendations', () => {
  it.each(['Easee', 'Høiax'])(
    'recommends available built-in control for %s without claiming a Flow was detected', (name) => {
      const recommendations = resolve([device({
        name,
        controlAdapter: {
          kind: 'capability_adapter', activationAvailable: true,
          activationRequired: false, activationEnabled: false,
        },
      })]);
      expect(recommendations).toHaveLength(1);
      expect(recommendations[0]?.title).toBe(`Use built-in device control for ${name}`);
      expect(recommendations[0]?.body).not.toContain('Your current Flow keeps working');
      expect(recommendations[0]?.body).toContain('If you use a Flow');
    },
  );

  it('does not recommend built-in control for devices without an available switch', () => {
    expect(resolve([device()])).toEqual([]);
    expect(resolve([device({
      controlAdapter: {
        kind: 'capability_adapter', activationAvailable: false,
        activationRequired: false, activationEnabled: false,
      },
    })])).toEqual([]);
  });

  it('removes the independent recommendation when the effective adapter is enabled', () => {
    expect(resolve([device({
      controlAdapter: {
        kind: 'capability_adapter', activationAvailable: true,
        activationRequired: false, activationEnabled: true,
      },
    })])).toEqual([]);
  });

  it('recommends built-in control for each device held on a conflicting Flow', () => {
    const recommendations = resolve([
      device({
        flowConflict: {
          conflictingCapabilities: ['max_power_3000'],
          flowName: 'Limit water heater',
        },
      }),
    ]);

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      title: 'Use built-in device control for Connected 300',
      actionLabel: 'Check again',
      target: { kind: 'flow-conflict-check', deviceId: 'device-1' },
    });
    expect(recommendations[0]?.body).toContain('Limit water heater');
    expect(recommendations[0]?.body).toContain('Your current Flow keeps working');
    expect(recommendations[0]?.body).toContain('disable the Flow');
    expect(recommendations[0]?.body).toContain('delete its device-control action');
    expect(recommendations[0]?.body).not.toContain('max_power_3000');
  });

  it('keeps recommending Flow cleanup while built-in control and a Flow conflict are both enabled', () => {
    const recommendations = resolve(
      [device({
        flowConflict: {
          conflictingCapabilities: ['target_charger_current'],
          flowName: 'Charge at night',
        },
      })],
      [],
      {},
      { 'device-1': true },
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      id: 'flow-conflict:device-1',
      title: 'Remove conflicting Flow control for Connected 300',
      actionLabel: 'Check again',
      target: { kind: 'flow-conflict-check', deviceId: 'device-1' },
    });
    expect(recommendations[0]?.body).toContain('Charge at night');
    expect(recommendations[0]?.body).toContain('Disable the Flow');
    expect(recommendations[0]?.body).toContain('delete its device-control action');
    expect(recommendations[0]?.body).toContain('cannot override PELS');
  });

  it('recommends connecting each supported, unconfigured car to an available charger', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger' })],
      [{ id: 'car-1', name: 'Polestar 3' }, { id: 'car-2', name: 'ID.4' }],
      { 'charger-1': { carIds: ['car-2'] } },
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      title: 'Choose a charger for Polestar 3',
      actionLabel: 'Choose charger',
      target: { kind: 'device', deviceId: 'charger-1' },
    });
  });

  it('routes an unconfigured car to the device list when several chargers are available', () => {
    const recommendations = resolve(
      [
        device({ id: 'charger-1', deviceClass: 'evcharger' }),
        device({ id: 'charger-2', deviceClass: 'evcharger' }),
      ],
      [{ id: 'car-1', name: 'Polestar 3' }],
    );

    expect(recommendations[0]?.target).toEqual({ kind: 'devices' });
  });

  it('does not recommend a car association without an actionable charger destination', () => {
    const recommendations = resolve([], [{ id: 'car-1', name: 'Polestar 3' }]);

    expect(recommendations).toEqual([]);
  });

  it('keeps matching-version acknowledgements dismissed and resurfaces newer versions', () => {
    const [recommendation] = resolve([
      device({ flowConflict: { conflictingCapabilities: ['max_power_3000'] } }),
    ]);
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
    expect(parseRecommendationCarsRead({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Polestar 3' }],
    })).toEqual({ state: 'resolved', cars: [{ id: 'car-1', name: 'Polestar 3' }] });
    expect(parseRecommendationCarsRead({ state: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(parseRecommendationCarsRead({ state: 'resolved', cars: [{ id: 'car-1' }] }))
      .toEqual({ state: 'unavailable' });
    expect(parseRecommendationCarsRead({})).toEqual({ state: 'unavailable' });
  });

  it('ignores associations belonging to chargers that are no longer present', () => {
    const recommendations = resolve(
      [device({ id: 'charger-2', deviceClass: 'evcharger' })],
      [{ id: 'car-1', name: 'Polestar 3' }],
      { 'removed-charger': { carIds: ['car-1'] } },
    );

    expect(recommendations[0]?.title).toBe('Choose a charger for Polestar 3');
  });
});
