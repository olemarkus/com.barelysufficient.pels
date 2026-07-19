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
import type { EvObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

// A plain binary managed+controllable device that WOULD be stamped
// `surplusOnly` on the metered power source when `surplusWilling` — the exact
// shape a sub-home must NOT hold off (it has no surplus signal to satisfy).
const SURPLUS_DEVICE_ID = 'dump-load-1';
const buildSurplusWillingSnapshot = (): TargetDeviceSnapshot & EvObservedProbe => ({
  id: SURPLUS_DEVICE_ID,
  name: 'Dump load',
  targets: [],
  deviceClass: 'socket',
  controlCapabilityId: 'onoff',
  binaryControl: { on: true },
}) as unknown as TargetDeviceSnapshot & EvObservedProbe;

// A ctx whose readers make the surplus posture RESOLVE TRUE on the default path:
// metered power source, managed + controllable, surplusWilling opt-in.
const buildSurplusCtx = (): AppContext => {
  const ctx = createAppContextMock({
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
});
