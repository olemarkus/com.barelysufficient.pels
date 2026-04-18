import { createApp, cleanupApps } from './utils/appTestUtils';
import { mockHomeyInstance, setMockDrivers } from './mocks/homey';
import type { TargetDeviceSnapshot } from '../lib/utils/types';
import { EXPERIMENTAL_EV_SUPPORT_ENABLED, FLOW_REPORTED_DEVICE_CAPABILITIES } from '../lib/utils/settingsKeys';

vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'] });

const flushPromises = () => new Promise((resolve) => process.nextTick(resolve));

const buildBinaryApiDevice = (overrides?: Partial<{
  id: string;
  name: string;
  onoff: boolean;
  capabilities: string[];
}>) => ({
  id: overrides?.id ?? 'binary-1',
  name: overrides?.name ?? 'Binary Relay',
  class: 'socket',
  virtualClass: null,
  capabilities: overrides?.capabilities ?? ['onoff'],
  capabilitiesObj: {
    onoff: { id: 'onoff', value: overrides?.onoff ?? true },
  },
  settings: {},
});

const buildEvApiDevice = (overrides?: Partial<{
  id: string;
  name: string;
  capabilities: string[];
  evchargerCharging: boolean;
  evchargerChargingState: string;
}>) => ({
  id: overrides?.id ?? 'ev-1',
  name: overrides?.name ?? 'Garage Charger',
  class: 'evcharger',
  virtualClass: null,
  capabilities: overrides?.capabilities ?? ['evcharger_charging'],
  capabilitiesObj: {
    evcharger_charging: { id: 'evcharger_charging', value: overrides?.evchargerCharging ?? false },
    ...(typeof overrides?.evchargerChargingState === 'string' ? {
      evcharger_charging_state: {
        id: 'evcharger_charging_state',
        value: overrides.evchargerChargingState,
      },
    } : {}),
  },
  settings: {},
});

function getSnapshot(): TargetDeviceSnapshot[] {
  return (mockHomeyInstance.settings.get('target_devices_snapshot') as TargetDeviceSnapshot[]) ?? [];
}

async function runAction(cardId: string, args: Record<string, unknown>): Promise<void> {
  await mockHomeyInstance.flow._actionCardListeners[cardId](args);
  await flushPromises();
}

describe('Flow-backed device support', () => {
  beforeEach(() => {
    setMockDrivers({});
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._actionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._conditionCardAutocompleteListeners = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('admits binary devices only after reported onoff plus measure_power', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice(),
    });
    const app = createApp();
    await app.onInit();
    await (app as any).refreshTargetDevicesSnapshot();

    expect(getSnapshot().find((device) => device.id === 'binary-1')).toBeUndefined();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });
    expect(getSnapshot().find((device) => device.id === 'binary-1')).toBeUndefined();

    await runAction('report_flow_backed_device_power', { device: 'binary-1', power_w: 1200 });
    const entry = getSnapshot().find((device) => device.id === 'binary-1');
    expect(entry).toEqual(expect.objectContaining({
      id: 'binary-1',
      flowBacked: true,
      currentOn: true,
      measuredPowerKw: 1.2,
      controlCapabilityId: 'onoff',
    }));
  });

  it('admits EV chargers only after reported charging, charging state, and measure_power', async () => {
    mockHomeyInstance.settings.set(EXPERIMENTAL_EV_SUPPORT_ENABLED, true);
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'ev-1': buildEvApiDevice(),
    });
    const app = createApp();
    await app.onInit();
    await (app as any).refreshTargetDevicesSnapshot();

    expect(getSnapshot().find((device) => device.id === 'ev-1')).toBeUndefined();

    await runAction('report_flow_backed_device_evcharger_charging', { device: 'ev-1', state: 'on' });
    expect(getSnapshot().find((device) => device.id === 'ev-1')).toBeUndefined();

    await runAction('report_flow_backed_device_power', { device: 'ev-1', power_w: 7200 });
    expect(getSnapshot().find((device) => device.id === 'ev-1')).toBeUndefined();

    await runAction('report_flow_backed_device_evcharger_state', {
      device: 'ev-1',
      state: 'plugged_in_charging',
    });
    const entry = getSnapshot().find((device) => device.id === 'ev-1');
    expect(entry).toEqual(expect.objectContaining({
      id: 'ev-1',
      flowBacked: true,
      currentOn: true,
      evChargingState: 'plugged_in_charging',
      measuredPowerKw: 7.2,
      controlCapabilityId: 'evcharger_charging',
    }));
  });

  it('updates stored flow-backed state over time without inferring binary state from power alone', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice(),
    });
    const app = createApp();
    await app.onInit();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });
    await runAction('report_flow_backed_device_power', { device: 'binary-1', power_w: 1200 });

    await runAction('report_flow_backed_device_power', { device: 'binary-1', power_w: 0 });

    const reportedState = mockHomeyInstance.settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES) as Record<string, Record<string, { value: unknown }>>;
    expect(reportedState['binary-1']?.measure_power?.value).toBe(0);

    let entry = getSnapshot().find((device) => device.id === 'binary-1');
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      measuredPowerKw: 0,
    }));

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'off' });

    entry = getSnapshot().find((device) => device.id === 'binary-1');
    expect(entry).toEqual(expect.objectContaining({
      currentOn: false,
      measuredPowerKw: 0,
    }));
  });

  it('does not infer EV charging state from power alone before admission', async () => {
    mockHomeyInstance.settings.set(EXPERIMENTAL_EV_SUPPORT_ENABLED, true);
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'ev-1': buildEvApiDevice(),
    });
    const app = createApp();
    await app.onInit();

    await runAction('report_flow_backed_device_power', { device: 'ev-1', power_w: 7200 });

    expect(getSnapshot().find((device) => device.id === 'ev-1')).toBeUndefined();
  });

  it('emits refresh requests without mutating reported flow-backed state', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice(),
    });
    const app = createApp();
    await app.onInit();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });
    await runAction('report_flow_backed_device_power', { device: 'binary-1', power_w: 1200 });

    const beforeStore = structuredClone(
      mockHomeyInstance.settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES) as Record<string, unknown>,
    );
    const beforeSnapshot = structuredClone(getSnapshot());

    await (app as any).refreshTargetDevicesSnapshot({ targeted: true });

    expect(mockHomeyInstance.flow._triggerCardTriggers.flow_backed_device_refresh_requested).toEqual([
      { tokens: {}, state: { deviceId: 'binary-1' } },
    ]);
    expect(mockHomeyInstance.settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES)).toEqual(beforeStore);
    expect(getSnapshot()).toEqual(beforeSnapshot);
  });
});
