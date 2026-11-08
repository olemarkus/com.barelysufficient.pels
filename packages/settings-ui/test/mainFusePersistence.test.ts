import { beforeEach, describe, expect, it, vi } from 'vitest';

const setSetting = vi.fn(async () => undefined);
vi.mock('../src/ui/homey.ts', () => ({ getSetting: vi.fn(), setSetting }));

const {
  resolveCapacityScalars,
  resolveSavedMainFuse,
  writeMainFuseSettings,
} = await import('../src/ui/capacitySettingsPersistence.ts');

const blank = {
  limit: 10, margin: 0.2, dryRun: false, periodMinutes: 60, capacityEnabled: true,
  gridImportEnabled: null, gridImportLimitKw: null, mainFuseSupply: null, mainFuseAmps: null,
};
const running = {
  capacityEnabled: true, gridImportLimitKw: 17.25, limitKw: 10, marginKw: 0.2, dryRun: false, periodMinutes: 60,
} as const;

describe('main fuse persistence', () => {
  beforeEach(() => setSetting.mockClear());

  it('does not show the fuse total as an owner grid import limit', () => {
    const current = { ...blank, mainFuseSupply: 'three_phase_neutral', mainFuseAmps: 25 };
    expect(resolveCapacityScalars(current, running).gridImportLimitKw).toBeNull();
  });

  it('treats a never-written fuse as off', () => {
    expect(resolveSavedMainFuse(blank)).toEqual({ kind: 'off' });
  });

  it('writes the size before the supply', async () => {
    await writeMainFuseSettings(blank, { kind: 'on', supply: 'three_phase_neutral', amps: 25 });
    expect(setSetting.mock.calls).toEqual([['main_fuse_amps', 25], ['main_fuse_supply', 'three_phase_neutral']]);
  });

  it('writes nothing when a never-written fuse stays off', async () => {
    await writeMainFuseSettings(blank, { kind: 'off' });
    expect(setSetting).not.toHaveBeenCalled();
  });
});
