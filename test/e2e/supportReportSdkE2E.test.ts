import api from '../../api';
import {
  mockHomeyInstance, resetMockHomey, setMockDrivers, setMockZones, MockDevice, MockDriver,
} from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW } from '../../lib/utils/settingsKeys';
import { httpResponse } from '../helpers/httpResponse';
import { decodeReportMessage } from '../helpers/supportReportEvidenceFixtures';
import { connectLiveFeed } from '../helpers/liveFeedSocketHarness';
import { pelsCapabilityWrite } from '../helpers/ownCapabilityWrites';
import { drainUntilCalledWith } from '../utils/asyncDrain';

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
    const MB = 1024 * 1024;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      if (String(url).endsWith('/usage')) {
        return httpResponse({ mem: { rss: 139.5 * MB, pss: 84.4 * MB, sharedClean: 55.1 * MB, pssSwap: 0 } });
      }
      return httpResponse(options?.method === 'POST' ? '70f408bd-ec4a-495b-858a-966532d6d2b8' : { origin: 'appstore' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);

    const preview = await api.support_report_prepare({ homey: app.homey, body: {
      subject: { kind: 'device', homeId: 'main', deviceId: 'heater' },
      problem: 'Heater stayed limited.', expected: 'Resume.', occurredAtMs: Date.now(), historyWindow: 'incident',
    } });
    if (!preview.ok) throw Error(preview.code);
    const carried = decodeReportMessage(preview.report.message);
    expect(carried.activity.state).toBe('available');
    if (carried.activity.state === 'available') {
      expect(carried.activity.entries).toContainEqual(expect.objectContaining({ deviceId: 'heater' }));
    }
    // The heater has no smart task, and the report says so rather than leaving it out.
    expect(carried.sections).toContainEqual({ title: 'Current smart task', values: { exists: false } });
    // Every report states the app's memory as Homey measures it.
    expect(carried.sections).toContainEqual({
      title: 'App memory',
      values: expect.objectContaining({
        usage: expect.objectContaining({ rssMb: 139.5, sharedCleanMb: 55.1, swapMb: 0 }),
      }),
    });
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

  it('lists a device PELS does not support with its zone, and requests support for it from what Homey reports', async () => {
    setMockZones({ z1: { id: 'z1', name: 'Home', parent: null }, z2: { id: 'z2', name: 'Basement', parent: 'z1' } });
    const heater = new MockDevice('heater', 'Hall heater', ['onoff', 'measure_power'], 'socket');
    const relay = new MockDevice('relay', 'Water heater relay', ['onoff', 'measure_power'], 'light');
    relay.setZone('z2');
    relay.setDriverIdentity({ ownerUri: 'homey:app:com.knx', driverId: 'switch' });
    await relay.setCapabilityValue('onoff', true);
    await relay.setCapabilityValue('measure_power', 2950);
    setMockDrivers({ sockets: new MockDriver('sockets', [heater]), knx: new MockDriver('knx', [relay]) });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => httpResponse({ origin: 'appstore' })));
    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);

    const devices = await api.homey_devices({ homey: app.homey });
    expect(devices).toContainEqual({
      id: 'relay', name: 'Water heater relay', class: 'light', zoneName: 'Basement', hasTemperature: false, hasPower: true,
    });

    const prepared = await api.support_report_prepare({ homey: app.homey, body: {
      subject: { kind: 'device_support', homeId: 'main', deviceId: 'relay' },
      problem: 'A water heater on a KNX relay.', expected: '', occurredAtMs: Date.now(), historyWindow: 'incident',
    } });
    if (!prepared.ok) throw Error(prepared.code);
    expect(prepared.report.document.subjectName).toBe('Water heater relay');
    expect(decodeReportMessage(prepared.report.message).sections).toContainEqual(expect.objectContaining({
      title: 'Homey device',
      values: expect.objectContaining({
        class: 'light', ownerUri: 'homey:app:com.knx', driverId: 'homey:app:com.knx:switch',
        capabilities: expect.objectContaining({ measure_power: expect.objectContaining({ value: 2950 }) }),
      }),
    }));
    expect(decodeReportMessage(prepared.report.message).sections).toContainEqual(expect.objectContaining({
      title: 'Current Homey devices',
      values: expect.objectContaining({
        devices: expect.arrayContaining([
          expect.objectContaining({ id: 'relay', ownerUri: 'homey:app:com.knx', driverId: 'homey:app:com.knx:switch' }),
        ]),
      }),
    }));
  });

  it('reports the Heatit floor minimum alongside the advertised range, accepted write and reported target', async () => {
    connectLiveFeed();
    const thermostat = new MockDevice('heatit', 'Floor heating',
      ['target_temperature', 'measure_temperature', 'measure_power'], 'thermostat');
    thermostat.setDriverIdentity({ ownerUri: 'homey:app:no.thermofloor', driverId: 'Z-TRM6' });
    thermostat.setSettings({ sensor_mode: '0', floor_sensor_min_temp_limit: 180, password: 'private-password' });
    thermostat.setCapabilityMetadata('target_temperature', { min: 5, max: 40, step: 0.5, units: '°C', setable: true });
    await thermostat.setCapabilityValue('target_temperature', 22);
    await thermostat.setCapabilityValue('measure_temperature', 21);
    await thermostat.setCapabilityValue('measure_power', 2000);
    thermostat.configureCapabilityBehavior('target_temperature', {
      onApiWrite: { updateActual: false, updateApi: false, emitCapabilityEvent: false },
    });
    setMockDrivers({ thermostat: new MockDriver('thermostat', [thermostat]) });
    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set('managed_devices', { heatit: true });
    mockHomeyInstance.settings.set('controllable_devices', { heatit: true });
    mockHomeyInstance.settings.set('overshoot_behaviors', { heatit: { action: 'set_temperature', temperature: 17 } });
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => (
      path === 'manager/energy/live'
        ? { items: [{ type: 'cumulative', id: 'meter-main', values: { W: 5000 } }] }
        : originalGet(path)
    ));
    const put = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(put, 'manager/devices/device/heatit/capability/target_temperature', pelsCapabilityWrite(17));
    await vi.advanceTimersByTimeAsync(1);
    const reportedAtMs = Date.now();
    thermostat.setActualCapabilityValue('target_temperature', 18);
    await vi.advanceTimersByTimeAsync(1);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => httpResponse({ origin: 'appstore' })));

    const prepared = await api.support_report_prepare({ homey: app.homey, body: {
      subject: { kind: 'device_support', homeId: 'main', deviceId: 'heatit' },
      problem: 'The floor heater reported 18 °C after a 17 °C request.',
      expected: '', occurredAtMs: Date.now(), historyWindow: 'incident',
    } });
    if (!prepared.ok) throw Error(prepared.code);
    const report = decodeReportMessage(prepared.report.message);
    const deviceSettings = { state: 'available', values: {
      sensor_mode: { value: 'F' }, floor_sensor_min_temp_limit: { value: 18, unit: '°C' },
    } };
    const targetTemperature = {
      min: 5, max: 40, step: 0.5, units: '°C', setable: true, value: 18, lastUpdatedMs: reportedAtMs,
    };
    expect(report.sections.find(({ title }) => title === 'Homey device')?.values).toMatchObject({
      id: 'heatit', deviceSettings, capabilities: { target_temperature: targetTemperature },
    });
    expect(report.sections.find(({ title }) => title === 'Current Homey devices')?.values).toMatchObject({
      devices: [{ id: 'heatit', deviceSettings, targetTemperature }],
    });
    expect(JSON.stringify(report)).not.toContain('private-password');
    if (report.log.state !== 'available') throw new Error('Device write log is unavailable');
    expect(report.log.lines.map((line) => line.entry)).toContainEqual(expect.objectContaining({
      event: 'target_command_applied', deviceId: 'heatit', target: 'temperature', targetValue: 17,
    }));
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
    // A report is gzipped on the real thread pool, which fake timers do not wait for.
    const expectSends = (count: number) => vi.waitFor(() => expect(posts()).toHaveLength(count), { timeout: 10_000 });

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(posts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await expectSends(1);
    const { message } = JSON.parse(String(posts()[0]?.[1]?.body)) as { message: string };
    const document = decodeReportMessage(message);
    expect(document.trigger).toBe('daily');
    expect(document.request.subject).toEqual({ kind: 'app', homeId: 'main' });
    if (document.log.state !== 'available') throw new Error('the kept log is missing');
    expect(document.log.lines.map((line) => line.entry.event)).toContain('app_initialized');

    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(21 * 60 * 60 * 1000);
    await expectSends(2);
  });
});
