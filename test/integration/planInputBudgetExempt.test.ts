// The owner's per-device budget exemption, as the plan-input producer resolves it.
// Every exempt sum counts an exempt device's draw with no gate of its own
// (`sumBudgetExemptMeasuredUsageKw`, `sumBudgetExemptProjectedUsageKw`), so the
// producer answers the whole fact: a load the owner exempted is exempt, a battery
// or solar device never is (its draw is a charge or production, not a load).
import { describe, expect, it } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { deviceControlSettingsFixture } from '../helpers/deviceControlSettingsFixture';
import { withDeviceConfiguration } from '../utils/planTestUtils';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const exemptingCtx = (deviceId: string) => createAppContextMock({
  deviceControlSettings: deviceControlSettingsFixture({ budgetExemptDevices: { [deviceId]: true } }),
});

// Shaped like the producer tests' snapshots (`surplusTrackingProducer.test.ts`):
// the class decides the battery role, `withDeviceConfiguration` resolves the rest.
const snapshot = (overrides: Partial<TargetDeviceSnapshot>): TargetDeviceSnapshot => ({
  name: 'Device',
  targets: [],
  binaryCapabilityId: 'onoff',
  binaryControl: { on: true },
  measuredPowerKw: 1.2,
  ...overrides,
}) as TargetDeviceSnapshot;

describe('plan input budget exemption', () => {
  it('carries the owner\'s exemption for a load', () => {
    const device = toPlanDevice(exemptingCtx('heater'), withDeviceConfiguration(snapshot({ id: 'heater', deviceClass: 'heater' })));
    expect(device.budgetExempt).toBe(true);
  });

  it('never exempts a battery, whatever the stored setting says', () => {
    const device = toPlanDevice(exemptingCtx('battery'), withDeviceConfiguration(snapshot({ id: 'battery', deviceClass: 'battery' })));
    expect(device.isBatteryOrSolar).toBe(true);
    expect(device.budgetExempt).toBe(false);
  });
});
