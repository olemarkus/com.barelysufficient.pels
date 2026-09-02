import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PelsInsightsDeviceUnderTest } from '../helpers/pelsInsightsDeviceHarness';

vi.mock('homey', async () => {
  const { FakeInsightsDeviceBase: Device } = await import('../helpers/pelsInsightsDeviceHarness.js');
  return { default: { Device } };
});

let PelsInsightsDevice: new () => PelsInsightsDeviceUnderTest & { updateFromStatus: () => Promise<void> };
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
    device.homey.settings.set('pels_status', MEASURED_STATUS);
    await device.updateFromStatus();
    expect(device.capabilityValues.get('pels_headroom')).toBe(2.4);
    expect(device.capabilityValues.get('pels_controlled_power')).toBe(1.8);

    device.homey.settings.set('pels_status', UNMEASURED_STATUS);
    await device.updateFromStatus();

    expect(device.capabilityValues.get('pels_headroom')).toBeNull();
    expect(device.capabilityValues.get('pels_controlled_power')).toBeNull();
    expect(device.capabilityValues.get('pels_uncontrolled_power')).toBeNull();
    // The hour's bookkeeping is not a measured figure: it keeps updating.
    expect(device.capabilityValues.get('pels_hourly_usage')).toBe(1.4);
    expect(device.capabilityValues.get('pels_devices_off')).toBe(2);
  });

  it('leaves the capabilities alone on a blob that predates the signal', async () => {
    // An older persisted blob carries no `powerKnown` at all; absence is not
    // "unmeasured", so the carry-forward rule for a transient miss stands.
    const device = new PelsInsightsDevice();
    device.homey.settings.set('pels_status', MEASURED_STATUS);
    await device.updateFromStatus();
    device.homey.settings.set('pels_status', { ...UNMEASURED_STATUS, powerKnown: undefined });
    await device.updateFromStatus();

    expect(device.capabilityValues.get('pels_headroom')).toBe(2.4);
  });
});
