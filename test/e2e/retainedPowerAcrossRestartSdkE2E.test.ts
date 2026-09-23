// SDK-boundary regression: a device measured only by `meter_power` keeps its
// power reading across an app restart.
//
// A cumulative meter resolves a draw only from TWO dated observations, and its
// meter does not move while the device is off. So a meter-only device PELS had
// switched off before a restart used to come back with no reading at all: no
// power axis, so no power logic could ever switch it back on. The transport now
// persists what it retains (`lib/device/retainedPowerStore.ts`) and restores it
// before its first read.
//
// Driven only through the Homey SDK mock and the app's own userdata database,
// which two apps booted in one test share — that is the restart. Observed
// through the plan the app builds.
import { mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN } from '../../lib/utils/settingsKeys';

vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance', 'Date'] });

const T0 = Date.parse('2026-09-23T10:00:00.000Z');
const MINUTE_MS = 60 * 1000;

const meterOnlyPlug = (params: { on: boolean; kwh: number; meterUpdatedAtMs: number }) => ({
  id: 'plug-1',
  name: 'Panel heater plug',
  class: 'socket',
  virtualClass: 'heater',
  capabilities: ['onoff', 'meter_power'],
  capabilitiesObj: {
    onoff: { id: 'onoff', value: params.on, lastUpdated: params.meterUpdatedAtMs },
    meter_power: { id: 'meter_power', value: params.kwh, lastUpdated: params.meterUpdatedAtMs },
  },
  settings: {},
});

const serveDevices = (device: ReturnType<typeof meterOnlyPlug>) => {
  vi.spyOn(mockHomeyInstance.api, 'get').mockResolvedValue({ [device.id]: device });
};

const plannedPlug = (app: ReturnType<typeof createApp>) => (
  app.planService.getPlanDevices().find((device: { id: string }) => device.id === 'plug-1')
);

describe('retained power across a restart (SDK-boundary e2e)', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.settings.set('managed_devices', { 'plug-1': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'plug-1': true });
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    setMockDrivers({});
    vi.spyOn(homeyApi, 'getEnergyLiveReport').mockResolvedValue({ items: [] });
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance', 'Date'] });
  });

  it('a meter-only device switched off before the restart keeps its power axis after it', async () => {
    // First run: two dated meter observations resolve a 3 kW draw (0.05 kWh in
    // one minute), then the device is off and its meter stops moving.
    vi.setSystemTime(T0);
    const firstRun = createApp();
    await firstRun.onInit();
    serveDevices(meterOnlyPlug({ on: true, kwh: 10, meterUpdatedAtMs: T0 }));
    await firstRun.refreshTargetDevicesSnapshot();

    vi.setSystemTime(T0 + MINUTE_MS);
    serveDevices(meterOnlyPlug({ on: true, kwh: 10.05, meterUpdatedAtMs: T0 + MINUTE_MS }));
    await firstRun.refreshTargetDevicesSnapshot();
    expect(plannedPlug(firstRun)).toEqual(expect.objectContaining({ currentDrawKw: expect.closeTo(3, 6) }));

    vi.setSystemTime(T0 + 3 * MINUTE_MS);
    serveDevices(meterOnlyPlug({ on: false, kwh: 10.05, meterUpdatedAtMs: T0 + MINUTE_MS }));
    await firstRun.refreshTargetDevicesSnapshot();

    // The restart: a new app on the same userdata database. The device is still
    // off and its meter has not moved, so the SDK alone can resolve no draw.
    vi.setSystemTime(T0 + 5 * MINUTE_MS);
    const secondRun = createApp();
    await secondRun.onInit();
    serveDevices(meterOnlyPlug({ on: false, kwh: 10.05, meterUpdatedAtMs: T0 + MINUTE_MS }));
    await secondRun.refreshTargetDevicesSnapshot();

    // The power axis survives the restart, so the power logic can still resume
    // the device. (What draw an off meter-only device carries is the retained
    // value's own question, not the restart's; this spec does not pin it.)
    const plug = plannedPlug(secondRun);
    expect(plug).toBeDefined();
    expect(plug && 'currentDrawKw' in plug).toBe(true);
    expect(plug?.control.commandAuthority).toBe(true);
  });
});
