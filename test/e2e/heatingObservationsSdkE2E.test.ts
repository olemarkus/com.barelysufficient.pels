// Owner decision: PELS collects passive heating observations for the Main home
// only, and always, whether or not the daily report is turned on; only the
// daily report carries them. A meter area's heaters are not collected.
//
// Driven through the Homey SDK boundary: two heaters (one in Main, one in a
// meter area with its own meter), the real Homey Energy poll, the daily report
// switch in settings, and the report Homey receives.
import type Homey from 'homey';
import {
  mockHomeyInstance, resetMockHomey, setMockDrivers, setMockZones, MockDevice, MockDriver,
} from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { createHomesStore } from '../../lib/home/homeRegistryStore';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, DAILY_DIAGNOSTICS_REPORT, HOMEY_ENERGY_METER_DEVICE_ID,
} from '../../lib/utils/settingsKeys';
import { httpResponse } from '../helpers/httpResponse';
import type { SupportReportDocument } from '../../packages/contracts/src/supportReport';

const homeyLike = mockHomeyInstance as unknown as Homey.App['homey'];
const MINUTE_MS = 60_000;

const buildHeater = async (deviceId: string, zoneId: string) => {
  const device = new MockDevice(
    deviceId, `Heater ${deviceId}`, ['target_temperature', 'measure_temperature', 'measure_power', 'meter_power'],
    'heater',
  );
  device.setZone(zoneId);
  await device.setCapabilityValue('target_temperature', 22);
  await device.setCapabilityValue('measure_temperature', 21);
  await device.setCapabilityValue('measure_power', 1000);
  await device.setCapabilityValue('meter_power', 100);
  return device;
};

const reportedHeaterIds = (document: SupportReportDocument): string[] => {
  const section = document.sections.find((entry) => entry.title === 'Daily heating observations');
  const devices = section?.values.devices;
  if (!Array.isArray(devices)) throw new Error('the daily report carries no heating observations');
  return devices.map((device) => (device as { id: string }).id);
};

describe('passive heating observations (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    // 23:40 in Oslo: collection runs through local midnight before the report is turned on.
    vi.setSystemTime(Date.UTC(2026, 10, 2, 22, 40));
    resetMockHomey();
    setMockZones({ z1: { id: 'z1', name: 'Home', parent: null }, z2: { id: 'z2', name: 'Annex', parent: 'z1' } });
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('collects Main heaters with the daily report off, and the next daily report carries only those', async () => {
    setMockDrivers({ heaters: new MockDriver('heaters', [
      await buildHeater('heater-main', 'z1'), await buildHeater('heater-area', 'z2'),
    ]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, 'm-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 20);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(`${CAPACITY_LIMIT_KW}:h_area`, 20);
    mockHomeyInstance.settings.set('managed_devices', { 'heater-main': true, 'heater-area': true });
    mockHomeyInstance.settings.set('controllable_devices', { 'heater-main': true, 'heater-area': true });
    mockHomeyInstance.settings.set(DAILY_DIAGNOSTICS_REPORT, false);
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live' ? { items: [
        { type: 'cumulative', id: 'm-main', values: { W: 2000 } },
        { type: 'cumulative', id: 'm-area', values: { W: 1000 } },
      ] } : originalGet(path)
    ));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => (
      httpResponse(options?.method === 'POST' ? 'daily-reference' : { origin: 'appstore' })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const posts = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');

    createHomesStore(homeyLike.settings).write({
      subHomes: [{ homeId: 'h_area', name: 'Annex', rootZoneId: 'z2', meterDeviceId: 'm-area' }],
    });

    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();
    // Past local midnight, and past the first daily check, with the report off.
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(posts()).toHaveLength(0);

    mockHomeyInstance.settings.set(DAILY_DIAGNOSTICS_REPORT, true);
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(posts()).toHaveLength(1);
    const { message } = JSON.parse(String(posts()[0]?.[1]?.body)) as { message: string };
    const document = JSON.parse(message.split('\n')[1] ?? '{}') as SupportReportDocument;
    expect(document.trigger).toBe('daily');
    expect(reportedHeaterIds(document)).toEqual(['heater-main']);
  });
});
