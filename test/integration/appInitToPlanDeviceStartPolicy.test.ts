/**
 * `toPlanDevice` resolves the start policy IN FORCE from the owner's stored
 * policy and Power-limit control (owner ruling, 2026-09-25): with power limiting
 * on, PELS already decides when the device runs, so "Only PELS starts this
 * device" does not apply. The stored policy still travels unchanged, because
 * the plan has to tell a policy the owner withdrew from one that merely stopped
 * applying.
 */
import { describe, expect, it, vi } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { DecoratedDeviceSnapshot, MeasuredPowerObservedProbe } from '../../packages/contracts/src/types';
import { partialDouble } from '../helpers/partialDouble';

const charger = (): DecoratedDeviceSnapshot & MeasuredPowerObservedProbe => (
  partialDouble<DecoratedDeviceSnapshot & MeasuredPowerObservedProbe>({
    id: 'charger',
    name: 'Charger',
    targets: [],
    deviceClass: 'socket',
    binaryControl: { on: false },
    measuredPowerKw: 0,
    measuredPowerObservedAtMs: Date.now(),
  })
);

const planDeviceWith = (powerLimitOn: boolean) => {
  const ctx = createAppContextMock();
  ctx.deviceStartPolicies = { charger: 'pels_only' };
  vi.mocked(ctx.resolveManagedState).mockReturnValue(true);
  vi.mocked(ctx.isCapacityControlEnabled).mockReturnValue(powerLimitOn);
  return toPlanDevice(ctx, charger());
};

describe('toPlanDevice — start policy in force', () => {
  it('applies "Only PELS starts this device" while power limiting is off', () => {
    const device = planDeviceWith(false);

    expect(device.startPolicy).toBe('pels_only');
    expect(device.startPolicyInForce).toBe('pels_only');
    expect(device.control.commandAuthority).toBe(true);
  });

  it('does not apply it while power limiting is on, and keeps the stored policy', () => {
    const device = planDeviceWith(true);

    expect(device.startPolicy).toBe('pels_only');
    expect(device.startPolicyInForce).toBe('unrestricted');
    expect(device.control.commandAuthority).toBe(true);
  });
});
