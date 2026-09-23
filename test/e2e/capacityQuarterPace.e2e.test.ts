// SDK-boundary e2e for the Belgian 15-minute capacity pace.
//
// THE RULE THIS TEST ENFORCES: in quarter mode the capacity safe pace never rises
// above the sustainable rate (hard cap minus margin). Energy left unused early in a
// quarter is not spent as a burst later in it: a quarter is too short to wind a
// burst down again, and on the SHS lab that ended every quarter in a batch shed in
// the final seconds (`notes/capacity-periods.md` § "Control rule").
//
// Nothing internal is mocked. Power enters through the real Homey Energy poll
// (`manager/energy/live`), the clock is the faked `Date`, and the only thing asserted
// is what PELS writes back through the SDK (`api.put`). Time is stepped one 10 s
// poll at a time, for the reason given in `capacityEndOfHourDrain.e2e.test.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  CAPACITY_PERIOD_MINUTES,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';

const MIN_MS = 60 * 1000;
const POLL_MS = 10_000;
const HEATER_W = 6000;

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

describe('Belgian quarter safe pace (SDK-boundary e2e)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'performance'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('limits a load above hard cap minus margin in an under-used quarter instead of spending the saved energy', async () => {
    const quarterStartMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    let nowMs = quarterStartMs;
    vi.setSystemTime(nowMs);

    // A 6 kW water heater that is on but idle (thermostat satisfied) until :08.
    const device = new MockDevice('heater', 'Water heater', ['onoff', 'measure_power', 'meter_power'], 'socket');
    await device.setCapabilityValue('onoff', true);
    await device.setCapabilityValue('measure_power', HEATER_W);
    await device.setCapabilityValue('meter_power', 100);
    setMockDrivers({ driverA: new MockDriver('driverA', [device]) });

    mockHomeyInstance.settings.set('power_source', 'homey_energy');
    mockHomeyInstance.settings.set('homey_energy_meter_device_id', 'meter-main');
    mockHomeyInstance.settings.set(CAPACITY_PERIOD_MINUTES, 15);
    mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 5);
    mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0.2);
    mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
    mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
    mockHomeyInstance.settings.set('controllable_devices', { heater: true });
    mockHomeyInstance.settings.set('managed_devices', { heater: true });
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { heater: 1 } });
    mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { heater: { action: 'turn_off' } });

    let heating = false;
    const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/energy/live') {
        const on = (await device.getCapabilityValue('onoff')) === true;
        return { items: [{ type: 'cumulative', id: 'meter-main', values: { W: on && heating ? HEATER_W : 0 } }] };
      }
      return originalGet(path);
    });
    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const heaterShed = (): boolean => putSpy.mock.calls.some((call: unknown[]) => (
      call[0] === 'manager/devices/device/heater/capability/onoff'
      && (call[1] as { value?: unknown } | undefined)?.value === false
    ));

    const app = createApp();
    await app.onInit();

    const stepTo = async (targetMs: number): Promise<void> => {
      while (nowMs < targetMs) {
        const delta = Math.min(POLL_MS, targetMs - nowMs);
        await vi.advanceTimersByTimeAsync(delta);
        nowMs += delta;
        await flushDetached();
      }
    };

    // An idle first half of the quarter: nothing to limit.
    await stepTo(quarterStartMs + 8 * MIN_MS);
    await flushDetached(20);
    expect(heaterShed()).toBe(false);

    // At :08 the heater starts drawing 6 kW. Almost the whole 1.2 kWh allowance is
    // left, so spending it would allow ~10 kW and keep the heater running until
    // about :13. Held at 4.8 kW, the pace limits it on the next readings.
    heating = true;
    await stepTo(quarterStartMs + 9 * MIN_MS);
    await flushDetached(20);
    expect(heaterShed()).toBe(true);
  });
});
