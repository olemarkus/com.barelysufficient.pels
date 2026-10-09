/**
 * Flow e2e for "Set EV charging phase". Every charger's target-power config
 * lives in one settings map, so the card saves one charger's entry by reading
 * the map back first. Driven through the Flow card the app registered and
 * observed through the persisted settings.
 */
import { createEvTargetPowerConfig } from '../../packages/shared-domain/src/evTargetPowerConfig';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';

const CONFIGS_KEY = 'device_target_power_configs';
const OTHER_CONFIG = { enabled: true, min: 0, max: 3_000, step: 500 };

const buildCharger = async (id: string, name: string): Promise<MockDevice> => {
  const charger = new MockDevice(
    id,
    name,
    ['measure_power', 'target_power', 'evcharger_charging', 'evcharger_charging_state'],
    'evcharger',
  );
  charger.setCapabilityMetadata('target_power', {
    units: 'W', min: 0, max: 7_360, step: 230, setable: true,
  });
  await charger.setCapabilityValue('measure_power', 0);
  await charger.setCapabilityValue('target_power', 0);
  await charger.setCapabilityValue('evcharger_charging', false);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_out');
  return charger;
};

const startApp = async (): Promise<Record<string, unknown>> => {
  setMockDrivers({
    chargers: new MockDriver('chargers', [await buildCharger('ev-1', 'Garage charger')]),
  });
  const stored = {
    'ev-1': createEvTargetPowerConfig('ev_charger_3_phase'),
    // Another device's config the card must never touch.
    'water-1': OTHER_CONFIG,
  };
  mockHomeyInstance.settings.set('managed_devices', { 'ev-1': true });
  mockHomeyInstance.settings.set(CONFIGS_KEY, stored);
  const app = createApp();
  await app.onInit();
  return stored;
};

describe('Set EV charging phase flow card', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.api.clearRealtimeEvents();
    vi.clearAllTimers();
  });

  afterEach(async () => {
    // A refusal case spies on settings reads; a failing one must not leak its
    // spy into the cases after it.
    vi.restoreAllMocks();
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('saves the charger\'s phase and keeps every other device\'s config', async () => {
    await startApp();
    const setPhase = mockHomeyInstance.flow._actionCardListeners.set_ev_charging_phase;

    await expect(setPhase({ charger: 'ev-1', phase: 'ev_charger_1_phase' })).resolves.toBe(true);

    expect(mockHomeyInstance.settings.get(CONFIGS_KEY)).toEqual({
      'ev-1': createEvTargetPowerConfig('ev_charger_1_phase'),
      'water-1': OTHER_CONFIG,
    });
  });

  // The read the card makes fails: the SDK's transient `null` on a listed key,
  // or a value that is not a map. A map built from that read would hold only
  // `ev-1`, so saving it would erase every other device's config.
  it.each([
    ['reads back null', null],
    ['reads back malformed', 42],
  ])('refuses to save over a config map that %s, and keeps every entry', async (_label, failedRead) => {
    const stored = await startApp();
    const setPhase = mockHomeyInstance.flow._actionCardListeners.set_ev_charging_phase;
    const settings = mockHomeyInstance.settings;
    const realGet = settings.get.bind(settings);
    const read = vi.spyOn(settings, 'get').mockImplementation((key: string) => (
      key === CONFIGS_KEY ? failedRead : realGet(key)
    ));
    const write = vi.spyOn(settings, 'set');

    await expect(setPhase({ charger: 'ev-1', phase: 'ev_charger_1_phase' }))
      .rejects.toThrow('PELS could not save the EV charging phase. Try again shortly.');

    expect(write).not.toHaveBeenCalledWith(CONFIGS_KEY, expect.anything());
    read.mockRestore();
    expect(settings.get(CONFIGS_KEY)).toEqual(stored);
  });
});
