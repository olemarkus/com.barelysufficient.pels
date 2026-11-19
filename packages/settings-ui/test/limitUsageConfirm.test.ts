import type { CapacityScalarSettings } from '../../contracts/src/capacitySettings.ts';
import type { SettingsUiPowerPayload } from '../../contracts/src/settingsUi/power.ts';

const HOUR = 3_600_000;

type FakeDialog = HTMLElement & { open: boolean; returnValue: string; show: () => void };

const stored: CapacityScalarSettings = {
  capacityEnabled: false,
  gridImportLimitKw: 24.84,
  limitKw: 10,
  marginKw: 0.2,
  dryRun: false,
  periodMinutes: 60,
  followMonthPeak: false,
};

const load = async () => {
  vi.resetModules();
  document.body.innerHTML = `
    <md-dialog id="limits-usage-confirm-dialog"></md-dialog>
    <ul id="limits-usage-confirm-findings"></ul>
    <small id="settings-grid-import-usage-alert" hidden></small>`;
  const dialog = document.getElementById('limits-usage-confirm-dialog') as FakeDialog;
  dialog.open = false;
  dialog.show = vi.fn(() => { dialog.open = true; });
  vi.doMock('../src/ui/homey.ts', async (original) => ({
    ...(await original<object>()),
    getHomeyTimezone: () => 'Europe/Paris',
    getSetting: vi.fn().mockResolvedValue(null),
  }));
  const alerts = await import('../src/ui/limitUsageAlerts.ts');
  const now = Date.now();
  const buckets: Record<string, number> = {};
  for (let ago = 1; ago <= 48; ago += 1) buckets[new Date(Math.floor(now / HOUR) * HOUR - ago * HOUR).toISOString()] = 3;
  alerts.publishLimitUsagePower({
    tracker: { buckets, lastPowerW: 2300 },
    readings: { state: 'received', lastPowerUpdateMs: now },
  } as unknown as SettingsUiPowerPayload);
  const close = (value: 'confirm' | 'cancel') => {
    dialog.returnValue = value;
    dialog.open = false;
    dialog.dispatchEvent(new Event('close'));
  };
  return { alerts, dialog, close };
};

const off = { kind: 'off' } as const;

describe('saving a limit below the home usage', () => {
  it('asks before a lowered grid import limit below past hours, and saves on confirm', async () => {
    const { alerts, dialog, close } = await load();
    const decision = alerts.allowLimitsSave({ ...stored, gridImportLimitKw: 0.1, mainFuse: off }, stored);
    expect(dialog.show).toHaveBeenCalled();
    expect(document.getElementById('limits-usage-confirm-findings')?.textContent).toContain('averaged 3.0 kW');
    close('confirm');
    await expect(decision).resolves.toBe(true);
  });

  it('retains recent evidence when a poll fails and expires the original meter reading', async () => {
    const { alerts, dialog, close } = await load();
    const now = Date.now();
    alerts.publishLimitUsagePower({
      tracker: { lastPowerW: 5000 }, readings: { state: 'received', lastPowerUpdateMs: now },
    } as SettingsUiPowerPayload);
    alerts.publishLimitUsagePower(null);
    alerts.publishLimitUsagePower({
      tracker: {}, status: { state: 'unavailable', reason: 'read_failed' }, readings: { state: 'never' },
    } as SettingsUiPowerPayload);
    const change = { ...stored, gridImportLimitKw: 3, mainFuse: off };
    const decision = alerts.allowLimitsSave(change, stored);
    expect(dialog.show).toHaveBeenCalled();
    close('cancel');
    await expect(decision).resolves.toBe(false);
    vi.mocked(dialog.show).mockClear();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + HOUR / 2);
    try {
      alerts.publishLimitUsagePower(null);
      await expect(alerts.allowLimitsSave(change, stored)).resolves.toBe(true);
      expect(dialog.show).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it('skips the confirmation when the reading expired while the form was open', async () => {
    const { alerts, dialog } = await load();
    const sampledAt = Date.now();
    alerts.publishLimitUsagePower({
      tracker: { lastPowerW: 5000 },
      readings: { state: 'received', lastPowerUpdateMs: sampledAt },
    } as SettingsUiPowerPayload);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(sampledAt + HOUR / 2);
    try {
      const decision = alerts.allowLimitsSave({ ...stored, gridImportLimitKw: 3, mainFuse: off }, stored);
      expect(dialog.show).not.toHaveBeenCalled();
      await expect(decision).resolves.toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the saved limits when the owner says so', async () => {
    const { alerts, close } = await load();
    const decision = alerts.allowLimitsSave({ ...stored, gridImportLimitKw: 0.1, mainFuse: off }, stored);
    close('cancel');
    await expect(decision).resolves.toBe(false);
  });

  it('drops a second save while the question is open', async () => {
    const { alerts, close } = await load();
    const first = alerts.allowLimitsSave({ ...stored, gridImportLimitKw: 0.1, mainFuse: off }, stored);
    await expect(alerts.allowLimitsSave({ ...stored, gridImportLimitKw: 0.2, mainFuse: off }, stored))
      .resolves.toBe(false);
    close('cancel');
    await first;
  });

  it('does not ask when the limit was not lowered, or stays above usage', async () => {
    const { alerts, dialog } = await load();
    await expect(alerts.allowLimitsSave({ ...stored, mainFuse: off }, stored)).resolves.toBe(true);
    await expect(alerts.allowLimitsSave({ ...stored, gridImportLimitKw: 12, mainFuse: off }, stored))
      .resolves.toBe(true);
    expect(dialog.show).not.toHaveBeenCalled();
  });

  it('asks for a main fuse turned on below past hours', async () => {
    const { alerts, dialog, close } = await load();
    const decision = alerts.allowLimitsSave(
      { ...stored, gridImportLimitKw: null, mainFuse: { kind: 'on', supply: 'one_phase', amps: 10 } },
      { ...stored, gridImportLimitKw: null },
    );
    expect(dialog.show).toHaveBeenCalled();
    close('confirm');
    await expect(decision).resolves.toBe(true);
  });
});
