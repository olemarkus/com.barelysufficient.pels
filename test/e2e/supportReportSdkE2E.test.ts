import api from '../../api';
import { mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';
import { httpResponse } from '../helpers/httpResponse';
import type { SupportReportDocument } from '../../packages/contracts/src/supportReport';

describe('manual report through the app API and Homey boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'performance', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 9, 23, 12));
    resetMockHomey();
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('previews persisted activity and sends that exact snapshot only on explicit submission', async () => {
    const device = new MockDevice('heater', 'Hall heater', ['onoff', 'measure_power'], 'socket');
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', 2000);
    setMockDrivers({ sockets: new MockDriver('sockets', [device]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { heater: true });
    mockHomeyInstance.settings.set('controllable_devices', { heater: true });
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 5000 } }] }
        : originalGet(path)
    ));
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => (
      httpResponse(options?.method === 'POST' ? '70f408bd-ec4a-495b-858a-966532d6d2b8' : { origin: 'appstore' })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);

    const preview = await api.support_report_prepare({ homey: app.homey, body: {
      subject: { kind: 'device', homeId: 'main', deviceId: 'heater' },
      problem: 'Heater stayed limited.', expected: 'Resume.', occurredAtMs: Date.now(), historyWindow: 'incident',
    } });
    if (!preview.ok) throw Error(preview.code);
    expect(preview.report.document.activity.state).toBe('available');
    if (preview.report.document.activity.state === 'available') {
      expect(preview.report.document.activity.entries).toContainEqual(expect.objectContaining({ deviceId: 'heater' }));
    }
    // The heater has no smart task, and the report says so rather than leaving it out.
    expect(preview.report.document.sections).toContainEqual({ title: 'Current smart task', values: { exists: false } });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
    const id = preview.report.document.id;
    const sent = await api.support_report_send({ homey: app.homey, params: { id }, body: { consent: true } });
    expect(sent.ok && sent.report.submission).toEqual({
      state: 'sent', reference: '70f408bd-ec4a-495b-858a-966532d6d2b8',
    });
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({ message: preview.report.message });
    await api.support_report_send({ homey: app.homey, params: { id }, body: { consent: true } });
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it.each([200, 400, 408])('sends the daily report only once a day even after HTTP %s', async (status) => {
    const device = new MockDevice('heater', 'Hall heater', ['onoff', 'measure_power'], 'socket');
    await device.setCapabilityValue('onoff', true);
    setMockDrivers({ sockets: new MockDriver('sockets', [device]) });
    mockHomeyInstance.settings.set('managed_devices', { heater: true });
    mockHomeyInstance.settings.set('daily_diagnostics_report', true);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => (
      options?.method === 'POST'
        ? httpResponse(status === 200 ? 'daily-reference' : 'Request failed', status)
        : httpResponse({ origin: 'appstore' })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();
    const posts = () => fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(posts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(posts()).toHaveLength(1);
    const { message } = JSON.parse(String(posts()[0]?.[1]?.body)) as { message: string };
    const document = JSON.parse(message.split('\n')[1] ?? '{}') as SupportReportDocument;
    expect(document.trigger).toBe('daily');
    expect(document.request.subject).toEqual({ kind: 'app', homeId: 'main' });
    if (document.log.state !== 'available') throw new Error('the kept log is missing');
    expect(document.log.lines.map((line) => line.entry.event)).toContain('app_initialized');

    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(21 * 60 * 60 * 1000);
    expect(posts()).toHaveLength(2);
  });
});
