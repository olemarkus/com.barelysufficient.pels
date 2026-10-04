import { parseCarAssociationCandidatesRead } from '../src/ui/carAssociationCandidates.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import {
  groupSetupRecommendations,
  normalizeRecommendationDismissals,
  resolveSetupRecommendations,
  resolveSmartTaskStartPolicyRecommendations,
} from '../src/ui/recommendationsModel.ts';
import type { EvCarAssociations } from '../../contracts/src/types.ts';
import type {
  SettingsUiEvSocFlowReporter,
  SettingsUiRecommendationCar,
} from '../../contracts/src/settingsUiApi.ts';

const device = (overrides: Partial<TargetDeviceSnapshot> = {}): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Connected 300',
  available: true,
  expectedPowerKw: 2,
  expectedPowerSource: 'default',
  targets: [],
  ...overrides,
} as TargetDeviceSnapshot);

type ChargerMatches = Extract<SettingsUiRecommendationCar['matchHistory'], { state: 'resolved' }>['chargerMatches'];

const car = (
  id: string,
  name: string,
  chargerMatches: ChargerMatches = [],
): SettingsUiRecommendationCar => ({ id, name, matchHistory: { state: 'resolved', chargerMatches } });

const carWithUnreadableHistory = (id: string, name: string): SettingsUiRecommendationCar => ({
  id, name, matchHistory: { state: 'unavailable' },
});

const resolve = (
  devices: readonly TargetDeviceSnapshot[] = [],
  cars: readonly SettingsUiRecommendationCar[] = [],
  associations: EvCarAssociations = {},
  nativeWiringEnabledByDeviceId: Readonly<Record<string, boolean>> = {},
  evSocReporters: readonly SettingsUiEvSocFlowReporter[] = [],
) => resolveSetupRecommendations(
  devices,
  cars,
  associations,
  nativeWiringEnabledByDeviceId,
  evSocReporters,
);

describe('setup recommendations', () => {
  it('offers the start policy only for switchable, managed task devices without power limiting', () => {
    const devices = [
      device({ id: 'eligible', binaryControllable: true, powerCapable: true }),
      device({ id: 'unsupported', binaryControllable: true, powerCapable: false }),
      device({ id: 'limited', binaryControllable: true, powerCapable: true }),
      device({ id: 'enabled', binaryControllable: true, powerCapable: true }),
      device({ id: 'unmanaged', binaryControllable: true, powerCapable: true }),
      device({ id: 'unswitchable', binaryControllable: false, powerCapable: true }),
      device({ id: 'unused', binaryControllable: true, powerCapable: true }),
    ];
    const used = new Set(devices.filter((item) => item.id !== 'unused').map((item) => item.id));
    const recommendations = resolveSmartTaskStartPolicyRecommendations(
      devices,
      { eligible: true, unsupported: true, limited: true, enabled: true, unswitchable: true, unused: true },
      { limited: true },
      { enabled: 'pels_only' },
      used,
    );
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      id: 'smart-task-start-policy:eligible',
      category: 'optional',
      target: { kind: 'device-start-policy', deviceId: 'eligible' },
    });
    expect(groupSetupRecommendations(recommendations, { 'smart-task-start-policy:eligible': 1 }))
      .toEqual({ active: [], dismissed: recommendations });
  });

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

  it('recommends choosing a car only once PELS has matched it to a charger', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true })],
      [
        car('car-1', 'Polestar 3', [{ chargerId: 'charger-1', lastMatchedAtMs: 1_000 }]),
        car('car-2', 'ID.4', [{ chargerId: 'charger-1', lastMatchedAtMs: 2_000 }]),
        car('car-3', 'Kia EV6'),
      ],
      { 'charger-1': { carIds: ['car-2'] } },
    );

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      id: 'charger-car:car-1',
      category: 'optional',
      title: 'Select Polestar 3 on Easee',
      actionLabel: 'Open charger',
      target: { kind: 'device', deviceId: 'charger-1' },
    });
    expect(recommendations[0]?.body).toContain('PELS has matched Polestar 3 to Easee');
  });

  it('sends a matched car to the charger it was matched to most recently', () => {
    const recommendations = resolve(
      [
        device({ id: 'charger-1', deviceClass: 'evcharger', isEvCharger: true }),
        device({ id: 'charger-2', deviceClass: 'evcharger', isEvCharger: true }),
      ],
      [car('car-1', 'Polestar 3', [
        { chargerId: 'removed-charger', lastMatchedAtMs: 3_000 },
        { chargerId: 'charger-2', lastMatchedAtMs: 2_000 },
        { chargerId: 'charger-1', lastMatchedAtMs: 1_000 },
      ])],
    );

    expect(recommendations[0]?.target).toEqual({ kind: 'device', deviceId: 'charger-2' });
  });

  it('asks to remove battery reporting once a selected car has been matched to that charger', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true })],
      [car('car-1', 'Polestar 3', [{ chargerId: 'charger-1', lastMatchedAtMs: 1_000 }])],
      { 'charger-1': { carIds: ['car-1'] } },
      {},
      [{ chargerDeviceId: 'charger-1', flowName: 'Report car battery' }],
    );

    expect(recommendations).toEqual([expect.objectContaining({
      category: 'recommendation',
      title: 'Remove unused battery reporting for Easee',
      actionLabel: 'Check again',
      target: { kind: 'ev-soc-flow-conflict-check', deviceId: 'charger-1' },
    })]);
    expect(recommendations[0]?.body).toContain('Report car battery');
    expect(recommendations[0]?.body).toContain('ignores');
  });

  it('treats a live match as a match even before the history has it', () => {
    // The live association is a settings-UI decoration on top of the snapshot.
    const charger = {
      ...device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true }),
      associatedCar: {
        carId: 'car-1',
        carName: 'Polestar 3',
        chargingState: 'plugged_in_charging' as const,
        chargingStateObservedAtMs: 1_000,
      },
    };
    const recommendations = resolve(
      [charger],
      [car('car-1', 'Polestar 3')],
      { 'charger-1': { carIds: ['car-1'] } },
      {},
      [{ chargerDeviceId: 'charger-1' }],
    );

    expect(recommendations[0]?.id).toBe('ev-soc-flow-conflict:charger-1');
  });

  it('warns instead of asking to remove battery reporting while no selected car has been matched', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true })],
      [car('car-1', 'Kia EV6', [{ chargerId: 'charger-2', lastMatchedAtMs: 1_000 }])],
      { 'charger-1': { carIds: ['car-1'] } },
      {},
      [{ chargerDeviceId: 'charger-1', flowName: 'Report car battery' }],
    );

    expect(recommendations).toEqual([expect.objectContaining({
      id: 'ev-soc-flow-unmatched:charger-1',
      category: 'recommendation',
      title: 'Easee has no battery level',
      actionLabel: 'Open charger',
      target: { kind: 'device', deviceId: 'charger-1' },
    })]);
    // The selection, not the missing match, is why the Flow is ignored.
    expect(recommendations[0]?.body).toContain('A car is selected for this charger, so PELS ignores');
    expect(recommendations[0]?.body).toContain('Report car battery');
    // Its only other match is to a charger no longer in Homey, so it may still match here.
    expect(recommendations[0]?.body).toContain('has not matched Kia EV6 to this charger yet');
    expect(recommendations[0]?.body).toContain(
      'Clear the car selection to use the Flow again, and select the car once it shows as matched.',
    );
  });

  it('drops "yet" for a selected car that has matched another of the home\'s chargers', () => {
    const recommendations = resolve(
      [
        device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true }),
        device({ id: 'charger-2', name: 'Zaptec', deviceClass: 'evcharger', isEvCharger: true }),
      ],
      [car('car-1', 'Kia EV6', [{ chargerId: 'charger-2', lastMatchedAtMs: 1_000 }])],
      { 'charger-1': { carIds: ['car-1'] } },
      {},
      [{ chargerDeviceId: 'charger-1', flowName: 'Report car battery' }],
    );

    expect(recommendations.map(({ id }) => id)).toEqual(['ev-soc-flow-unmatched:charger-1']);
    // It charges on another charger, so it is not about to match here.
    expect(recommendations[0]?.body).toContain('PELS has not matched Kia EV6 to this charger, so');
    expect(recommendations[0]?.body).not.toContain('yet');
    // Nor does it promise the match the dropped "yet" denies.
    expect(recommendations[0]?.body).toMatch(/Clear the car selection to use the Flow again\.$/);
    expect(recommendations[0]?.body).not.toContain('once it shows as matched');
  });

  it('asks to clear a selected car that was removed from Homey', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true })],
      [car('car-2', 'Polestar 3')],
      { 'charger-1': { carIds: ['removed-car'] } },
      {},
      [{ chargerDeviceId: 'charger-1', flowName: 'Report car battery' }],
    );

    expect(recommendations).toEqual([expect.objectContaining({
      id: 'ev-soc-flow-unmatched:charger-1',
      title: 'Easee has no battery level',
      actionLabel: 'Open charger',
      target: { kind: 'device', deviceId: 'charger-1' },
    })]);
    const body = recommendations[0]?.body ?? '';
    expect(body).toContain('The selected car was removed from Homey, so the charger has no battery level.');
    // The picker labels its row "Removed car"; a car that no longer exists
    // cannot match, so there is nothing to select again.
    expect(body).toContain('Clear the “Removed car” selection in the charger’s Car section');
    expect(body).not.toContain('selected cars');
    expect(body).not.toContain('once it shows as matched');
  });

  it('names a removed car selected beside one still in Homey', () => {
    const recommendations = resolve(
      [
        device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true }),
        device({ id: 'charger-2', name: 'Zaptec', deviceClass: 'evcharger', isEvCharger: true }),
      ],
      [car('car-1', 'Kia EV6', [{ chargerId: 'charger-2', lastMatchedAtMs: 1_000 }])],
      { 'charger-1': { carIds: ['car-1', 'removed-car'] } },
      {},
      [{ chargerDeviceId: 'charger-1', flowName: 'Report car battery' }],
    );

    const body = recommendations[0]?.body ?? '';
    expect(body).toContain('PELS has not matched Kia EV6 to this charger, so');
    expect(body).toContain('A selected “Removed car” was removed from Homey and can never match, so clear it too.');
  });

  it('names cars and chargers in titles the way the car picker shows them', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: ' Easee ', deviceClass: 'evcharger', isEvCharger: true })],
      [car('car-1', 'Polestar 3 (null)', [{ chargerId: 'charger-1', lastMatchedAtMs: 1_000 }])],
    );

    expect(recommendations[0]?.title).toBe('Select Polestar 3 on Easee');
    expect(recommendations[0]?.body).toContain('PELS has matched Polestar 3 to Easee.');
  });

  it('gives no battery-reporting advice while the selected car\'s match history is unreadable', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true })],
      [carWithUnreadableHistory('car-1', 'Kia EV6')],
      { 'charger-1': { carIds: ['car-1'] } },
      {},
      [{ chargerDeviceId: 'charger-1', flowName: 'Report car battery' }],
    );

    expect(recommendations).toEqual([]);
  });

  it('does not offer a car whose match history is unreadable', () => {
    expect(resolve(
      [device({ id: 'charger-1', deviceClass: 'evcharger', isEvCharger: true })],
      [carWithUnreadableHistory('car-1', 'Polestar 3')],
    )).toEqual([]);
  });

  it('does not call battery reporting a conflict until a car is selected for that charger', () => {
    const chargers = [
      device({ id: 'charger-1', deviceClass: 'evcharger', isEvCharger: true }),
      device({ id: 'charger-2', deviceClass: 'evcharger', isEvCharger: true }),
    ];
    expect(resolve(chargers, [], {}, {}, [{ chargerDeviceId: 'charger-1' }])).toEqual([]);
    expect(resolve(
      chargers,
      [],
      { 'charger-2': { carIds: ['car-1'] } },
      {},
      [{ chargerDeviceId: 'charger-1' }],
    )).toEqual([]);
  });

  it('uses plural cleanup copy when several or unnamed reporting Flows are involved', () => {
    const recommendations = resolve(
      [device({ id: 'charger-1', name: 'Easee', deviceClass: 'evcharger', isEvCharger: true })],
      [car('car-1', 'Polestar 3', [{ chargerId: 'charger-1', lastMatchedAtMs: 1_000 }])],
      { 'charger-1': { carIds: ['car-1'] } },
      {},
      [{ chargerDeviceId: 'charger-1' }],
    );

    expect(recommendations[0]?.body).toContain('actions in enabled Homey Flows');
    expect(recommendations[0]?.body).toContain('Remove those actions');
  });

  it('does not recommend a car association without an actionable charger destination', () => {
    const recommendations = resolve([], [
      car('car-1', 'Polestar 3', [{ chargerId: 'charger-1', lastMatchedAtMs: 1_000 }]),
    ]);

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
    const matched = car('car-1', 'Polestar 3', [{ chargerId: 'charger-1', lastMatchedAtMs: 1_000 }]);
    expect(parseCarAssociationCandidatesRead({ state: 'resolved', cars: [matched] }))
      .toEqual({ state: 'resolved', cars: [matched] });
    expect(parseCarAssociationCandidatesRead({ state: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(parseCarAssociationCandidatesRead({ state: 'resolved', cars: [{ id: 'car-1' }] }))
      .toEqual({ state: 'unavailable' });
    expect(parseCarAssociationCandidatesRead({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Polestar 3' }],
    })).toEqual({ state: 'unavailable' });
    expect(parseCarAssociationCandidatesRead({
      state: 'resolved',
      cars: [{
        ...matched,
        matchHistory: { state: 'resolved', chargerMatches: [{ chargerId: 'charger-1', lastMatchedAtMs: Number.NaN }] },
      }],
    })).toEqual({ state: 'unavailable' });
    const unreadable = carWithUnreadableHistory('car-1', 'Polestar 3');
    expect(parseCarAssociationCandidatesRead({ state: 'resolved', cars: [unreadable] }))
      .toEqual({ state: 'resolved', cars: [unreadable] });
    expect(parseCarAssociationCandidatesRead({})).toEqual({ state: 'unavailable' });
  });

  it('ignores associations belonging to chargers that are no longer present', () => {
    const recommendations = resolve(
      [device({ id: 'charger-2', deviceClass: 'evcharger', isEvCharger: true })],
      [car('car-1', 'Polestar 3', [{ chargerId: 'charger-2', lastMatchedAtMs: 1_000 }])],
      { 'removed-charger': { carIds: ['car-1'] } },
    );

    expect(recommendations[0]?.title).toBe('Select Polestar 3 on Connected 300');
  });
});
