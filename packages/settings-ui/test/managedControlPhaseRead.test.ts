import type { SettingsUiDeviceView } from '../src/ui/state.ts';

const ensureChargerPhasePresetsRead = vi.fn();
const applyManagedOptInControlMode = vi.fn();
const writeFreshSetting = vi.fn();
const showToast = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/chargerPhasePresets.ts', () => ({
  ensureChargerPhasePresetsRead: () => ensureChargerPhasePresetsRead(),
}));

vi.mock('../src/ui/deviceDetail/targetPowerConfig.ts', () => ({
  applyManagedOptInControlMode: (...args: unknown[]) => applyManagedOptInControlMode(...args),
}));

vi.mock('../src/ui/deviceDetail/settingsWrite.ts', () => ({
  createSerializedAsyncRunner: () => async (operation: () => Promise<unknown>) => operation(),
  readRecordSettingStrict: vi.fn(),
  writeFreshSetting: (...args: unknown[]) => writeFreshSetting(...args),
}));

vi.mock('../src/ui/devices.ts', () => ({ renderDevices: vi.fn() }));
vi.mock('../src/ui/toast.ts', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  document.body.innerHTML = `
    <md-switch id="device-detail-managed"></md-switch>
    <md-switch id="device-detail-controllable"></md-switch>
  `;
});

it('does not persist a new EV Managed opt-in while charger wiring is unavailable', async () => {
  ensureChargerPhasePresetsRead.mockResolvedValue({ state: 'unavailable' });
  const [{ initDeviceDetailManagedControlHandlers }, { state }] = await Promise.all([
    import('../src/ui/deviceDetail/managedControl.ts'),
    import('../src/ui/state.ts'),
  ]);
  state.latestDevices = [{
    id: 'easee-1',
    name: 'Driveway charger',
    deviceClass: 'evcharger',
    expectedPowerKw: 7.36,
    expectedPowerSource: 'default',
    available: true,
    targets: [],
  } as SettingsUiDeviceView];

  initDeviceDetailManagedControlHandlers(
    () => 'easee-1',
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  const managed = document.getElementById('device-detail-managed') as HTMLElement & { selected: boolean };
  managed.selected = true;
  managed.dispatchEvent(new Event('change'));
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  expect(ensureChargerPhasePresetsRead).toHaveBeenCalledOnce();
  expect(writeFreshSetting).not.toHaveBeenCalled();
  expect(applyManagedOptInControlMode).not.toHaveBeenCalled();
  expect(managed.selected).toBe(false);
  expect(showToast).toHaveBeenCalledWith(
    'Could not read the charger wiring. Refresh devices and try again.',
    'warn',
  );
});

it('drops a delayed EV opt-in after a newer opt-out intent', async () => {
  let resolvePhaseRead!: (value: { state: 'resolved'; presets: Record<string, 'ev_charger_1_phase'> }) => void;
  ensureChargerPhasePresetsRead.mockReturnValue(new Promise((resolve) => { resolvePhaseRead = resolve; }));
  writeFreshSetting.mockResolvedValue({ 'easee-1': false });
  const [{ initDeviceDetailManagedControlHandlers }, { state }] = await Promise.all([
    import('../src/ui/deviceDetail/managedControl.ts'),
    import('../src/ui/state.ts'),
  ]);
  state.latestDevices = [{
    id: 'easee-1',
    name: 'Driveway charger',
    deviceClass: 'evcharger',
    expectedPowerKw: 7.36,
    expectedPowerSource: 'default',
    available: true,
    targets: [],
  } as SettingsUiDeviceView];

  initDeviceDetailManagedControlHandlers(
    () => 'easee-1',
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  const managed = document.getElementById('device-detail-managed') as HTMLElement & { selected: boolean };
  managed.selected = true;
  managed.dispatchEvent(new Event('change'));
  managed.selected = false;
  managed.dispatchEvent(new Event('change'));
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  resolvePhaseRead({ state: 'resolved', presets: { 'easee-1': 'ev_charger_1_phase' } });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  expect(writeFreshSetting).toHaveBeenCalledOnce();
  expect(applyManagedOptInControlMode).not.toHaveBeenCalled();
});
