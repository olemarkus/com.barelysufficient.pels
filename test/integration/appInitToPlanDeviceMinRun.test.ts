/**
 * Coverage for `toPlanDevice`'s minimum-run-time enrichment: the producer seam
 * stamps the resolved effective per-device min-run minutes onto every
 * `PlanInputDevice` so planner consumers read the flat value instead of
 * re-resolving the global toggle/default. The precedence itself is covered in
 * `test/unit/minRunResolution.test.ts`; this proves the value reaches the
 * plan-input device through the producer.
 */
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import type { EvObservedProbe, TargetDeviceSnapshot } from '../../packages/contracts/src/types';

const buildSnapshot = (
  overrides: Partial<TargetDeviceSnapshot & EvObservedProbe> = {},
): TargetDeviceSnapshot & EvObservedProbe => ({
  id: 'heater-1',
  name: 'Water heater',
  targets: [],
  deviceClass: 'heater',
  ...overrides,
}) as TargetDeviceSnapshot;

describe('toPlanDevice — minimum-run-time producer wiring', () => {
  it('leaves minRunMinutes undefined when the feature is unset/off (behaviour parity)', () => {
    const ctx = createAppContextMock();
    const result = toPlanDevice(ctx, buildSnapshot());
    expect(result.minRunMinutes).toBeUndefined();
  });

  it('stamps the resolved global default when the admission toggle is on', () => {
    const ctx = createAppContextMock();
    ctx.energyBudgetAdmissionEnabled = true;
    ctx.defaultMinRunMinutes = 15;
    const result = toPlanDevice(ctx, buildSnapshot());
    expect(result.minRunMinutes).toBe(15);
  });

  it('stamps an explicit per-device override, which wins over the default', () => {
    const ctx = createAppContextMock();
    ctx.energyBudgetAdmissionEnabled = true;
    ctx.defaultMinRunMinutes = 15;
    ctx.deviceMinRunMinutes = { 'heater-1': 30 };
    const result = toPlanDevice(ctx, buildSnapshot());
    expect(result.minRunMinutes).toBe(30);
  });

  it('honours an explicit 0 override (per-device opt-out) even with the toggle on', () => {
    const ctx = createAppContextMock();
    ctx.energyBudgetAdmissionEnabled = true;
    ctx.defaultMinRunMinutes = 15;
    ctx.deviceMinRunMinutes = { 'heater-1': 0 };
    const result = toPlanDevice(ctx, buildSnapshot());
    expect(result.minRunMinutes).toBe(0);
  });
});
