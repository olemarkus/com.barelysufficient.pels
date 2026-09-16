import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';

const ensureChargerPhasePresetsRead = vi.fn();
const applyManagedOptInControlMode = vi.fn();
const debouncedSetSetting = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/chargerPhasePresets.ts', () => ({
  applyChargerPhasePresetsRead: vi.fn(),
  ensureChargerPhasePresetsRead: () => ensureChargerPhasePresetsRead(),
}));

vi.mock('../src/ui/deviceDetail/targetPowerConfig.ts', () => ({
  applyManagedOptInControlMode: (...args: unknown[]) => applyManagedOptInControlMode(...args),
}));

vi.mock('../src/ui/utils.ts', () => ({ debouncedSetSetting: (...args: unknown[]) => debouncedSetSetting(...args) }));
vi.mock('../src/ui/modes.ts', () => ({ renderPriorities: vi.fn() }));
vi.mock('../src/ui/priceOptimization.ts', () => ({
  renderPriceOptimization: vi.fn(),
  savePriceOptimizationSettings: vi.fn(),
}));
vi.mock('../src/ui/plan.ts', () => ({ refreshPlan: vi.fn() }));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn(), showToastError: vi.fn() }));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn(),
  logSettingsWarn: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  document.body.innerHTML = `
    <div id="device-card-list"></div>
    <div id="empty-state"></div>
    <md-outlined-button id="refresh-button"></md-outlined-button>
  `;
});

it('drops a delayed list opt-in after the owner switches the charger back off', async () => {
  let resolvePhaseRead!: (value: { state: 'resolved'; presets: Record<string, 'ev_charger_3_phase'> }) => void;
  ensureChargerPhasePresetsRead.mockReturnValue(new Promise((resolve) => { resolvePhaseRead = resolve; }));
  const [{ renderDevices }, { state }] = await Promise.all([
    import('../src/ui/devices.ts'),
    import('../src/ui/state.ts'),
  ]);
  const charger: TargetDeviceSnapshot = {
    id: 'easee-1',
    name: 'Driveway charger',
    deviceClass: 'evcharger',
    deviceType: 'onoff',
    expectedPowerKw: 7.36,
    expectedPowerSource: 'default',
    available: true,
    powerCapable: true,
    targets: [],
  };
  state.initialLoadComplete = true;
  state.latestDevices = [charger];
  state.managedMap = {};
  state.controllableMap = {};
  state.priceOptimizationSettings = {};
  state.budgetExemptMap = {};
  renderDevices([charger]);

  const managed = document.querySelector<HTMLElement>('.pels-icon-toggle');
  if (!managed) throw new Error('Managed toggle not found.');
  managed.click();
  managed.click();
  await Promise.resolve();

  resolvePhaseRead({ state: 'resolved', presets: { 'easee-1': 'ev_charger_3_phase' } });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  expect(debouncedSetSetting).toHaveBeenCalledOnce();
  expect(state.managedMap['easee-1']).toBe(false);
  expect(applyManagedOptInControlMode).not.toHaveBeenCalled();
});
