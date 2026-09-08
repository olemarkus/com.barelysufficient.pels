import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PelsInsightsDeviceUnderTest } from '../helpers/pelsInsightsDeviceHarness';
import { createPlanStatusRegistry } from '../../lib/plan/planStatusRegistry';

vi.mock('homey', async () => {
  const { FakeInsightsDeviceBase: Device } = await import('../helpers/pelsInsightsDeviceHarness.js');
  return { default: { Device } };
});

let PelsInsightsDevice: new () => PelsInsightsDeviceUnderTest & {
  updateFromStatus: (status: unknown) => Promise<void>;
  onInit: () => Promise<void>;
  onUninit: () => Promise<void>;
};
beforeAll(async () => {
  const { loadPelsInsightsDeviceClass } = await import('../helpers/pelsInsightsDeviceHarness.js');
  PelsInsightsDevice = await loadPelsInsightsDeviceClass() as typeof PelsInsightsDevice;
});

const MEASURED_STATUS = {
  headroomKw: 2.4,
  hourlyLimitKw: 6,
  hourlyUsageKwh: 1.2,
  controlledKw: 1.8,
  uncontrolledKw: 1.8,
  powerNowKw: 3.6,
  powerKnown: true,
  priceLevel: 'normal',
  devicesOn: 2,
  devicesOff: 0,
  lastPowerUpdate: 1_700_000_000_000,
};

// The silent-meter fail-closed status: `powerKnown: false` and every measured
// figure omitted (`lib/plan/pelsStatus.ts`, `resolveMeasuredStatusFields`).
const UNMEASURED_STATUS = {
  hourlyLimitKw: 6,
  hourlyUsageKwh: 1.4,
  powerNowKw: null,
  powerKnown: false,
  priceLevel: 'normal',
  devicesOn: 0,
  devicesOff: 2,
  lastPowerUpdate: 1_700_000_000_000,
};

describe('pels_insights — an unmeasured status clears the measured capabilities', () => {
  it('stops charting the last measured headroom and managed/background split once the meter is silent', async () => {
    // Before this, the listener only wrote fields that were present, so the
    // three capabilities kept their last measured values for the whole
    // outage — a dashboard or a Flow on `pels_headroom` then read available
    // power the house did not have (Codex review on PR #2283).
    const device = new PelsInsightsDevice();
    await device.updateFromStatus(MEASURED_STATUS);
    expect(device.capabilityValues.get('pels_headroom')).toBe(2.4);
    expect(device.capabilityValues.get('pels_controlled_power')).toBe(1.8);

    await device.updateFromStatus(UNMEASURED_STATUS);

    expect(device.capabilityValues.get('pels_headroom')).toBeNull();
    expect(device.capabilityValues.get('pels_controlled_power')).toBeNull();
    expect(device.capabilityValues.get('pels_uncontrolled_power')).toBeNull();
    // The hour's bookkeeping is not a measured figure: it keeps updating.
    expect(device.capabilityValues.get('pels_hourly_usage')).toBe(1.4);
    expect(device.capabilityValues.get('pels_devices_off')).toBe(2);
  });

  it('leaves the capabilities alone on a status that carries no measured verdict', async () => {
    // A status with no `powerKnown` at all: absence is not "unmeasured", so the
    // carry-forward rule for a transient miss stands.
    const device = new PelsInsightsDevice();
    await device.updateFromStatus(MEASURED_STATUS);
    await device.updateFromStatus({ ...UNMEASURED_STATUS, powerKnown: undefined });

    expect(device.capabilityValues.get('pels_headroom')).toBe(2.4);
  });
});

describe('pels_insights — the capabilities hear the main home\'s status from the app registry', () => {
  it('reads the published status at init, follows every later main-home publish, and stops at uninit', async () => {
    const planStatuses = createPlanStatusRegistry();
    planStatuses.publish('main', MEASURED_STATUS as never);
    const device = new PelsInsightsDevice();
    device.homey.app = { planStatuses };

    await device.onInit();
    expect(device.capabilityValues.get('pels_headroom')).toBe(2.4);

    // Another home's status is not this device's business.
    planStatuses.publish('h_area', { ...MEASURED_STATUS, headroomKw: 9 } as never);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(device.capabilityValues.get('pels_headroom')).toBe(2.4);

    planStatuses.publish('main', UNMEASURED_STATUS as never);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(device.capabilityValues.get('pels_headroom')).toBeNull();

    await device.onUninit();
    planStatuses.publish('main', MEASURED_STATUS as never);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(device.capabilityValues.get('pels_headroom')).toBeNull();
  });

  it('leaves the capabilities alone when the app shell carries no registry', async () => {
    const device = new PelsInsightsDevice();
    device.homey.app = {};
    await device.onInit();
    expect(device.capabilityValues.has('pels_headroom')).toBe(false);
  });
});
