import type { SettingsUiDeviceDetailItem } from '../src/ui/deviceUtils.ts';

/**
 * The charger page's car picker. The list comes from a plain Homey device
 * enumeration, so the API seam is mocked; everything else — the eligibility
 * write, the orphan handling, the status line — is the real controller.
 */

const callApi = vi.fn();
const getSetting = vi.fn();
const setSetting = vi.fn();

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  getSetting: (...args: unknown[]) => getSetting(...args),
  getSettingFresh: (...args: unknown[]) => getSetting(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
  invalidateApiCache: vi.fn(),
}));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn().mockResolvedValue(undefined) }));

const flush = () => new Promise<void>((resolve) => { setTimeout(() => resolve(), 0); });

const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <section id="device-detail-car-section" hidden>
      <div id="device-detail-car-list"></div>
      <p id="device-detail-car-status"></p>
      <small id="device-detail-car-flow-note" hidden></small>
    </section>
  `;
};

const charger = (overrides: Partial<SettingsUiDeviceDetailItem> = {}): SettingsUiDeviceDetailItem => ({
  id: 'charger-1',
  name: 'Elbillader',
  deviceClass: 'evcharger',
  targets: [],
  ...overrides,
} as SettingsUiDeviceDetailItem);

const CARS = [
  { id: 'car-1', name: 'Polestar 3', class: 'car', hasCarAssociationSupport: true },
  // Publishes only one of the two capabilities the probe needs, so it can never
  // be matched — offering it would be offering a tick that does nothing.
  { id: 'car-2', name: 'Old EV', class: 'car', hasCarAssociationSupport: false },
  { id: 'heater-1', name: 'Heater', class: 'heater', hasCarAssociationSupport: false },
];

const rows = () => [...document.querySelectorAll<HTMLInputElement>('#device-detail-car-list input')];
const status = () => document.querySelector('#device-detail-car-status')?.textContent ?? '';
const flowNote = () => document.querySelector('#device-detail-car-flow-note') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  // The DOM handles in `dom.ts` bind at module load, so the module graph is
  // reset before each fixture — otherwise later tests write into detached nodes.
  vi.resetModules();
  buildDom();
  callApi.mockResolvedValue(CARS);
  getSetting.mockResolvedValue({});
  setSetting.mockResolvedValue(undefined);
});

describe('charger car picker', () => {
  it('offers only cars that can actually be matched', async () => {
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    expect(rows().map((input) => input.dataset.carId)).toEqual(['car-1']);
  });

  it('stays hidden for a device that is not a charger', async () => {
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger({ deviceClass: 'heater' }));
    const section = document.querySelector('#device-detail-car-section') as HTMLElement;
    expect(section.hidden).toBe(true);
  });

  it('warns about the Flow card only once a car is ticked', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    renderCarAssociation(charger());
    await flush();
    expect(flowNote().hidden).toBe(true);

    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger());
    await flush();

    expect(flowNote().hidden).toBe(false);
    expect(rows()[0].checked).toBe(true);
  });

  it('writes the ticked car and drops the entry when the last one is cleared', async () => {
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    rows()[0].checked = true;
    rows()[0].dispatchEvent(new Event('change'));
    await flush();
    expect(setSetting).toHaveBeenCalledWith(
      'ev_car_associations',
      { 'charger-1': { carIds: ['car-1'] } },
    );

    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    setSetting.mockClear();
    rows()[0].checked = false;
    rows()[0].dispatchEvent(new Event('change'));
    await flush();
    // An empty set is indistinguishable from "off", so the charger's entry goes
    // away rather than persisting as configured-but-empty.
    expect(setSetting).toHaveBeenCalledWith('ev_car_associations', {});
  });

  it('keeps a ticked car that no longer exists visible so it can be cleared', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1', 'deleted-car'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger());
    await flush();

    expect(rows().map((input) => input.dataset.carId)).toEqual(['car-1', 'deleted-car']);
  });

  it('shows the empty-state hint when Homey returns no devices', async () => {
    // The bug this guards: not caching an empty payload (so a transient blip
    // re-fetches) left `carOptions` null, which the renderer reads as "still
    // loading" — a permanent spinner where the explanation should be.
    callApi.mockResolvedValue([]);
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .toContain('No cars found');
  });

  it('survives a malformed device payload', async () => {
    // The response crosses an API boundary; one bad entry must not take the
    // whole picker down.
    callApi.mockResolvedValue([null, 'nonsense', { id: 42 }, ...CARS]);
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    expect(rows().map((input) => input.dataset.carId)).toEqual(['car-1']);
  });

  it('keeps the last-known selections when the settings read fails', async () => {
    const { loadEvCarAssociations } = await import('../src/ui/deviceDetail/carAssociation.ts');
    const { state } = await import('../src/ui/state.ts');
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();

    getSetting.mockRejectedValue(new Error('transient'));
    await loadEvCarAssociations();

    // Resetting to {} would make the empty map the fallback for the next write,
    // persisting every charger's cars away on the strength of one failed read.
    expect(state.evCarAssociations).toEqual({ 'charger-1': { carIds: ['car-1'] } });
  });

  it('does not render a non-finite battery level', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger({
      associatedCar: {
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging', socPct: NaN,
      },
    }));
    await flush();

    expect(status()).toBe('Polestar 3 · Charging');
  });

  it('stops naming a car as associated once it is unticked', async () => {
    // The payload decoration lags a write by one poll; naming a car the user
    // just removed reads as the write having failed.
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-2'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger({
      associatedCar: {
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging', socPct: 63,
      },
    }));
    await flush();

    expect(status()).toBe('Waiting to match a car');
  });

  it('names the matched car with its state and level', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger({
      associatedCar: {
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging', socPct: 63,
      },
    }));
    await flush();

    expect(status()).toBe('Polestar 3 · Charging · 63 %');
  });

  it('does not claim there is no car while one may still be matching', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger());
    await flush();

    // A match takes a minute or two after plug-in, so the wording says what PELS
    // knows now rather than asserting the car is absent.
    expect(status()).toBe('Waiting to match a car');
  });

  it('does not claim the car is supplying a level before one is matched', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger());
    await flush();

    // Adoption switches on with the TICK, not the match, so this window really
    // has no battery level — saying otherwise would contradict the status line
    // above it and Setup's "Not reported" below it, on one screen.
    expect(flowNote().textContent).toContain('no battery level');
    // Both suppressed sources are named: an owner whose charger reports its own
    // level must not read a Flow-card-only warning and conclude it is free.
    expect(flowNote().textContent).toContain("charger's own reading");
    expect(flowNote().classList.contains('field__hint--alert')).toBe(true);
  });

  it('states calmly where the level comes from once a car is matched', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger({
      associatedCar: {
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging', socPct: 63,
      },
    }));
    await flush();

    expect(flowNote().textContent).toBe('Battery level comes from Polestar 3.');
    // A one-time consequence of a choice, not an ongoing fault: once it works,
    // it stops shouting.
    expect(flowNote().classList.contains('field__hint--alert')).toBe(false);
  });
});
