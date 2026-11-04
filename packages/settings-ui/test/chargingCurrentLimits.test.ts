import { act } from 'preact/test-utils';
import type { SettingsUiDeviceView } from '../src/ui/state.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { SettingsUiRecommendationCar } from '../../contracts/src/settingsUi/carLink.ts';

const getSetting = vi.fn();
const getSettingFresh = vi.fn();
const setSetting = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  getSetting, getSettingFresh, setSetting,
  coldStartReadRetryDelays: () => [], sleep: vi.fn(),
}));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn() }));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn(), showToastError: vi.fn() }));
const { state } = await import('../src/ui/state.ts');
const {
  clearEvCarCurrentLimits, loadEvCarCurrentLimits, renderCarCurrentLimits,
  clearEvChargerCurrentLimits, loadEvChargerCurrentLimits, renderChargerCurrentLimits,
} = await import('../src/ui/deviceDetail/chargingCurrentLimits.tsx');
const car: SettingsUiRecommendationCar = {
  id: 'car-1', name: 'Family car', matchHistory: { state: 'resolved', chargerMatches: [] },
};
const charger = withDescriptorIdentity<SettingsUiDeviceView>({
  id: 'charger-1', name: 'Garage charger', available: true, expectedPowerKw: 7.36,
  expectedPowerSource: 'default', deviceClass: 'evcharger', targets: [],
  controlModel: 'stepped_load', targetPowerConfig: { enabled: true, preset: 'ev_charger_1_phase' },
  steppedLoadProfile: { steps: [
    { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
    { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
    { id: '32a', planningPowerW: 7360, planningCurrentA: 32 },
  ] },
});
const container = () => document.getElementById('editor')!;
const refresh = vi.fn(() => renderCarCurrentLimits(container(), car, charger, refresh));
const field = (bound: 'min' | 'max') => document.getElementById(`car-charging-current-car-1-${bound}`) as HTMLElement & { value: string };
const save = async () => act(async () => container().querySelector<HTMLElement>('md-outlined-button')!.click());
const enter = async (bound: 'min' | 'max', value: string) => act(async () => {
  field(bound).value = value;
  field(bound).dispatchEvent(new Event('input'));
});

beforeEach(() => {
  clearEvCarCurrentLimits();
  clearEvChargerCurrentLimits();
  document.body.innerHTML = '<div id="editor"></div><div id="other-charger"></div><div id="device-detail-charger-current-limits"></div>';
  state.evCarCurrentLimits = {};
  state.evCarCurrentLimitsLoaded = true;
  state.evChargerCurrentLimits = {};
  state.evChargerCurrentLimitsLoaded = true;
  state.managedMap = { [charger.id]: true };
  getSetting.mockReset();
  getSettingFresh.mockReset().mockImplementation(async (key: string) => key === 'ev_charger_current_limits'
    ? state.evChargerCurrentLimits : state.evCarCurrentLimits);
  setSetting.mockReset().mockResolvedValue(undefined);
  refresh.mockClear();
});

test('saves limits for the car and shares them across charger pages', async () => {
  getSettingFresh.mockResolvedValue({ 'other-car': { minA: 6, maxA: 16 } });
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  expect(field('min').value).toBe('6');
  expect(field('max').value).toBe('32');
  expect(container().textContent).toContain('Family car');
  expect(container().textContent).toContain('including other chargers');
  await enter('min', '9');
  await enter('max', '25');
  await save();
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('ev_car_current_limits', {
    'car-1': { minA: 9, maxA: 25 }, 'other-car': { minA: 6, maxA: 16 },
  }));
  const otherCharger = document.getElementById('other-charger')!;
  await act(async () => renderCarCurrentLimits(otherCharger, car, { ...charger, id: 'another-charger' }, vi.fn()));
  expect(otherCharger.querySelector<HTMLElement & { value: string }>('md-filled-text-field[id$="-max"]')?.value).toBe('25');
});

test.each([['', '25'], ['26', '25'], ['8.5', '25'], ['5', '25'], ['8', '33']])(
  'rejects invalid current limits %s–%s without saving', async (minA, maxA) => {
    await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
    await enter('min', minA);
    await enter('max', maxA);
    await save();
    expect(setSetting).not.toHaveBeenCalled();
    expect(container().querySelector('[role="alert"]')?.textContent).toContain('Enter whole amps');
  },
);

test('keeps the draft visible with an error when a save fails', async () => {
  setSetting.mockRejectedValueOnce(new Error('Unavailable'));
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  await enter('max', '25');
  await save();
  await vi.waitFor(() => expect(container().querySelector('[role="alert"]')?.textContent).toContain('could not be saved'));
  expect(field('max').value).toBe('25');
});

test('clears one car range while preserving another car', async () => {
  state.evCarCurrentLimits = { 'car-1': { minA: 9, maxA: 25 }, 'other-car': { minA: 6, maxA: 16 } };
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  const clear = [...container().querySelectorAll<HTMLElement>('md-outlined-button')]
    .find((button) => button.textContent?.includes('Use charger default'))!;
  await act(async () => clear.click());
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('ev_car_current_limits', {
    'other-car': { minA: 6, maxA: 16 },
  }));
  expect(field('min').value).toBe('6');
  expect(field('max').value).toBe('32');
});

test('an unreadable fresh read keeps other saved car ranges', async () => {
  state.evCarCurrentLimits = { 'other-car': { minA: 8, maxA: 16 } };
  getSettingFresh.mockResolvedValue(undefined);
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  await enter('max', '25');
  await save();
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('ev_car_current_limits', {
    'other-car': { minA: 8, maxA: 16 }, 'car-1': { minA: 6, maxA: 25 },
  }));
});

test('retains accepted limits on unavailable reads and clears on an authoritative unset', async () => {
  state.evCarCurrentLimits = { 'car-1': { minA: 9, maxA: 25 } };
  for (const value of [null, [], 'unreadable', { 'car-1': { minA: 9, maxA: 8 } }]) {
    getSetting.mockResolvedValue(value);
    await loadEvCarCurrentLimits();
    expect(state.evCarCurrentLimits).toEqual({ 'car-1': { minA: 9, maxA: 25 } });
  }
  clearEvCarCurrentLimits();
  expect(state.evCarCurrentLimits).toEqual({});
});

test('waits for the settings read before offering an editable range', async () => {
  state.evCarCurrentLimitsLoaded = false;
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  expect(container().textContent).toContain('Loading charging current limits');
  expect(container().querySelector('md-filled-text-field')).toBeNull();
});


test('offers a charger default without requiring a matchable car and preserves other charger defaults', async () => {
  state.evCarAssociations = {};
  state.evChargerCurrentLimits = { 'other-charger': { minA: 6, maxA: 16 } };
  const redraw = () => renderChargerCurrentLimits(charger, redraw);
  await act(async () => redraw());
  const root = document.getElementById('device-detail-charger-current-limits')!;
  const minimum = root.querySelector<HTMLElement & { value: string }>('[id$="-min"]')!;
  const maximum = root.querySelector<HTMLElement & { value: string }>('[id$="-max"]')!;
  await act(async () => {
    minimum.value = '9';
    minimum.dispatchEvent(new Event('input'));
    maximum.value = '16';
    maximum.dispatchEvent(new Event('input'));
  });
  await act(async () => root.querySelector<HTMLElement>('md-outlined-button')!.click());
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('ev_charger_current_limits', {
    'charger-1': { minA: 9, maxA: 16 }, 'other-charger': { minA: 6, maxA: 16 },
  }));
  expect(root.textContent).toContain('cars PELS cannot match');
  expect(state.evCarCurrentLimits).toEqual({});
});

test('a saved car range overrides the displayed default and clearing it returns to that charger default', async () => {
  state.evChargerCurrentLimits = { 'charger-1': { minA: 9, maxA: 16 } };
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  expect(field('min').value).toBe('9');
  expect(field('max').value).toBe('16');
  expect(container().textContent).toContain('Using charger default');
  await enter('min', '12');
  await enter('max', '25');
  await save();
  await vi.waitFor(() => expect(state.evCarCurrentLimits['car-1']).toEqual({ minA: 12, maxA: 25 }));
  expect(container().textContent).toContain('Saved car override');
  const reset = [...container().querySelectorAll<HTMLElement>('md-outlined-button')]
    .find((button) => button.textContent?.includes('Use charger default'))!;
  await act(async () => reset.click());
  await vi.waitFor(() => expect(state.evCarCurrentLimits['car-1']).toBeUndefined());
  expect(field('min').value).toBe('9');
  expect(field('max').value).toBe('16');
  expect(state.evChargerCurrentLimits['charger-1']).toEqual({ minA: 9, maxA: 16 });
});

test('retains charger defaults on unavailable or malformed reads and clears only their map on unset', async () => {
  state.evChargerCurrentLimits = { 'charger-1': { minA: 9, maxA: 16 } };
  state.evCarCurrentLimits = { 'car-1': { minA: 12, maxA: 25 } };
  for (const value of [null, [], { 'charger-1': { minA: 17, maxA: 16 } }]) {
    getSetting.mockResolvedValue(value);
    await loadEvChargerCurrentLimits();
    expect(state.evChargerCurrentLimits).toEqual({ 'charger-1': { minA: 9, maxA: 16 } });
  }
  clearEvChargerCurrentLimits();
  expect(state.evChargerCurrentLimits).toEqual({});
  expect(state.evCarCurrentLimits).toEqual({ 'car-1': { minA: 12, maxA: 25 } });
});

test('hides the charger default for an unmanaged charger', async () => {
  state.managedMap = {};
  await act(async () => renderChargerCurrentLimits(charger, vi.fn()));
  expect(document.getElementById('device-detail-charger-current-limits')!.hidden).toBe(true);
});


test('keeps a saved car override editable while the charger default read is unavailable', async () => {
  state.evCarCurrentLimits = { 'car-1': { minA: 12, maxA: 25 } };
  state.evChargerCurrentLimitsLoaded = false;
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  expect(field('min').value).toBe('12');
  expect(field('max').value).toBe('25');
  expect(container().textContent).toContain('Saved car override');
});

test('clearing a charger default preserves the car override', async () => {
  state.evChargerCurrentLimits = { 'charger-1': { minA: 9, maxA: 16 } };
  state.evCarCurrentLimits = { 'car-1': { minA: 12, maxA: 25 } };
  const redraw = () => renderChargerCurrentLimits(charger, redraw);
  await act(async () => redraw());
  const root = document.getElementById('device-detail-charger-current-limits')!;
  const clear = [...root.querySelectorAll<HTMLElement>('md-outlined-button')]
    .find((button) => button.textContent?.includes('Clear charger default'))!;
  await act(async () => clear.click());
  await vi.waitFor(() => expect(setSetting).toHaveBeenCalledWith('ev_charger_current_limits', {}));
  expect(state.evCarCurrentLimits['car-1']).toEqual({ minA: 12, maxA: 25 });
});

test('a charger using its own published watt levels offers no charger default and says the car range applies elsewhere', async () => {
  const watts = { steps: [
    { id: 'off', planningPowerW: 0 }, { id: '2530w', planningPowerW: 2530 }, { id: '11040w', planningPowerW: 11040 },
  ] };
  const zaptec = withDescriptorIdentity<SettingsUiDeviceView>({
    ...charger, targetPowerConfig: undefined, steppedLoadProfile: watts,
    automaticPowerControl: { mode: 'automatic', profile: watts },
  });
  await act(async () => renderChargerCurrentLimits(zaptec, vi.fn()));
  expect(document.getElementById('device-detail-charger-current-limits')!.hidden).toBe(true);
  await act(async () => renderCarCurrentLimits(container(), car, zaptec, refresh));
  expect(container().textContent).toContain('these limits apply only on other chargers');
  await act(async () => renderCarCurrentLimits(container(), car, charger, refresh));
  expect(container().textContent).not.toContain('apply only on other chargers');
});
