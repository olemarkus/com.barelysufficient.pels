import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

describe('Headroom for device condition', () => {
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
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('returns true only when headroom plus device estimate meets the required kW', async () => {
    const device = new MockDevice('dev-1', 'Heater', ['target_temperature', 'measure_power', 'onoff']);
    await device.setCapabilityValue('measure_power', 600); // 0.6 kW measured
    await device.setCapabilityValue('onoff', true);

    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    const app = createApp();
    await app.onInit();

    // Force a known headroom value
    const guard = (app as any).capacityGuard;
    guard.getHeadroom = () => 0.4; // kW

    const runCondition = mockHomeyInstance.flow._conditionCardListeners.has_headroom_for_device;
    expect(runCondition).toBeDefined();

    // headroom (0.4) + device estimate (0.6) = 1.0 >= 0.9 -> true
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 0.9 })).resolves.toBe(true);
    // headroom (0.4) + device estimate (0.6) = 1.0 >= 1.2 -> false
    await expect(runCondition({ device: { id: 'dev-1' }, required_kw: 1.2 })).resolves.toBe(false);

    await app.onUninit?.();
  });
});
