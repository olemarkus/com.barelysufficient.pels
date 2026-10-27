import { act } from 'preact/test-utils';
import type { ContinuousBatteryPlanConfig, ContinuousBatteryPlanRead } from '../../contracts/src/continuousBatteryPlan.ts';
import { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } from '../../shared-domain/src/settings/continuousBatteryPlan.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUiApi.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';

const callApi = vi.fn();
let managed = true;
let powerLimit = true;
let priceUnit = 'EUR';
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args), getHomeyTimezone: () => 'Europe/Amsterdam',
}));
vi.mock('../src/ui/prices.ts', () => ({ getPricesReadModel: async () => ({ combinedPrices: { priceUnit } }) }));
vi.mock('../src/ui/state.ts', () => ({
  state: { dryRun: false }, resolveManagedState: () => managed, resolveBatteryPowerLimitOn: () => powerLimit,
}));
vi.mock('../src/ui/homeScopeMembership.ts', () => ({ getHomeIdForUiDevice: () => 'main' }));
vi.mock('../src/ui/deviceDetail/batterySection.ts', () => ({ BATTERY_MANAGED_HINT: 'Its own schedule remains in use.' }));
vi.mock('../src/ui/deviceDetail/settingsWrite.ts', () => ({
  createSerializedAsyncRunner: () => <T>(operation: () => Promise<T>) => operation(),
}));
vi.mock('../src/ui/toast.ts', () => ({ formatSettingsError: (error: unknown) => String(error) }));

const { setContinuousBatteryPlanDevice, initContinuousBatteryPlanRefresh } = await import('../src/ui/deviceDetail/continuousBatteryPlan.tsx');
const { batteryPlanWindows, batteryPlanTimeLabel, readBatteryPlanDraft } = await import('../src/ui/views/ContinuousBatteryPlan.tsx');

const config = { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR' };
const startsAtMs = Date.parse('2026-10-27T01:00:00Z');
const period = {
  startsAtMs, durationMs: 3_600_000, batteryPowerKW: 1, energyBeforeKWh: 2, energyAfterKWh: 3,
  gridImportKWh: 2, gridExportKWh: 0, importCost: 0.2, exportRevenue: 0, wearCost: 0, reason: 'charge_grid' as const,
};
const read: ContinuousBatteryPlanRead = { status: 'planned', config, generatedAtMs: startsAtMs, priceUnit: 'EUR',
  plan: { status: 'planned', periods: [period, { ...period, startsAtMs: startsAtMs + 3_600_000,
    energyBeforeKWh: 3, energyAfterKWh: 4 }],
  importCost: 0.4, exportRevenue: 0, wearCost: 0, energyCost: 0.4, terminalEnergyValue: 0,
  objectiveCost: 0.4, terminalEnergyKWh: 4, resolutionKWh: 0.05 } };
const battery = (id = 'battery'): SettingsUiDeviceSnapshot => withDescriptorIdentity<SettingsUiDeviceSnapshot>({
  id, name: 'Sessy', available: true, deviceClass: 'battery', targets: [], capabilities: ['measure_power', 'measure_battery'],
  expectedPowerKw: 2.5, expectedPowerSource: 'default', batteryControl: 'drivable', batteryTakenOver: false,
});

const field = (label: string) => [...document.querySelectorAll<HTMLElement & { value: string; label: string }>('md-filled-text-field')]
  .find(entry => entry.label === label)!;
const button = (text: string) => [...document.querySelectorAll<HTMLElement>('md-filled-button, md-outlined-button')]
  .find(entry => entry.textContent === text)!;

const openBattery = async () => {
  await act(async () => setContinuousBatteryPlanDevice(battery()));
  // The controller's network read is detached from opening the device page.
  // Wait for the visible form, as the browser does, rather than a fixed count
  // of promise turns through callApi + the price read.
  await vi.waitFor(() => expect(document.querySelector('md-switch')).not.toBeNull());
};

beforeAll(() => initContinuousBatteryPlanRefresh());
beforeEach(() => {
  setContinuousBatteryPlanDevice(null);
  document.body.innerHTML = '<section id="device-detail-battery-plan-section"><div id="device-detail-battery-plan"></div></section><small id="device-detail-managed-hint"></small>';
  managed = true;
  powerLimit = true;
  priceUnit = 'EUR';
  callApi.mockReset();
  callApi.mockResolvedValue(read);
});
afterEach(() => act(() => setContinuousBatteryPlanDevice(null)));

test('renders the real trajectory and combines adjacent charge periods into one schedule window', async () => {
  await openBattery();
  expect(document.body.textContent).toContain('Charge from grid');
  expect(document.querySelectorAll('.battery-plan-windows li')).toHaveLength(1);
  expect(document.body.textContent).toContain('Expected 40% charged at the end');
  expect(field('Wear allowance (EUR/kWh)')).toBeDefined();
  expect(document.getElementById('device-detail-managed-hint')?.textContent).toContain('PELS plans charging and household supply');
});

test('a plan refresh keeps an unsaved reserve edit and saves through the owning API', async () => {
  await openBattery();
  await act(async () => { field('Minimum reserve (%)').value = '35'; field('Minimum reserve (%)').dispatchEvent(new Event('input')); });
  callApi.mockResolvedValueOnce({ ...read, config: { ...config, minimumReservePercent: 45 } });
  await act(async () => { document.dispatchEvent(new Event('plan-updated')); });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Reserve line: 45%'));
  expect(field('Minimum reserve (%)').value).toBe('35');
  callApi.mockImplementation(async (method: string, _path: string, body: unknown) => method === 'PUT' ? body : read);
  await act(async () => button('Save battery plan').click());
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_battery_plan/battery', { ...config, minimumReservePercent: 35 });
});

test('explains a power-limit gate and allows disabling an already configured plan', async () => {
  powerLimit = false;
  await openBattery();
  expect(document.body.textContent).toContain('Turn on Power-limit control');
  const toggle = document.querySelector<HTMLElement & { selected: boolean }>('md-switch')!;
  await act(async () => { toggle.selected = false; toggle.dispatchEvent(new Event('change')); });
  expect(button('Save battery plan').hasAttribute('disabled')).toBe(false);
  await act(async () => button('Save battery plan').click());
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_battery_plan/battery', { ...config, enabled: false });
});

test('keeps a successful save clean when reloading its preview fails', async () => {
  await openBattery();
  await act(async () => {
    field('Minimum reserve (%)').value = '35';
    field('Minimum reserve (%)').dispatchEvent(new Event('input'));
  });
  callApi.mockImplementation(async (method: string, _path: string, body: unknown) => {
    if (method === 'PUT') return body;
    throw new Error('Preview unavailable');
  });
  await act(async () => button('Save battery plan').click());
  await vi.waitFor(() => expect(document.body.textContent).toContain('Battery plan saved.'));
  expect(document.body.textContent).toContain('Preview unavailable');
  expect(document.querySelector('.battery-plan-chart')).toBeNull();
  expect(document.querySelector('.battery-plan-windows')).toBeNull();
  expect(document.body.textContent).toContain('Refresh plan to load the updated battery plan.');
  expect(field('Minimum reserve (%)').value).toBe('35');
  expect(button('Save battery plan').hasAttribute('disabled')).toBe(true);
  callApi.mockResolvedValue({ ...read, config: { ...config, minimumReservePercent: 35 } });
  await act(async () => button('Refresh plan').click());
  await vi.waitFor(() => expect(document.querySelector('.battery-plan-windows')).not.toBeNull());
  expect(document.body.textContent).toContain('Reserve line: 35%');
});

test.each(['EUR', 'price units'])('disabling preserves accepted economics when the current unit is %s', async (currentUnit) => {
  priceUnit = currentUnit;
  const saved = { ...config, priceUnit: 'øre', wearCostPerKWh: 3 };
  callApi.mockResolvedValue({ status: 'waiting', config: saved, reason: 'price_unit_changed' });
  await openBattery();
  await act(async () => { field('Usable capacity (kWh)').value = ''; field('Usable capacity (kWh)').dispatchEvent(new Event('input')); });
  const toggle = document.querySelector<HTMLElement & { selected: boolean }>('md-switch')!;
  await act(async () => { toggle.selected = false; toggle.dispatchEvent(new Event('change')); });
  expect(button('Save battery plan').hasAttribute('disabled')).toBe(false);
  await act(async () => button('Save battery plan').click());
  expect(callApi).toHaveBeenCalledWith('PUT', '/ui_battery_plan/battery', { ...saved, enabled: false });
});

test('enabling a saved disabled plan explains a changed wear-cost unit before saving', async () => {
  callApi.mockResolvedValue({ status: 'disabled', config: { ...config, enabled: false, priceUnit: 'øre', wearCostPerKWh: 3 } });
  await openBattery();
  const toggle = document.querySelector<HTMLElement & { selected: boolean }>('md-switch')!;
  await act(async () => { toggle.selected = true; toggle.dispatchEvent(new Event('change')); });
  expect(document.body.textContent).toContain('The electricity price unit changed from øre to EUR');
  expect(document.body.textContent).toContain('Review the wear allowance and save');
  expect(field('Wear allowance (EUR/kWh)').value).toBe('3');
});

test('a slow response for a previous battery cannot paint the newly opened one', async () => {
  let completePrevious!: (value: ContinuousBatteryPlanRead) => void;
  callApi.mockImplementation((_method: string, path: string) => path.endsWith('/first')
    ? new Promise<ContinuousBatteryPlanRead>(resolve => { completePrevious = resolve; })
    : Promise.resolve({ status: 'waiting', config, reason: 'prices_unavailable' }));
  await act(async () => setContinuousBatteryPlanDevice(battery('first')));
  await act(async () => setContinuousBatteryPlanDevice(battery('second')));
  await act(async () => completePrevious(read));
  expect(document.body.textContent).toContain('Waiting for electricity prices');
  expect(document.body.textContent).not.toContain('Charge from grid');
});

test('refuses empty and malformed numeric input rather than saving zeroes', () => {
  expect(readBatteryPlanDraft({ enabled: true, capacity: '', reserve: '20', efficiency: '90', wear: '0.03' }, 'EUR')).toBeNull();
  expect(readBatteryPlanDraft({ enabled: true, capacity: '10', reserve: '101', efficiency: '90', wear: '0.03' }, 'EUR')).toBeNull();
  expect(batteryPlanWindows([period, { ...period, startsAtMs: startsAtMs + 7_200_000 }])).toHaveLength(2);
});

test('blocks enabling while the price unit is unknown', async () => {
  priceUnit = 'price units';
  callApi.mockResolvedValue({ status: 'disabled', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG });
  await openBattery();
  expect(document.body.textContent).toContain('Waiting for the electricity price unit');
  expect(document.querySelector('md-switch')?.hasAttribute('disabled')).toBe(true);
});

test('starts an unbound wear allowance at zero in the current price unit', async () => {
  callApi.mockResolvedValue({ status: 'disabled', config: DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG });
  await openBattery();
  const toggle = document.querySelector<HTMLElement & { selected: boolean }>('md-switch')!;
  await act(async () => { toggle.selected = true; toggle.dispatchEvent(new Event('change')); });
  expect(field('Wear allowance (EUR/kWh)').value).toBe('0');
  expect(document.body.textContent).toContain('0 ignores battery wear');
});

test('binds a reviewed wear allowance to the current price unit on save', async () => {
  priceUnit = 'øre';
  let latest: ContinuousBatteryPlanRead = { status: 'waiting', config, reason: 'price_unit_changed' };
  callApi.mockImplementation(async (method: string, _path: string, body: unknown) => {
    if (method === 'PUT') {
      latest = { status: 'waiting', config: body as ContinuousBatteryPlanConfig, reason: 'battery_unavailable' };
      return body;
    }
    return latest;
  });
  await openBattery();
  expect(document.body.textContent).toContain('The electricity price unit changed. Review the wear allowance');
  await act(async () => { field('Wear allowance (øre/kWh)').value = '3'; field('Wear allowance (øre/kWh)').dispatchEvent(new Event('input')); });
  await act(async () => button('Save battery plan').click());
  await vi.waitFor(() => expect(callApi).toHaveBeenCalledWith('PUT', '/ui_battery_plan/battery', { ...config, wearCostPerKWh: 3, priceUnit: 'øre' }));
});

test('names the next day in a charging window, expected target and chart axis', async () => {
  const eveningAtMs = Date.parse('2026-10-27T22:00:00Z');
  callApi.mockResolvedValue({ ...read, generatedAtMs: eveningAtMs, plan: { ...read.plan, periods: [
    { ...period, startsAtMs: eveningAtMs },
    { ...period, startsAtMs: eveningAtMs + 3_600_000, energyBeforeKWh: 3, energyAfterKWh: 4 },
  ] } });
  await openBattery();
  expect(document.querySelector('.battery-plan-windows')?.textContent).toContain('Today 23:00 – Tomorrow 01:00');
  expect(document.querySelector('.battery-plan-preview .pels-text-status-line')?.textContent).toContain('40% by Tomorrow 01:00');
  expect(document.querySelector('.battery-plan-chart__times')?.textContent).toContain('Today 23:00Tomorrow 01:00');
});

test('uses local calendar days across DST and a dated label beyond tomorrow', () => {
  const generated = Date.parse('2026-10-24T22:30:00Z'); // 00:30 on the 25-hour Amsterdam day.
  expect(batteryPlanTimeLabel(Date.parse('2026-10-25T23:15:00Z'), generated, 'Europe/Amsterdam')).toBe('Tomorrow 00:15');
  expect(batteryPlanTimeLabel(Date.parse('2026-10-26T23:15:00Z'), generated, 'Europe/Amsterdam')).toContain('27 Oct');
});
