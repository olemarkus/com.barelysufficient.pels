import { withDeviceConfiguration } from '../utils/planTestUtils';
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
import { describe, expect, it, vi } from 'vitest';
import { POWER_SOURCE } from '../../lib/utils/settingsKeys';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { TargetDeviceSnapshot } from '../../packages/contracts/src/types';
import type { SurplusPoolReachability } from '../../lib/power/surplusPoolReachable';

const CHARGER = 'charger-1';
const SOCKET = 'socket-1';

// The persisted evidence that makes the home's surplus pool reachable — the
// precondition for either posture being stamped at all.
const exportedBefore = { exportDailyTotals: { '2026-08-05': 4 } };

const willingCtx = (deviceId: string) => {
  const ctx = createAppContextMock({
    powerTracker: exportedBefore,
    priceOptimizationSettings: {
      [deviceId]: {
        enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: 0,
      },
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
  // Chargers and dump loads report their draw; PELS switches a device only
  // with a power reading (`resolveDeviceControlPosture`).
  measuredPowerKw: 0,
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
  measuredPowerKw: 0,
  ...overrides,
}) as TargetDeviceSnapshot;

describe('toPlanDevice surplusTracking producer stamp', () => {
  it('stamps surplusTracking for a willing managed stepped charger', () => {
    const device = toPlanDevice(willingCtx(CHARGER), withDeviceConfiguration(buildChargerSnapshot()));
    expect(device.surplusTracking).toBe(true);
  });

  it('routes one opt-in to the modality the device shape earns, never to both', () => {
    // This is the whole point of the third posture: `surplusWilling` is one
    // setting, and the device's own shape picks which of the three modalities it
    // means. A charger must never come back carrying the dump-load hold, and a
    // socket must never come back carrying a ladder ceiling.
    const charger = toPlanDevice(willingCtx(CHARGER), withDeviceConfiguration(buildChargerSnapshot()));
    expect(charger.surplusTracking).toBe(true);
    expect(charger.surplusOnly).toBeUndefined();

    const socket = toPlanDevice(willingCtx(SOCKET), withDeviceConfiguration(buildSocketSnapshot()));
    expect(socket.surplusOnly).toBe(true);
    expect(socket.surplusTracking).toBe(false);
  });

  it('does not stamp a charger that never opted in', () => {
    const ctx = createAppContextMock({ powerTracker: exportedBefore });
    (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => true;
    (ctx as unknown as { isCapacityControlEnabled: () => boolean }).isCapacityControlEnabled = () => true;
    expect(toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot())).surplusTracking).toBe(false);
  });

  it('does not stamp when the home has never exported and cannot infer curtailment', () => {
    // Same held-forever trap the dump-load posture guards: a ceiling in a home
    // whose pool can never open would clamp the charger to its floor policy
    // permanently, with no time-based escape.
    const ctx = createAppContextMock({
      priceOptimizationSettings: {
        [CHARGER]: {
          enabled: false, cheapDelta: 0, expensiveDelta: 0, surplusWilling: true, surplusDelta: 0,
        },
      },
    });
    // A store that answers: another key is listed, the export bit is not. An
    // empty key list is a flake, which leaves the export latch unreadable.
    vi.mocked(ctx.homey.settings.getKeys).mockReturnValue([POWER_SOURCE]);
    (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => true;
    (ctx as unknown as { isCapacityControlEnabled: () => boolean }).isCapacityControlEnabled = () => true;
    expect(toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot())).surplusTracking).toBe(false);
  });

  it('does not stamp an unmanaged charger', () => {
    const ctx = willingCtx(CHARGER);
    (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => false;
    expect(toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot())).surplusTracking).toBe(false);
  });

  it('stamps regardless of plug state — the unplugged case is the allocator\'s to answer', () => {
    // `hasStandingDemand` is deliberately not a gate here. A charger with no car
    // still carries the posture; what it must not do is RESERVE surplus, and
    // that is decided per-cycle from `commandableNow` in the allocator rather
    // than by withholding the posture (see the unit tier).
    const device = toPlanDevice(willingCtx(CHARGER), withDeviceConfiguration(buildChargerSnapshot()));
    expect(device.surplusTracking).toBe(true);
  });
});

describe('toPlanDevice with "Charge from the grid when the panels stop"', () => {
  const HOLD_MS = 10 * 60_000;

  const gridAfterSunCtx = (gridWhenPanelsStop: boolean) => {
    const ctx = createAppContextMock({
      powerTracker: exportedBefore,
      priceOptimizationSettings: {
        [CHARGER]: {
          enabled: false,
          cheapDelta: 0,
          expensiveDelta: 0,
          surplusWilling: true,
          surplusDelta: 0,
          gridWhenPanelsStop,
        },
      },
    });
    (ctx as unknown as { resolveManagedState: () => boolean }).resolveManagedState = () => true;
    (ctx as unknown as { isCapacityControlEnabled: () => boolean }).isCapacityControlEnabled = () => true;
    // The real owner the Main power pipeline feeds each sample's generation to.
    const pool = ctx.surplusPool as SurplusPoolReachability;
    return { ctx, pool };
  };

  const watts = (value: number) => ({ state: 'measured', watts: value } as const);
  const stopPanels = (pool: SurplusPoolReachability) => {
    pool.observeGeneration(watts(2500), 0);
    // Homey reporting that nothing generates, as it does once the panels go quiet.
    pool.observeGeneration({ state: 'none' }, 60_000);
    pool.observeGeneration({ state: 'none' }, 60_000 + HOLD_MS);
  };

  it('runs the charger as an ordinary managed charger once the panels have stopped', () => {
    const { ctx, pool } = gridAfterSunCtx(true);
    stopPanels(pool);
    const device = toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot()));
    expect(device.surplusTracking).toBe(false);
    expect(device.surplusOnly).toBeUndefined();
  });

  it('follows the surplus while the panels produce', () => {
    const { ctx, pool } = gridAfterSunCtx(true);
    pool.observeGeneration(watts(2500), 0);
    expect(toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot())).surplusTracking).toBe(true);
  });

  it('goes back to following the surplus when production returns', () => {
    const { ctx, pool } = gridAfterSunCtx(true);
    stopPanels(pool);
    pool.observeGeneration(watts(800), 2 * HOLD_MS);
    expect(toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot())).surplusTracking).toBe(true);
  });

  it('keeps waiting for surplus when production is unknown', () => {
    // No production reading this run: PELS does not assume the sun has set.
    const { ctx } = gridAfterSunCtx(true);
    expect(toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot())).surplusTracking).toBe(true);
  });

  it('keeps waiting for surplus at night when the option is off', () => {
    const { ctx, pool } = gridAfterSunCtx(false);
    stopPanels(pool);
    expect(toPlanDevice(ctx, withDeviceConfiguration(buildChargerSnapshot())).surplusTracking).toBe(true);
  });
});
