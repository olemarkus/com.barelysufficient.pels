import {
  getLatestPlanSnapshotForTests,
  mockHomeyInstance,
  setMockDrivers,
} from '../mocks/homey';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
} from '../../lib/utils/settingsKeys';
const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

// Use fake timers to prevent resource leaks from periodic refresh and control timing deterministically
vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'] });

const buildTemperatureApiDevice = (overrides?: Partial<{
  id: string;
  name: string;
  targetTemperature: number;
  measureTemperature: number;
  measurePower: number;
  class: string;
  capabilities: string[];
  onoff: boolean;
}>) => {
  const capabilities = overrides?.capabilities ?? [
    'measure_power',
    'measure_temperature',
    'target_temperature',
    'fan_mode',
  ];

  const capabilitiesObj: Record<string, {
    id: string;
    value: unknown;
    units?: string;
    min?: number;
    max?: number;
    step?: number;
  }> = {
    measure_power: { id: 'measure_power', value: overrides?.measurePower ?? 245.73 },
    measure_temperature: { id: 'measure_temperature', value: overrides?.measureTemperature ?? 18, units: '°C' },
    target_temperature: {
      id: 'target_temperature',
      value: overrides?.targetTemperature ?? 19,
      units: '°C',
      min: 10,
      max: 30,
      step: 0.5,
    },
    fan_mode: { id: 'fan_mode', value: 'home' },
  };

  if (capabilities.includes('onoff')) {
    capabilitiesObj.onoff = { id: 'onoff', value: overrides?.onoff ?? true };
  }

  return {
    id: overrides?.id ?? 'airtreatment-1',
    name: overrides?.name ?? 'Nordic S4 REL',
    class: overrides?.class ?? 'airtreatment',
    virtualClass: null,
    capabilities,
    capabilitiesObj,
    settings: {},
  };
};

describe('Airtreatment device integration', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('builds a snapshot entry for an airtreatment temperature device', async () => {
    setMockDrivers({});

    const app = createApp();
    await app.onInit();

    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'airtreatment-1': buildTemperatureApiDevice(),
    });

    await (app as any).refreshTargetDevicesSnapshot();

    const snapshot = getLatestTargetSnapshotForTests();
    const entry = snapshot.find((device) => device.id === 'airtreatment-1');

    expect(entry).toBeDefined();
    expect(entry?.deviceClass).toBe('airtreatment');
    expect(entry?.deviceType).toBe('temperature');
    expect(entry?.powerCapable).toBe(true);
  });

  it('enforces set_temperature with sane default when capacity control is enabled', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set('managed_devices', { 'airtreatment-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'airtreatment-1': true });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'airtreatment-1': { action: 'turn_off' },
    });

    const app = createApp();
    await app.onInit();

    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'airtreatment-1': buildTemperatureApiDevice({ targetTemperature: 19 }),
    });

    await (app as any).refreshTargetDevicesSnapshot();

    const overshootBehaviors = mockHomeyInstance.settings.get('overshoot_behaviors') as Record<string, { action: string; temperature?: number }>;
    expect(overshootBehaviors['airtreatment-1']).toEqual({ action: 'set_temperature', temperature: 16 });
  });

  // Capacity shedding (lower target_temperature for thermostat-class devices; turn_off
  // for devices that expose onoff) is covered black-box, through the SDK boundary, in
  // test/e2e/airtreatmentShedControl.e2e.test.ts. This spec keeps classification and the
  // restore-retry hysteresis (a white-box scheduling concern).

  it('avoids repeated restore retries when reported target never leaves shed temperature', async () => {
    setMockDrivers({});
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { 'flexit-1': true, 'flexit-2': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'flexit-1': true, 'flexit-2': true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'flexit-1': 1, 'flexit-2': 2 } });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'flexit-1': 19, 'flexit-2': 19 } });
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      'flexit-1': { action: 'set_temperature', temperature: 16 },
      'flexit-2': { action: 'set_temperature', temperature: 16 },
    });

    const app = createApp();
    await app.onInit();

    const reportedTargets: Record<string, number> = { 'flexit-1': 19, 'flexit-2': 19 };
    const samplePowerW = 2500;

    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async () => ({
      'flexit-1': buildTemperatureApiDevice({
        id: 'flexit-1',
        name: 'Nordic S4 REL A',
        targetTemperature: reportedTargets['flexit-1'],
        measurePower: 1000,
      }),
      'flexit-2': buildTemperatureApiDevice({
        id: 'flexit-2',
        name: 'Nordic S4 REL B',
        targetTemperature: reportedTargets['flexit-2'],
        measurePower: 1000,
      }),
    }));

    const setCapSpy = vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(async (path: string, body?: any) => {
      // Simulate Flexit accepting shed-temp writes but not persisting restore writes.
      const capMatch = path.match(/^manager\/devices\/device\/(.+?)\/capability\/(.+)$/);
      if (capMatch) {
        const [, deviceId, capabilityId] = capMatch;
        const value = body?.value;
        if (capabilityId === 'target_temperature' && typeof value === 'number' && value <= 16) {
          reportedTargets[deviceId] = value;
        }
      }
    });

    const runCycle = async () => {
      await (app as any).powerSamplePipeline.recordPowerSample(samplePowerW);
      vi.advanceTimersByTime(100);
      await flushPromises();
      return getLatestPlanSnapshotForTests() as {
        devices: Array<{ id: string; reason?: string; plannedState: string }>;
      };
    };

    await (app as any).refreshTargetDevicesSnapshot();
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }
    await runCycle();
    expect(reportedTargets['flexit-1']).toBe(16);
    expect(reportedTargets['flexit-2']).toBe(16);

    setCapSpy.mockClear();
    (app as any).planEngine.state.lastInstabilityMs = Date.now() - 180000;
    (app as any).planEngine.state.lastRecoveryMs = Date.now() - 180000;
    (app as any).powerSampleRebuildState = { lastMs: 0 };
    (app as any).computeDynamicSoftLimit = () => 10;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 10);
    }
    if ((app as any).capacityGuard?.setShortfallThresholdProvider) {
      (app as any).capacityGuard.setShortfallThresholdProvider(() => 10);
    }
    (app as any).capacityGuard.isInShortfall = () => false;
    (app as any).planEngine.state.inShortfall = false;
    await (app as any).capacityGuard?.setSheddingActive(false);

    await (app as any).refreshTargetDevicesSnapshot();
    await runCycle();
    const restoreCallsAfterFirstWindow = setCapSpy.mock.calls.filter(
      (call: unknown[]) => (
        typeof call[0] === 'string' && call[0].includes('/capability/target_temperature')
        && (call[1] as any)?.value === 19
      ),
    );
    expect(restoreCallsAfterFirstWindow).toHaveLength(1);

    await (app as any).refreshTargetDevicesSnapshot();
    await runCycle();
    const restoreCallsAfterCooldownWindow = setCapSpy.mock.calls.filter(
      (call: unknown[]) => (
        typeof call[0] === 'string' && call[0].includes('/capability/target_temperature')
        && (call[1] as any)?.value === 19
      ),
    );
    expect(restoreCallsAfterCooldownWindow).toHaveLength(1);

    (app as any).planEngine.state.lastRestoreMs = Date.now() - 180000;
    (app as any).planEngine.state.lastInstabilityMs = Date.now() - 180000;

    await (app as any).refreshTargetDevicesSnapshot();
    await runCycle();

    const restoreCalls = setCapSpy.mock.calls.filter(
      (call: unknown[]) => (
        typeof call[0] === 'string' && call[0].includes('/capability/target_temperature')
        && (call[1] as any)?.value === 19
      ),
    );

    // After one unsuccessful restore attempt, avoid repeated restore writes until retry delay elapses.
    expect(restoreCalls).toHaveLength(1);
  });

});
