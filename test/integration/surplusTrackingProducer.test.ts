// Integration coverage for the surplus-TRACKING producer stamp: the per-device
// price-opt blob + the raw snapshot's modality → the flat
// `PlanInputDevice.surplusTracking` bit, through the REAL `toPlanDevice`.
// Nothing internal is mocked; only the outward AppContext seam is supplied.
//
// The unit tier owns the predicate itself (`test/unit/surplusTracking.test.ts`).
// What is worth proving here is the wiring the predicate cannot see: that one
// `surplusWilling` opt-in routes an EV-preset charger to the tracking modality
// and a plain socket to the dump-load modality, and that the two are never both
// stamped on one device.
import { describe, expect, it } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const CHARGER = 'charger-1';
const SOCKET = 'socket-1';

// The persisted evidence that makes the home's surplus pool reachable — the
// precondition for either posture being stamped at all.
const exportedBefore = { exportDailyTotals: { '2026-08-05': 4 } };

const willingCtx = (deviceId: string) => {
  const ctx = createAppContextMock({
    powerTracker: exportedBefore,
    priceOptimizationSettings: {
      [deviceId]: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true },
    },
  });
  (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => true;
  (ctx as unknown as { isCapacityControlEnabled: () => boolean }).isCapacityControlEnabled = () => true;
  return ctx;
};

const buildChargerSnapshot = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: CHARGER,
  name: 'Charger',
  targets: [],
  deviceClass: 'evcharger',
  controlModel: 'stepped_load',
  steppedLoadProfile: {
    steps: [
      { id: 'off', planningPowerW: 0 },
      { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
      { id: '10a', planningPowerW: 2300, planningCurrentA: 10 },
      { id: '16a', planningPowerW: 3680, planningCurrentA: 16 },
    ],
  },
  ...overrides,
}) as TargetDeviceSnapshot;

const buildSocketSnapshot = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: SOCKET,
  name: 'Pool pump',
  targets: [],
  deviceClass: 'socket',
  binaryCapabilityId: 'onoff',
  binaryControl: { on: false },
  ...overrides,
}) as TargetDeviceSnapshot;

describe('toPlanDevice surplusTracking producer stamp', () => {
  it('stamps surplusTracking for a willing managed stepped charger', () => {
    const device = toPlanDevice(willingCtx(CHARGER), buildChargerSnapshot());
    expect(device.surplusTracking).toBe(true);
  });

  it('routes one opt-in to the modality the device shape earns, never to both', () => {
    // This is the whole point of the third posture: `surplusWilling` is one
    // setting, and the device's own shape picks which of the three modalities it
    // means. A charger must never come back carrying the dump-load hold, and a
    // socket must never come back carrying a ladder ceiling.
    const charger = toPlanDevice(willingCtx(CHARGER), buildChargerSnapshot());
    expect(charger.surplusTracking).toBe(true);
    expect(charger.surplusOnly).toBeUndefined();

    const socket = toPlanDevice(willingCtx(SOCKET), buildSocketSnapshot());
    expect(socket.surplusOnly).toBe(true);
    expect(socket.surplusTracking).toBe(false);
  });

  it('does not stamp a charger that never opted in', () => {
    const ctx = createAppContextMock({ powerTracker: exportedBefore });
    (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => true;
    (ctx as unknown as { isCapacityControlEnabled: () => boolean }).isCapacityControlEnabled = () => true;
    expect(toPlanDevice(ctx, buildChargerSnapshot()).surplusTracking).toBe(false);
  });

  it('does not stamp when the home has never exported and cannot infer curtailment', () => {
    // Same held-forever trap the dump-load posture guards: a ceiling in a home
    // whose pool can never open would clamp the charger to its floor policy
    // permanently, with no time-based escape.
    const ctx = createAppContextMock({
      priceOptimizationSettings: {
        [CHARGER]: { enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true },
      },
    });
    (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => true;
    (ctx as unknown as { isCapacityControlEnabled: () => boolean }).isCapacityControlEnabled = () => true;
    expect(toPlanDevice(ctx, buildChargerSnapshot()).surplusTracking).toBe(false);
  });

  it('does not stamp an unmanaged charger', () => {
    const ctx = willingCtx(CHARGER);
    (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => false;
    expect(toPlanDevice(ctx, buildChargerSnapshot()).surplusTracking).toBe(false);
  });

  it('stamps regardless of plug state — the unplugged case is the allocator\'s to answer', () => {
    // `hasStandingDemand` is deliberately not a gate here. A charger with no car
    // still carries the posture; what it must not do is RESERVE surplus, and
    // that is decided per-cycle from `commandableNow` in the allocator rather
    // than by withholding the posture (see the unit tier).
    const device = toPlanDevice(willingCtx(CHARGER), buildChargerSnapshot());
    expect(device.surplusTracking).toBe(true);
  });
});
