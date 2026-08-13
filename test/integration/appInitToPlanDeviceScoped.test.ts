/**
 * Coverage for `toPlanDevice`'s R7b per-home options (`ToPlanDeviceOptions`):
 * a sub-home capacity bundle overrides the surplus posture (capacity-only, no
 * price/surplus signal) and the pending-binary read (its OWN engine, not MAIN's
 * via `ctx.planEngine`). The DEFAULT (no opts / `{}`) must reproduce the pre-R7b
 * behavior byte-for-byte — that byte-identity is the single-home safety proof.
 *
 * Only the SDK seam (settings store + the mock ctx readers) is stubbed; the real
 * producer resolves the flat bits.
 */
import { describe, expect, it, vi, type Mock } from 'vitest';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { POWER_SOURCE } from '../../lib/utils/settingsKeys';
import type { AppContext } from '../../lib/app/appContext';
import type {
  DecoratedDeviceSnapshot,
  EvObservedProbe,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';

// A plain binary managed+controllable device that WOULD be stamped
// `surplusOnly` on the metered power source when `surplusWilling` — the exact
// shape a sub-home must NOT hold off (it has no surplus signal to satisfy).
const SURPLUS_DEVICE_ID = 'dump-load-1';
const buildSurplusWillingSnapshot = (): TargetDeviceSnapshot & EvObservedProbe => ({
  id: SURPLUS_DEVICE_ID,
  expectedPowerKw: 1,
  name: 'Dump load',
  targets: [],
  deviceClass: 'socket',
  binaryCapabilityId: 'onoff',
  binaryControl: { on: true },
}) as unknown as TargetDeviceSnapshot & EvObservedProbe;

// A ctx whose readers make the surplus posture RESOLVE TRUE on the default path:
// metered power source, managed + controllable, surplusWilling opt-in, and a
// home whose surplus pool can actually open (exhibited export) — without that
// last part the producer declines the stamp, because a device stamped on an
// unreachable pool is held OFF forever.
const buildSurplusCtx = (): AppContext => {
  const ctx = createAppContextMock({
    powerTracker: { exportDailyTotals: { '2026-08-05': 4 } },
    priceOptimizationSettings: { [SURPLUS_DEVICE_ID]: { surplusWilling: true, surplusDelta: 1 } as never },
  });
  (ctx.homey.settings.get as Mock).mockImplementation(
    (key: string) => (key === POWER_SOURCE ? 'homey_energy' : undefined),
  );
  ctx.isCapacityControlEnabled = vi.fn(() => true);
  ctx.resolveManagedState = vi.fn(() => true);
  return ctx;
};

describe('toPlanDevice — R7b per-home options', () => {
  it('keeps a disabled temperature-only device fail-closed without inventing binary control', () => {
    const ctx = createAppContextMock();
    ctx.isCapacityControlEnabled = vi.fn(() => true);
    ctx.resolveManagedState = vi.fn(() => true);
    const temperatureOnly = {
      id: 'temperature-only',
      name: 'Temperature-only thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
      capabilities: ['target_temperature', 'measure_temperature'],
      controlModel: 'binary_power',
      temperatureControlDisabled: true,
      expectedPowerKw: 1, expectedPowerSource: 'default',
    } satisfies DecoratedDeviceSnapshot;

    const result = toPlanDevice(ctx, temperatureOnly);

    expect(result.targets).toEqual([]);
    expect('binaryCapabilityId' in result).toBe(false);
    expect(result.canSetControlResolved).toBe(false);
    expect('currentOn' in result).toBe(false);
  });

  it('DEFAULT stamps surplusOnly for a surplusWilling metered dump load (main-home behavior)', () => {
    const ctx = buildSurplusCtx();
    const result = toPlanDevice(ctx, buildSurplusWillingSnapshot());
    expect(result.surplusOnly).toBe(true);
  });

  it('byte-identity guard: no opts === empty opts ({})', () => {
    const ctx = buildSurplusCtx();
    const noOpts = toPlanDevice(ctx, buildSurplusWillingSnapshot());
    const emptyOpts = toPlanDevice(ctx, buildSurplusWillingSnapshot(), {});
    expect(emptyOpts).toEqual(noOpts);
  });

  it('surplusPostureEnabled=false NEVER stamps surplusOnly (sub-home capacity-only)', () => {
    const ctx = buildSurplusCtx();
    const result = toPlanDevice(ctx, buildSurplusWillingSnapshot(), { surplusPostureEnabled: false });
    expect(result.surplusOnly).toBeUndefined();
  });

  it('projects normally when the persisted source key read is suspect — the posture no longer reads it', () => {
    // This used to THROW, aborting the producer cycle so the plan service kept
    // its last-good plan rather than transiently stamping an authoritative Flow
    // posture. That hazard only existed while the posture depended on the power
    // source. It no longer does, so there is nothing left for the abort to
    // protect, and a suspect read of an unrelated key must not fence a device
    // out of its plan.
    const ctx = buildSurplusCtx();
    (ctx.homey.settings.get as Mock).mockReturnValue(undefined);
    vi.spyOn(ctx.homey.settings, 'getKeys').mockReturnValue([POWER_SOURCE]);

    // `priceOptimizationSettings` lives on the context, not the settings store,
    // so the willing opt-in survives a settings read that answers nothing.
    expect(toPlanDevice(ctx, buildSurplusWillingSnapshot()).surplusOnly).toBe(true);
    expect(ctx.homey.settings.set).not.toHaveBeenCalled();
  });

  it('DEFAULT reads MAIN in-flight pending binary command via ctx.planEngine', () => {
    const ctx = buildSurplusCtx();
    ctx.planEngine = {
      getPendingBinaryCommandForDevice: vi.fn(() => ({ desired: true })),
    } as unknown as AppContext['planEngine'];
    const result = toPlanDevice(ctx, buildSurplusWillingSnapshot());
    expect(result.binaryCommandPending).toBe(true);
    expect(result.binaryCommandPendingDesired).toBe(true);
  });

  it('getPendingBinaryCommand override isolates from MAIN pending (sub-home reads its OWN engine)', () => {
    const ctx = buildSurplusCtx();
    // MAIN's engine has a pending command in flight...
    ctx.planEngine = {
      getPendingBinaryCommandForDevice: vi.fn(() => ({ desired: true })),
    } as unknown as AppContext['planEngine'];
    // ...but the sub-home resolver (its OWN, quiescent engine) reports none.
    const result = toPlanDevice(ctx, buildSurplusWillingSnapshot(), {
      getPendingBinaryCommand: () => null,
    });
    expect(result.binaryCommandPending).toBe(false);
    expect(result.binaryCommandPendingDesired).toBeUndefined();
    // The MAIN engine was never consulted for the sub-home read.
    expect(
      (ctx.planEngine as unknown as { getPendingBinaryCommandForDevice: Mock }).getPendingBinaryCommandForDevice,
    ).not.toHaveBeenCalled();
  });

  it('strips raw observed evidence at runtime — the resolved answers are the only answers', () => {
    // The plan contract omits these BY TYPE, but a `...device` spread carries
    // them in memory where any structural consumer (or the test-only settle
    // fallback) could read them as a second answer beside the resolved
    // `currentOn`/`currentState`/`currentDrawKw`. Assert on key PRESENCE, not
    // value: `expect(result.x).toBeUndefined()` cannot tell a stripped key from
    // a carried `undefined`.
    const ctx = buildSurplusCtx();
    const snapshot = {
      ...buildSurplusWillingSnapshot(),
      binaryControl: { on: true },
      binaryControlObservation: {
        observedValue: true,
        capabilityId: 'onoff',
        observedAtMs: 1_000,
        observedCapabilityIds: ['onoff'],
      },
      measuredPowerKw: 0.7,
    } as unknown as TargetDeviceSnapshot & EvObservedProbe;

    const result = toPlanDevice(ctx, snapshot);

    expect('binaryControl' in result).toBe(false);
    expect('binaryControlObservation' in result).toBe(false);
    expect('measuredPowerKw' in result).toBe(false);
    // The producer-resolved answers survive in their place.
    expect('currentOn' in result && result.currentOn).toBe(true);
    expect(result.currentState).toBe('on');
    expect(result.currentDrawKw).toBe(0.7);
  });
});
