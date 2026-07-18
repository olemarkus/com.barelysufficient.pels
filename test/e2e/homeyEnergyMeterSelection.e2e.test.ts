// SDK-boundary e2e for the explicitly selected whole-home meter
// (homey_energy_meter_device_id) on the homey_energy power source.
//
// Nothing internal is mocked. The live energy report arrives through the real
// Homey Web API seam (`api.get('manager/energy/live')`) and the observable is
// what PELS writes back through the SDK (`api.put` capability commands): a shed
// happens only when the meter reading PELS resolved is over the cap, so which
// item the selection resolved to is visible purely at the boundary.
//
// Counterpart to test/integration/deviceManagerEnergy.test.ts, which keeps the
// extractor-level cases (finiteness, negative watts, malformed reports).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  HOMEY_ENERGY_METER_DEVICE_ID,
} from '../../lib/utils/settingsKeys';
import { drainUntilCalledWith } from '../utils/asyncDrain';

const cap = (deviceId: string, capability: string) =>
  `manager/devices/device/${deviceId}/capability/${capability}`;

const buildAirtreatmentApiDevice = () => ({
  id: 'airtreatment-1',
  name: 'Panel heater',
  class: 'airtreatment',
  virtualClass: null,
  capabilities: ['measure_power', 'measure_temperature', 'target_temperature', 'fan_mode'],
  capabilitiesObj: {
    measure_power: { id: 'measure_power', value: 245.73 },
    measure_temperature: { id: 'measure_temperature', value: 18, units: '°C' },
    target_temperature: { id: 'target_temperature', value: 19, units: '°C', min: 10, max: 30, step: 0.5 },
    fan_mode: { id: 'fan_mode', value: 'home' },
  },
  settings: {},
});

// Stub the SDK boundary on the two wire paths the app actually GETs — the
// device list and the live energy report — and delegate every other path to the
// real mock so the stub can't mask an unexpected query.
const stubSdk = (liveReportItems: unknown[]) => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: liveReportItems };
    }
    if (path === 'manager/devices/device') {
      return { 'airtreatment-1': buildAirtreatmentApiDevice() };
    }
    return originalGet(path);
  });
};

const enableCapacityWithMeter = (meterDeviceId: string | null) => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  if (meterDeviceId !== null) {
    mockHomeyInstance.settings.set(HOMEY_ENERGY_METER_DEVICE_ID, meterDeviceId);
  }
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 1);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set('managed_devices', { 'airtreatment-1': true });
  mockHomeyInstance.settings.set('controllable_devices', { 'airtreatment-1': true });
};

const tempWrites = (putSpy: ReturnType<typeof vi.spyOn>) =>
  putSpy.mock.calls.filter(
    ([path]: unknown[]) => typeof path === 'string' && path.includes('/capability/target_temperature'),
  );

describe('Whole-home meter selection (SDK-boundary e2e)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: under NODE_ENV=test the plan-rebuild scheduler reads
    // its clock via Date.now(); an unfaked Date runs on real wall-clock while the
    // test drives fake timers and intermittently strands the rebuild.
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 0, 0));
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
    setMockDrivers({});
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the selected device item over the cumulative item', async () => {
    // Cumulative (Homey's whole-home aggregate) says 100 W — no pressure. The
    // selected meter says 5000 W against a 1 kW cap. A shed proves PELS resolved
    // home power from the selected meter, not the cumulative item.
    enableCapacityWithMeter('han-meter');
    stubSdk([
      { type: 'cumulative', id: 'marked-meter', values: { W: 100 } },
      { type: 'device', id: 'han-meter', values: { W: 5000 } },
    ]);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('airtreatment-1', 'target_temperature'), { value: 16 });

    expect(putSpy).toHaveBeenCalledWith(cap('airtreatment-1', 'target_temperature'), { value: 16 });
  });

  it('matches the selected id on a cumulative item (Homey-marked meter stays selectable)', async () => {
    // A device marked "Tracks total home energy consumption" appears ONLY as a
    // cumulative item carrying its real device id — selecting it must still work.
    enableCapacityWithMeter('han-meter');
    stubSdk([
      { type: 'cumulative', id: 'han-meter', values: { W: 5000 } },
    ]);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntilCalledWith(putSpy, cap('airtreatment-1', 'target_temperature'), { value: 16 });

    expect(putSpy).toHaveBeenCalledWith(cap('airtreatment-1', 'target_temperature'), { value: 16 });
  });

  it('never falls back to the cumulative item when the selected meter is missing', async () => {
    // Cumulative says 5000 W — over the cap, a fallback WOULD shed. The selected
    // meter is absent from the report, so PELS must see no reading and stay quiet.
    enableCapacityWithMeter('gone-meter');
    stubSdk([
      { type: 'cumulative', id: 'marked-meter', values: { W: 5000 } },
    ]);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    await app.onInit();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(tempWrites(putSpy)).toHaveLength(0);
  });
});
