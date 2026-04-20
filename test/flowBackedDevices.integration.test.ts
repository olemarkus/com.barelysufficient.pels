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
  onoffLastUpdated: string;
  measurePower: number;
  measurePowerLastUpdated: string;
  measurePowerCapabilityId: string;
  capabilities: string[];
}>) => ({
  id: overrides?.id ?? 'binary-1',
  name: overrides?.name ?? 'Binary Relay',
  class: 'socket',
  virtualClass: null,
  capabilities: overrides?.capabilities ?? ['onoff'],
  capabilitiesObj: {
    onoff: {
      id: 'onoff',
      value: overrides?.onoff ?? true,
      ...(typeof overrides?.onoffLastUpdated === 'string' ? { lastUpdated: overrides.onoffLastUpdated } : {}),
    },
    ...(typeof overrides?.measurePower === 'number' ? {
      [overrides?.measurePowerCapabilityId ?? 'measure_power']: {
        id: overrides?.measurePowerCapabilityId ?? 'measure_power',
        value: overrides.measurePower,
        ...(typeof overrides?.measurePowerLastUpdated === 'string'
          ? { lastUpdated: overrides.measurePowerLastUpdated }
          : {}),
      },
    } : {}),
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

  it('admits binary devices only after reported onoff when native power exists', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice({
        capabilities: ['measure_power'],
        measurePower: 1200,
      }),
    });
    const app = createApp();
    await app.onInit();
    await (app as any).refreshTargetDevicesSnapshot();

    expect(getSnapshot().find((device) => device.id === 'binary-1')).toBeUndefined();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });
    const entry = getSnapshot().find((device) => device.id === 'binary-1');
    expect(entry).toEqual(expect.objectContaining({
      id: 'binary-1',
      flowBacked: true,
      currentOn: true,
      measuredPowerKw: 1.2,
      controlCapabilityId: 'onoff',
      canSetControl: true,
    }));
  });

  it('ignores flow reports for capabilities already present natively', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice({
        capabilities: ['onoff', 'measure_power'],
        measurePower: 850,
      }),
    });
    const app = createApp();
    await app.onInit();
    await (app as any).refreshTargetDevicesSnapshot();

    const initialEntry = getSnapshot().find((device) => device.id === 'binary-1');
    expect(initialEntry).toEqual(expect.objectContaining({
      id: 'binary-1',
      measuredPowerKw: 0.85,
    }));
    expect(initialEntry?.flowBacked).toBeUndefined();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });

    expect(getSnapshot().find((device) => device.id === 'binary-1')).toEqual(expect.objectContaining({
      id: 'binary-1',
      currentOn: true,
      measuredPowerKw: 0.85,
    }));
    expect(getSnapshot().find((device) => device.id === 'binary-1')?.flowBacked).toBeUndefined();
  });

  it('admits a binary device when native prefixed power exists and flow reports only onoff', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice({
        capabilities: ['measure_power.l1'],
        measurePowerCapabilityId: 'measure_power.l1',
        measurePower: 400,
      }),
    });
    const app = createApp();
    await app.onInit();
    await (app as any).refreshTargetDevicesSnapshot();

    expect(getSnapshot().find((device) => device.id === 'binary-1')).toBeUndefined();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });

    expect(getSnapshot().find((device) => device.id === 'binary-1')).toEqual(expect.objectContaining({
      id: 'binary-1',
      flowBacked: true,
      currentOn: true,
      measuredPowerKw: 0.4,
      canSetControl: true,
    }));
  });

  it('admits EV chargers only after reported charging and car connected when native power exists', async () => {
    mockHomeyInstance.settings.set(EXPERIMENTAL_EV_SUPPORT_ENABLED, true);
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'ev-1': {
        ...buildEvApiDevice({ capabilities: ['measure_power'] }),
        capabilitiesObj: {
          ...buildEvApiDevice({ capabilities: ['measure_power'] }).capabilitiesObj,
          measure_power: { id: 'measure_power', value: 7200 },
        },
      },
    });
    const app = createApp();
    await app.onInit();
    await (app as any).refreshTargetDevicesSnapshot();

    expect(getSnapshot().find((device) => device.id === 'ev-1')).toBeUndefined();

    await runAction('report_flow_backed_device_evcharger_charging', { device: 'ev-1', state: 'on' });
    expect(getSnapshot().find((device) => device.id === 'ev-1')).toBeUndefined();

    await runAction('report_flow_backed_device_evcharger_car_connected', {
      device: 'ev-1',
      state: 'connected',
    });
    const entry = getSnapshot().find((device) => device.id === 'ev-1');
    expect(entry).toEqual(expect.objectContaining({
      id: 'ev-1',
      flowBacked: true,
      currentOn: true,
      evChargingState: 'plugged_in_charging',
      measuredPowerKw: 7.2,
      controlCapabilityId: 'evcharger_charging',
      canSetControl: true,
    }));
  });

  it('synthesizes a paused EV charging state from car connected plus charging off', async () => {
    mockHomeyInstance.settings.set(EXPERIMENTAL_EV_SUPPORT_ENABLED, true);
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'ev-1': {
        ...buildEvApiDevice({ capabilities: ['measure_power'] }),
        capabilitiesObj: {
          ...buildEvApiDevice({ capabilities: ['measure_power'] }).capabilitiesObj,
          measure_power: { id: 'measure_power', value: 0 },
        },
      },
    });
    const app = createApp();
    await app.onInit();

    await runAction('report_flow_backed_device_evcharger_charging', { device: 'ev-1', state: 'off' });
    await runAction('report_flow_backed_device_evcharger_car_connected', { device: 'ev-1', state: 'connected' });

    expect(getSnapshot().find((device) => device.id === 'ev-1')).toEqual(expect.objectContaining({
      id: 'ev-1',
      currentOn: false,
      evChargingState: 'plugged_in_paused',
      measuredPowerKw: 0,
    }));
  });

  it('updates stored flow-backed state over time while power remains native', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice({
        capabilities: ['measure_power'],
        measurePower: 1200,
      }),
    });
    const app = createApp();
    await app.onInit();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });

    const reportedState = mockHomeyInstance.settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES) as Record<string, Record<string, { value: unknown }>>;
    expect(reportedState['binary-1']?.onoff?.value).toBe(true);

    let entry = getSnapshot().find((device) => device.id === 'binary-1');
    expect(entry).toEqual(expect.objectContaining({
      currentOn: true,
      measuredPowerKw: 1.2,
    }));

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'off' });

    entry = getSnapshot().find((device) => device.id === 'binary-1');
    expect(entry).toEqual(expect.objectContaining({
      currentOn: false,
      measuredPowerKw: 1.2,
    }));
  });

  it('keeps native capability values even when a newer flow report exists', async () => {
    mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, {
      'binary-1': {
        onoff: { value: false, reportedAt: Date.parse('2026-03-20T11:00:00Z'), source: 'flow' },
      },
    });
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice({
        capabilities: ['onoff', 'measure_power'],
        onoff: true,
        measurePower: 200,
      }),
    });
    const app = createApp();
    await app.onInit();
    await (app as any).refreshTargetDevicesSnapshot();

    expect(getSnapshot().find((device) => device.id === 'binary-1')).toEqual(expect.objectContaining({
      id: 'binary-1',
      currentOn: true,
      measuredPowerKw: 0.2,
    }));
    expect(getSnapshot().find((device) => device.id === 'binary-1')?.flowBacked).toBeUndefined();
  });

  it('does not admit EV charging reports without native power support', async () => {
    mockHomeyInstance.settings.set(EXPERIMENTAL_EV_SUPPORT_ENABLED, true);
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'ev-1': buildEvApiDevice(),
    });
    const app = createApp();
    await app.onInit();

    await runAction('report_flow_backed_device_evcharger_charging', { device: 'ev-1', state: 'on' });
    await runAction('report_flow_backed_device_evcharger_car_connected', { device: 'ev-1', state: 'connected' });

    expect(getSnapshot().find((device) => device.id === 'ev-1')).toBeUndefined();
  });

  it('emits refresh requests without mutating reported flow-backed state', async () => {
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice({
        capabilities: ['measure_power'],
        measurePower: 1200,
      }),
    });
    const app = createApp();
    await app.onInit();

    await runAction('report_flow_backed_device_onoff', { device: 'binary-1', state: 'on' });

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

  it('does not emit flow-backed refresh requests for reports that duplicate native capabilities', async () => {
    mockHomeyInstance.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, {
      'binary-1': {
        onoff: { value: true, reportedAt: Date.parse('2026-03-20T11:00:00Z'), source: 'flow' },
      },
    });
    vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({
      'binary-1': buildBinaryApiDevice({
        capabilities: ['onoff', 'measure_power'],
        onoff: true,
        measurePower: 1200,
      }),
    });
    const app = createApp();
    await app.onInit();
    mockHomeyInstance.flow._triggerCardTriggers = {};

    await (app as any).refreshTargetDevicesSnapshot({ targeted: true });

    expect(mockHomeyInstance.flow._triggerCardTriggers.flow_backed_device_refresh_requested).toBeUndefined();
  });
});
