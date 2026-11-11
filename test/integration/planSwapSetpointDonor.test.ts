/**
 * @vitest-environment node
 */
import { getTestExecutionFacts } from '../utils/planEngineStateFixture';
import {
  getLatestPlanSnapshotForTests, mockHomeyInstance, resetMockHomey, setMockDrivers, MockDevice, MockDriver,
} from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import { reasonText } from '../utils/deviceReasonTestUtils';
import { steerCapacityPace } from '../helpers/capacityPaceFixture';

vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });

/**
 * A restore swap limits its donor the way the donor's shed behaviour limits
 * it. Production 2026-11-11: two panel heaters set to shed by lowering their
 * temperature were switched off as swap donors, and the next build wrote the
 * setback to the heaters already off; their app reverts a target written while
 * off, so PELS kept re-sending it until it reported the control contested.
 */
describe('a swap donor that sheds by temperature', () => {
  beforeEach(() => {
    resetMockHomey(); vi.clearAllTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'performance'] });
    vi.setSystemTime(new Date('2025-01-15T12:10:00Z'));
  });
  afterEach(async () => {
    await cleanupApps(); vi.clearAllTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  });

  it('gets its setback, keeps running, and stays limited while the swap is pending', async () => {
    const spotter = new MockDevice('spotter', 'Spotter', ['onoff']);
    await spotter.setCapabilityValue('onoff', false);
    await spotter.setCapabilityValue('measure_power', 0);
    spotter.setSettings({ load: 50 });
    const heater = new MockDevice('heater', 'Panel heater', ['target_temperature', 'onoff']);
    await heater.setCapabilityValue('target_temperature', 20);
    await heater.setCapabilityValue('measure_temperature', 20);
    await heater.setCapabilityValue('onoff', true);
    await heater.setCapabilityValue('measure_power', 600);
    setMockDrivers({ driverA: new MockDriver('driverA', [spotter, heater]) });
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('operating_mode', 'Home');
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { spotter: 10, heater: 50 } });
    mockHomeyInstance.settings.set('mode_device_targets', { Home: { heater: 20 } });
    mockHomeyInstance.settings.set('overshoot_behaviors', {
      spotter: { action: 'turn_off' },
      heater: { action: 'set_temperature', temperature: 16 },
    });
    mockHomeyInstance.settings.set('managed_devices', { spotter: true, heater: true });
    mockHomeyInstance.settings.set('controllable_devices', { spotter: true, heater: true });

    const app = createApp({ withoutPowerMeasurement: true });
    await app.onInit();
    steerCapacityPace(app, 0.4);
    app.planEngine.state.restoreBackoff.lastInstabilityMs = null;
    getTestExecutionFacts(app.planEngine.state).actuation.lastRestoreMs = null;

    // 0.2 kW of headroom does not fit the spotlights' 0.05 kW plus the restore
    // buffer, so the heater is swapped out for them.
    await app['powerSamplePipeline'].recordPowerSample(200);
    await app.refreshTargetDevicesSnapshot();

    const swapped = getLatestPlanSnapshotForTests().devices.find((d: { id: string }) => d.id === 'heater');
    expect(swapped).toMatchObject({ plannedState: 'shed', shedAction: 'set_temperature', plannedTarget: 16 });
    expect(reasonText(swapped?.reason)).toContain('swapped out for');
    expect(await heater.getCapabilityValue('target_temperature')).toBe(16);
    expect(await heater.getCapabilityValue('onoff')).toBe(true);

    // The next reading: the heater reports its setback, so the spotlights start. Until
    // they draw, the swap they are funded by holds the heater at its setback, as it
    // holds an on/off donor.
    vi.advanceTimersByTime(70_000);
    steerCapacityPace(app, 2);
    await app['powerSamplePipeline'].recordPowerSample(200);
    await app.refreshTargetDevicesSnapshot();
    expect(await spotter.getCapabilityValue('onoff')).toBe(true);
    const pending = getLatestPlanSnapshotForTests().devices.find((d: { id: string }) => d.id === 'heater');
    expect(pending).toMatchObject({ plannedState: 'shed', shedAction: 'set_temperature', plannedTarget: 16 });
    expect(reasonText(pending?.reason)).toBe('swap pending (Spotter)');
    expect(await heater.getCapabilityValue('target_temperature')).toBe(16);
    expect(await heater.getCapabilityValue('onoff')).toBe(true);
  });
});
