import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerOverviewRecommendationDismissals,
  resolveOverviewControlWarnings,
} from '../src/ui/overviewControlWarnings.ts';
import type { SetupRecommendation } from '../src/ui/recommendationsModel.ts';
import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import { buildOverviewDeviceRows } from '../src/ui/overviewDeviceRows.ts';

const device = (sinceMs = 1000): SettingsUiDeviceListItem => withDescriptorIdentity({
  id: 'heater', name: 'Hall heater', managed: true, available: true, targets: [],
  expectedPowerKw: 1, expectedPowerSource: 'default',
  controlContest: { setting: 'temperature', commanded: 22, observed: 28, count: 4, sinceMs },
});

const resolvedRoster = (devices: readonly SettingsUiDeviceListItem[]) => ({
  state: 'resolved' as const,
  rows: buildOverviewDeviceRows({ devices, plan: null }),
});

const warningsFor = (devices: readonly SettingsUiDeviceListItem[]) => (
  resolveOverviewControlWarnings(resolvedRoster(devices))
);

describe('Overview control warnings', () => {
  const dismiss = vi.fn<(recommendation: SetupRecommendation) => Promise<void>>().mockResolvedValue(undefined);
  beforeEach(() => {
    dismiss.mockClear();
    registerOverviewRecommendationDismissals({ read: () => 'active', dismiss });
  });

  it('uses only the displayed managed roster, including a device without a plan', () => {
    const shown = device();
    const roster = resolvedRoster([shown, { ...device(), id: 'unmanaged', managed: false }]);
    expect(roster.rows.map((row) => row.device.id)).toEqual(['heater']);
    const warnings = resolveOverviewControlWarnings(roster);
    expect([...warnings.keys()]).toEqual(['heater']);
    expect(warnings.get('heater')?.recommendation).toMatchObject({
      id: 'control-contest:heater', version: 1000,
      title: "Hall heater doesn't keep PELS's changes",
      category: 'warning',
      target: { kind: 'device', deviceId: 'heater', focus: 'control-contest' },
    });
    expect(warningsFor([]).size).toBe(0);
  });

  it('hides dismissed episodes and shows the next one', () => {
    registerOverviewRecommendationDismissals({
      read: (recommendation) => recommendation.version === 1000 ? 'dismissed' : 'active', dismiss,
    });
    expect(warningsFor([device()]).size).toBe(0);
    expect(warningsFor([device(2000)]).get('heater')?.onDismiss).toBeDefined();
  });

  it('does not flash a dismissed warning while acknowledgements are loading', () => {
    registerOverviewRecommendationDismissals({ read: () => 'loading', dismiss });
    expect(warningsFor([device()]).size).toBe(0);
  });

  it('shows the warning without a dismiss action when acknowledgements cannot be read', () => {
    registerOverviewRecommendationDismissals({ read: () => 'unavailable', dismiss });
    const warning = warningsFor([device()]).get('heater');
    expect(warning?.recommendation.version).toBe(1000);
    expect(warning?.onDismiss).toBeUndefined();
  });

  it('captures the shown episode when dismissal waits behind another operation', async () => {
    const earlier = warningsFor([device()]).get('heater');
    warningsFor([device(2000)]);
    await earlier?.onDismiss?.();
    expect(dismiss).toHaveBeenCalledWith(expect.objectContaining({ version: 1000 }));
  });

  it.each(['loading', 'unavailable'] as const)('shows no warnings while the roster is %s', (state) => {
    expect(resolveOverviewControlWarnings({ state }).size).toBe(0);
  });
});
