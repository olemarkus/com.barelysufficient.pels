import { describe, expect, it } from 'vitest';
import {
  buildOverviewDeviceRows,
  type SettingsUiOverviewDevice,
} from '../src/ui/overviewDeviceRows.ts';
import type { PlanDeviceSnapshot, PlanSnapshot } from '../src/ui/planTypes.ts';

const device = (
  overrides: Partial<SettingsUiOverviewDevice> & { id: string },
): SettingsUiOverviewDevice => ({
  name: overrides.id,
  targets: [],
  available: true,
  ...overrides,
} as SettingsUiOverviewDevice);

const planDevice = (id: string): PlanDeviceSnapshot => ({
  id,
  name: id,
  controllable: true,
  available: true,
  currentDrawKw: 0,
  expectedPowerKw: 0,
  boostActive: false,
  reason: { code: 'keep', detail: null },
} as unknown as PlanDeviceSnapshot);

const plan = (ids: string[]): PlanSnapshot => (
  { devices: ids.map(planDevice) } as unknown as PlanSnapshot
);

describe('buildOverviewDeviceRows', () => {
  it('lists a device PELS is managing but has not decided on yet', () => {
    // The state before the first power reading. The device list is known; the
    // plan is not. Rendering nothing here is what made a missing CONTROL
    // artefact look like a missing device.
    const rows = buildOverviewDeviceRows({ devices: [device({ id: 'heater' })], plan: null });

    expect(rows).toEqual([{ kind: 'undecided', device: expect.objectContaining({ id: 'heater' }) }]);
  });

  it('carries no plan fields at all on an undecided row', () => {
    // Not defaulted, absent — so nothing downstream can read a decision that
    // was never made.
    const [row] = buildOverviewDeviceRows({ devices: [device({ id: 'heater' })], plan: null });

    expect(row).not.toHaveProperty('plan');
  });

  it('joins each device to its own plan row by id', () => {
    const rows = buildOverviewDeviceRows({
      devices: [device({ id: 'a' }), device({ id: 'b' })],
      plan: plan(['b', 'a']),
    });

    expect(rows.map((row) => row.kind === 'decided' && row.plan.id)).toEqual(['a', 'b']);
  });

  it('includes an implicitly-managed device, matching the runtime planned set', () => {
    // `isRuntimePlannedDevice` is `managed !== false`. A device the owner never
    // toggled has no flag and IS planned — keying on `=== true` would omit a
    // device PELS is actively controlling.
    const rows = buildOverviewDeviceRows({
      devices: [device({ id: 'implicit' }), device({ id: 'explicit', managed: true })],
      plan: null,
    });

    expect(rows.map((row) => row.device.id)).toEqual(['implicit', 'explicit']);
  });

  it('excludes a device the owner opted out of', () => {
    const rows = buildOverviewDeviceRows({
      devices: [device({ id: 'opted-out', managed: false })],
      plan: null,
    });

    expect(rows).toEqual([]);
  });

  it('orders by the priority the device list carries', () => {
    const rows = buildOverviewDeviceRows({
      devices: [
        device({ id: 'third', priority: 3 }),
        device({ id: 'first', priority: 1 }),
        device({ id: 'unset' }),
      ],
      plan: null,
    });

    expect(rows.map((row) => row.device.id)).toEqual(['first', 'third', 'unset']);
  });

  it('drops a plan row whose device the list does not carry', () => {
    // The two payloads refresh independently. The device channel owns
    // membership, so a plan row it has not caught up to is not rendered.
    const rows = buildOverviewDeviceRows({
      devices: [device({ id: 'known' })],
      plan: plan(['known', 'stale-ghost']),
    });

    expect(rows.map((row) => row.device.id)).toEqual(['known']);
  });
});
