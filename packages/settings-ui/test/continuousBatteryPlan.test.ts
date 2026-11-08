import { act } from 'preact/test-utils';
import type {
  BatteryEfficiencyMeasurement, ContinuousBatteryPlanConfig, ContinuousBatteryPlanRead,
} from '../../contracts/src/continuousBatteryPlan.ts';
import { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } from '../../shared-domain/src/settings/continuousBatteryPlan.ts';
import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';

const callApi = vi.fn();
const getSettingFresh = vi.fn();
const setSetting = vi.fn();
let managed = true;
let powerLimit = true;
let priceUnit = 'EUR';
let cachedDevices: unknown = null;
let efficiency: BatteryEfficiencyMeasurement | undefined;
let otherPlans = true;
vi.mock('../src/ui/homey.ts', () => ({
  callApi: async (method: string, path: string) => path === '/ui_prices'
    ? { priceTimeline: { state: 'ready', priceUnit } }
    : callApi(method, path),
  getApiReadModel: async (path: string) => {
    if (cachedDevices !== null) return cachedDevices;
    const result = await callApi('GET', path);
    cachedDevices = { inverterDevices: [], continuousBatteryPlans: { battery: result, ...(otherPlans ? { first: result, second: result } : {}) },
      batteryEfficiencyMeasurements: efficiency === undefined ? {} : { battery: efficiency } };
    return cachedDevices;
  },
  getSettingFresh: (...args: unknown[]) => getSettingFresh(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
  invalidateApiCache: () => { cachedDevices = null; }, getHomeyTimezone: () => 'Europe/Amsterdam',
}));
vi.mock('../src/ui/prices.ts', () => ({ getPricesReadModel: async () => ({ combinedPrices: { priceUnit } }) }));
vi.mock('../src/ui/state.ts', () => ({
  state: { dryRun: false }, resolveManagedState: () => managed, resolveBatteryPowerLimitOn: () => powerLimit,
}));
vi.mock('../src/ui/homeScopeMembership.ts', () => ({ getHomeIdForUiDevice: () => 'main' }));
vi.mock('../src/ui/deviceDetail/batterySection.ts', () => ({ resolveBatteryManagedHint: () => 'Its own schedule remains in use.' }));
vi.mock('../src/ui/deviceDetail/settingsWrite.ts', () => ({
  createSerializedAsyncRunner: () => <T>(operation: () => Promise<T>) => operation(),
}));
vi.mock('../src/ui/toast.ts', () => ({ formatSettingsError: (error: unknown) => String(error) }));

const { setContinuousBatteryPlanDevice, initContinuousBatteryPlanRefresh } = await import('../src/ui/deviceDetail/continuousBatteryPlan.tsx');
const {
  BATTERY_PLAN_ORDER_LINE, batteryPlanSharedLimitLine, batteryPlanWindows, batteryPlanTimeLabel, readBatteryPlanDraft,
} = await import('../src/ui/views/ContinuousBatteryPlan.tsx');

const config = {
  ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, priceUnit: 'EUR', exportPolicy: { kind: 'household_only' as const },
};
const startsAtMs = Date.parse('2026-10-27T01:00:00Z');
const period = {
  startsAtMs, durationMs: 3_600_000, batteryPowerKW: 1, energyBeforeKWh: 2, energyAfterKWh: 3,
  gridImportKWh: 2, gridExportKWh: 0, importCost: 0.2, exportRevenue: 0, wearCost: 0, reason: 'charge_grid' as const,
  storesSurplus: false,
};
const read: ContinuousBatteryPlanRead = { status: 'planned', config, generatedAtMs: startsAtMs, priceUnit: 'EUR', unpricedSolarExport: false,
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
  cachedDevices = null;
  efficiency = undefined;
  otherPlans = true;
  callApi.mockReset();
  callApi.mockResolvedValue(read);
  getSettingFresh.mockReset().mockResolvedValue({ battery: config });
  setSetting.mockReset().mockResolvedValue(undefined);
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

test('offers the measured efficiency, and Use fills the field for an ordinary save', async () => {
  efficiency = { status: 'measured', roundTripEfficiency: 0.86, cycles: 4 };
  await openBattery();
  expect(document.body.textContent).toContain('Measured round-trip efficiency: 86% over the last 4 full charge cycles.');
  const use = [...document.querySelectorAll<HTMLElement>('md-text-button')].find(entry => entry.textContent === 'Use 86%')!;
  await act(async () => use.click());
  expect(field('Round-trip efficiency (%)').value).toBe('86');
  expect(document.querySelector('.battery-plan-measured md-text-button')).toBeNull();
  expect(setSetting).not.toHaveBeenCalled();
  await act(async () => button('Save battery plan').click());
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('continuous_battery_plan', { battery: { ...config, roundTripEfficiency: 0.86 } }));
});

test('says how far the measurement is, and shows nothing without one', async () => {
  efficiency = { status: 'measuring', cycles: 1, cyclesNeeded: 3 };
  await openBattery();
  expect(document.body.textContent).toContain('1 of 3 full charge cycles so far.');
  await act(async () => setContinuousBatteryPlanDevice(null));
  efficiency = undefined;
  cachedDevices = null;
  await openBattery();
  expect(document.querySelector('.battery-plan-measured')).toBeNull();
});

test('explains the priority order only while other batteries also have the plan on', async () => {
  await openBattery();
  expect(document.body.textContent).toContain(BATTERY_PLAN_ORDER_LINE);
  await act(async () => setContinuousBatteryPlanDevice(null));
  otherPlans = false;
  cachedDevices = null;
  await openBattery();
  expect(document.body.textContent).not.toContain(BATTERY_PLAN_ORDER_LINE);
});

test('a saved plan that cannot run keeps the managed hint', async () => {
  powerLimit = false;
  await openBattery();
  expect(document.body.textContent).toContain('Turn on Power-limit control to let PELS execute the battery plan.');
  expect(document.getElementById('device-detail-managed-hint')?.textContent).not.toContain('PELS plans');
});

test('a waiting plan keeps the managed hint', async () => {
  callApi.mockResolvedValue({ status: 'waiting', config, reason: 'prices_unavailable' });
  await openBattery();
  expect(document.getElementById('device-detail-managed-hint')?.textContent).not.toContain('PELS plans');
});

test('a plan refresh keeps an unsaved reserve edit and saves through the settings channel', async () => {
  await openBattery();
  await act(async () => { field('Minimum reserve (%)').value = '35'; field('Minimum reserve (%)').dispatchEvent(new Event('input')); });
  callApi.mockResolvedValueOnce({ ...read, config: { ...config, minimumReservePercent: 45 } });
  await act(async () => { document.dispatchEvent(new Event('plan-updated')); });
  await vi.waitFor(() => expect(document.body.textContent).toContain('Reserve line: 45%'));
  expect(field('Minimum reserve (%)').value).toBe('35');
  callApi.mockImplementation(async (method: string, _path: string, body: unknown) => method === 'PUT' ? body : read);
  await act(async () => button('Save battery plan').click());
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('continuous_battery_plan', { battery: { ...config, minimumReservePercent: 35 } }));
});

test('explains a power-limit gate and allows disabling an already configured plan', async () => {
  powerLimit = false;
  await openBattery();
  expect(document.body.textContent).toContain('Turn on Power-limit control');
  const toggle = document.querySelector<HTMLElement & { selected: boolean }>('md-switch')!;
  await act(async () => { toggle.selected = false; toggle.dispatchEvent(new Event('change')); });
  expect(button('Save battery plan').hasAttribute('disabled')).toBe(false);
  await act(async () => button('Save battery plan').click());
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('continuous_battery_plan', { battery: { ...config, enabled: false } }));
});

test('manual refresh replaces a cached trajectory with the current owner wait reason', async () => {
  await openBattery();
  callApi.mockResolvedValue({ status: 'waiting', config, reason: 'prices_unavailable' });
  await act(async () => button('Refresh plan').click());
  await vi.waitFor(() => expect(document.body.textContent).toContain('Waiting for electricity prices'));
  expect(document.querySelector('.battery-plan-windows')).toBeNull();
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
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('continuous_battery_plan', { battery: { ...saved, enabled: false } }));
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
  callApi.mockImplementationOnce(() => new Promise<ContinuousBatteryPlanRead>(resolve => { completePrevious = resolve; }))
    .mockResolvedValue({ status: 'waiting', config, reason: 'prices_unavailable' });
  await act(async () => setContinuousBatteryPlanDevice(battery('first')));
  await act(async () => setContinuousBatteryPlanDevice(battery('second')));
  await act(async () => completePrevious(read));
  expect(document.body.textContent).toContain('Waiting for electricity prices');
  expect(document.body.textContent).not.toContain('Charge from grid');
});

test('refuses empty and malformed numeric input rather than saving zeroes', () => {
  expect(readBatteryPlanDraft({ enabled: true, capacity: '', reserve: '20', efficiency: '90', wear: '0.03', sell: false, exportCeiling: '' }, 'EUR')).toBeNull();
  expect(readBatteryPlanDraft({ enabled: true, capacity: '10', reserve: '101', efficiency: '90', wear: '0.03', sell: false, exportCeiling: '' }, 'EUR')).toBeNull();
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
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('continuous_battery_plan', { battery: { ...config, wearCostPerKWh: 3, priceUnit: 'øre' } }));
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

test('reads a selling opt-in only with a valid export limit', () => {
  const draft = { enabled: true, capacity: '10', reserve: '20', efficiency: '90', wear: '0.03', sell: true, exportCeiling: '3' };
  expect(readBatteryPlanDraft(draft, 'EUR')?.exportPolicy).toEqual({ kind: 'price_export', netExportCeilingKW: 3 });
  expect(readBatteryPlanDraft({ ...draft, exportCeiling: '' }, 'EUR')).toBeNull();
  expect(readBatteryPlanDraft({ ...draft, exportCeiling: '0' }, 'EUR')).toBeNull();
  expect(readBatteryPlanDraft({ ...draft, sell: false, exportCeiling: '' }, 'EUR')?.exportPolicy).toEqual({ kind: 'household_only' });
});

test('saves the selling opt-in and its export limit through the settings channel', async () => {
  callApi.mockImplementation(async (method: string, _path: string, body: unknown) => method === 'PUT' ? body : read);
  await openBattery();
  expect(document.querySelector('#device-detail-battery-plan-export-ceiling')).toBeNull();
  const sell = document.querySelector<HTMLElement & { selected: boolean }>('md-switch[aria-label="Sell stored energy when profitable"]')!;
  await act(async () => { sell.selected = true; sell.dispatchEvent(new Event('change')); });
  expect(button('Save battery plan').hasAttribute('disabled')).toBe(true);
  const ceiling = field('Export limit at your meter (kW)');
  await act(async () => { ceiling.value = '4.5'; ceiling.dispatchEvent(new Event('input')); });
  await act(async () => button('Save battery plan').click());
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('continuous_battery_plan', {
    battery: { ...config, exportPolicy: { kind: 'price_export', netExportCeilingKW: 4.5 } },
  }));
});

test.each([
  [{ kind: 'selling', estimatedSavings: 0.4262, netExportCeilingKW: 3 }, 'Estimated 0.43 EUR lower electricity cost than keeping the energy for your home'],
  [{ kind: 'kept_household' }, 'Selling would not lower your cost in this plan'],
  [{ kind: 'waiting', reason: 'export_prices_incomplete' }, 'Selling waits for an export price for every hour of the plan'],
] as const)('says what selling decided for the plan shown (%o)', async (exportDecision, text) => {
  const selling = { ...config, exportPolicy: { kind: 'price_export' as const, netExportCeilingKW: 3 } };
  callApi.mockResolvedValue({ ...read, config: selling, priceUnit: 'EUR/kWh', exportDecision, plan: { ...read.plan, periods: [
    period, { ...period, startsAtMs: startsAtMs + 3_600_000, batteryPowerKW: -2, energyBeforeKWh: 3, energyAfterKWh: 1,
      gridImportKWh: 0, gridExportKWh: 2, reason: 'export_energy' as const },
  ] } });
  await openBattery();
  expect(document.body.textContent).toContain(text);
  expect(document.querySelector('.battery-plan-windows')?.textContent).toContain('Sell to grid');
});

test('says when the plan counts solar export without a price as worth nothing', async () => {
  callApi.mockResolvedValue({ ...read, unpricedSolarExport: true });
  await openBattery();
  await vi.waitFor(() => expect(document.querySelector('.battery-plan-preview')?.textContent)
    .toContain('No export price is set, so the plan counts solar sent to the grid as worth 0'));
});

test('shows no selling line while selling is off', async () => {
  await openBattery();
  const preview = document.querySelector('.battery-plan-preview')?.textContent ?? '';
  expect(preview).not.toContain('Selling');
  expect(preview).not.toContain('No export price is set');
  expect(preview).toContain('Charge from grid');
});

test('names a stricter export limit another battery set, and nothing otherwise', () => {
  const selling = { ...config, exportPolicy: { kind: 'price_export' as const, netExportCeilingKW: 5 } };
  expect(batteryPlanSharedLimitLine({ kind: 'selling', estimatedSavings: 1, netExportCeilingKW: 2 }, selling))
    .toBe('Selling stays within 2 kW at your meter, the lowest export limit set on your batteries.');
  expect(batteryPlanSharedLimitLine({ kind: 'selling', estimatedSavings: 1, netExportCeilingKW: 5 }, selling)).toBeNull();
  expect(batteryPlanSharedLimitLine({ kind: 'kept_household' }, selling)).toBeNull();
});
