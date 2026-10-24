import { describe, expect, it, vi } from 'vitest';
import {
  writeCapacityOffSetting, writeCapacityPeriodSetting, type CurrentCapacitySettings,
} from '../src/ui/capacitySettingsPersistence.ts';
import type { CapacityScalarSettings } from '../../contracts/src/capacitySettings.ts';
import { setSetting } from '../src/ui/homey.ts';

vi.mock('../src/ui/homey.ts', () => ({ getSetting: vi.fn(), setSetting: vi.fn().mockResolvedValue(undefined) }));

const unchosen: CurrentCapacitySettings = {
  limit: undefined, margin: undefined, dryRun: true, periodMinutes: undefined,
  capacityEnabled: undefined, gridImportEnabled: undefined, gridImportLimitKw: undefined,
};

describe('explicit capacity-period selection', () => {
  it('saves only the period without confirming the built-in hard cap or disabling simulation', async () => {
    await writeCapacityPeriodSetting(unchosen, 15);
    expect(vi.mocked(setSetting).mock.calls).toEqual([['capacity_period_minutes', 15]]);
  });

  it('does not rewrite an already selected period', async () => {
    await writeCapacityPeriodSetting({ ...unchosen, periodMinutes: 15 }, 15);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('reports a failed period write instead of treating the selection as saved', async () => {
    vi.mocked(setSetting).mockRejectedValueOnce(new Error('offline'));
    await expect(writeCapacityPeriodSetting(unchosen, 15)).rejects.toThrow('offline');
  });
});

describe('explicit Capacity limit off', () => {
  const running: CapacityScalarSettings = {
    capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2, dryRun: true, periodMinutes: 60,
  };

  it('writes only the switch, so the built-in hard cap stays unchosen', async () => {
    await writeCapacityOffSetting(running);
    expect(vi.mocked(setSetting).mock.calls).toEqual([['capacity_enabled', false]]);
  });

  it('writes nothing when Capacity limit is already off', async () => {
    await writeCapacityOffSetting({ ...running, capacityEnabled: false });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('reports a failed write instead of treating the limit as off', async () => {
    vi.mocked(setSetting).mockRejectedValueOnce(new Error('offline'));
    await expect(writeCapacityOffSetting(running)).rejects.toThrow('offline');
  });
});
