import type { SettingsUiDeviceDetailItem } from '../src/ui/deviceUtils.ts';

/**
 * The charger page's car picker. The list comes from backend-resolved car
 * candidates, so the API seam is mocked; everything else — the eligibility
 * write, the orphan handling, the status line — is the real controller.
 */

const callApi = vi.fn();
const getSetting = vi.fn();
const getSettingFresh = vi.fn();
const setSetting = vi.fn();
const sleep = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApi(...args),
  getSetting: (...args: unknown[]) => getSetting(...args),
  getSettingFresh: (...args: unknown[]) => getSettingFresh(...args),
  sleep: (...args: unknown[]) => sleep(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
  invalidateApiCache: vi.fn(),
  getHomeyTimezone: () => 'Europe/Oslo',
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
  isEvCharger: true,
  targets: [],
  ...overrides,
} as SettingsUiDeviceDetailItem);

const CARS = [
  { id: 'car-1', name: 'Polestar 3', matchHistory: { state: 'resolved', chargerMatches: [] } },
];

// 2026-10-03 18:20 UTC: still 3 Oct in Oslo.
const MATCHED_AT_MS = Date.UTC(2026, 9, 3, 18, 20);

const matchedTo = (chargerId: string) => ({
  state: 'resolved' as const,
  chargerMatches: [{ chargerId, lastMatchedAtMs: MATCHED_AT_MS }],
});

const rows = () => [...document.querySelectorAll<HTMLInputElement>('#device-detail-car-list input')];
const status = () => document.querySelector('#device-detail-car-status')?.textContent ?? '';
const flowNote = () => document.querySelector('#device-detail-car-flow-note') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  // The DOM handles in `dom.ts` bind at module load, so the module graph is
  // reset before each fixture — otherwise later tests write into detached nodes.
  vi.resetModules();
  buildDom();
  callApi.mockResolvedValue({ state: 'resolved', cars: CARS });
  getSetting.mockResolvedValue({});
  getSettingFresh.mockResolvedValue(undefined);
  setSetting.mockResolvedValue(undefined);
});

describe('charger car picker', () => {
  it('offers the backend-resolved eligible cars without repeating eligibility checks', async () => {
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    expect(rows().map((input) => input.dataset.carId)).toEqual(['car-1']);
    expect(callApi).toHaveBeenCalledWith('GET', '/ui_recommendation_cars');
  });

  it('offers and saves eligible Kia and Hyundai vehicles', async () => {
    callApi.mockResolvedValue({
      state: 'resolved',
      // The resolved endpoint returns only id/name and match history, including
      // for `vehicle` devices. Requiring class or capability metadata here drops these cars.
      cars: [
        { id: 'hyundai-vehicle', name: 'Hyundai Ioniq 5', matchHistory: { state: 'resolved', chargerMatches: [] } },
        { id: 'kia-vehicle', name: 'Kia EV6', matchHistory: { state: 'resolved', chargerMatches: [] } },
      ],
    });
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    expect(rows().map((input) => input.dataset.carId)).toEqual(['hyundai-vehicle', 'kia-vehicle']);
    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .toContain('Hyundai Ioniq 5');
    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .toContain('Kia EV6');

    for (const carId of ['hyundai-vehicle', 'kia-vehicle']) {
      const input = rows().find((row) => row.dataset.carId === carId)!;
      input.checked = true;
      input.dispatchEvent(new Event('change'));
      await flush();
    }
    expect(setSetting).toHaveBeenLastCalledWith('ev_car_associations', {
      'charger-1': { carIds: ['hyundai-vehicle', 'kia-vehicle'] },
    });
  });

  it('stays hidden for a device that is not a charger', async () => {
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger({ deviceClass: 'heater', isEvCharger: false }));
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

  it('shows the empty-state hint when the backend resolves no eligible cars', async () => {
    // The bug this guards: not caching an empty payload (so a transient blip
    // re-fetches) left `carOptions` null, which the renderer reads as "still
    // loading" — a permanent spinner where the explanation should be.
    callApi.mockResolvedValue({ state: 'resolved', cars: [] });
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .toContain('No cars found');
  });

  it.each([
    { state: 'unavailable' },
    { state: 'resolved', cars: [null, 'nonsense', { id: 42 }, ...CARS] },
  ])('shows an unavailable hint and retries an unresolved car read: %j', async (read) => {
    callApi.mockResolvedValue(read);
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    expect(rows()).toHaveLength(0);
    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .toContain('Could not load cars');
    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .not.toContain('No cars found');

    callApi.mockResolvedValue({ state: 'resolved', cars: CARS });
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
    expect(state.evCarAssociationsLoaded).toBe(true);
  });

  it('keeps the last-known selections when a live reload remains absent after retries', async () => {
    const { loadEvCarAssociations, renderCarAssociation } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    const { state } = await import('../src/ui/state.ts');
    getSetting.mockResolvedValueOnce({ 'other-charger': { carIds: ['car-2'] } });
    await loadEvCarAssociations();

    getSetting.mockResolvedValueOnce(undefined);
    getSettingFresh.mockResolvedValue(undefined);
    await loadEvCarAssociations();
    expect(state.evCarAssociations).toEqual({ 'other-charger': { carIds: ['car-2'] } });

    renderCarAssociation(charger());
    await flush();
    rows()[0].checked = true;
    rows()[0].dispatchEvent(new Event('change'));
    await flush();

    expect(setSetting).toHaveBeenCalledWith('ev_car_associations', {
      'other-charger': { carIds: ['car-2'] },
      'charger-1': { carIds: ['car-1'] },
    });
  });

  it('clears the last-known selections for an authoritative settings unset event', async () => {
    const { clearEvCarAssociations, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    const { state } = await import('../src/ui/state.ts');
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();

    clearEvCarAssociations();

    expect(state.evCarAssociations).toEqual({});
    expect(state.evCarAssociationsLoaded).toBe(true);
  });

  it('does not let a pending reload restore associations after an authoritative unset', async () => {
    const { clearEvCarAssociations, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    const { state } = await import('../src/ui/state.ts');
    let resolveRead: (value: unknown) => void = () => {};
    getSetting.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));

    const pendingLoad = loadEvCarAssociations();
    clearEvCarAssociations();
    resolveRead({ 'charger-1': { carIds: ['car-1'] } });
    await pendingLoad;

    expect(state.evCarAssociations).toEqual({});
    expect(state.evCarAssociationsLoaded).toBe(true);
  });

  it('keeps associations unresolved after a failed first read and resolves absence after retries', async () => {
    const { loadEvCarAssociations } = await import('../src/ui/deviceDetail/carAssociation.ts');
    const { state } = await import('../src/ui/state.ts');
    getSetting.mockRejectedValueOnce(new Error('transient'));

    await loadEvCarAssociations();
    expect(state.evCarAssociationsLoaded).toBe(false);

    getSetting.mockResolvedValueOnce(undefined);
    getSettingFresh.mockResolvedValue(undefined);
    await loadEvCarAssociations();

    expect(getSettingFresh).toHaveBeenCalledTimes(2);
    expect(state.evCarAssociations).toEqual({});
    expect(state.evCarAssociationsLoaded).toBe(true);
  });

  it('does not render a non-finite battery level', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger({
      associatedCar: {
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging',
        chargingStateObservedAtMs: 1_000, socPct: NaN,
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
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging',
        chargingStateObservedAtMs: 1_000, socPct: 63,
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
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging',
        chargingStateObservedAtMs: 1_000, socPct: 63,
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

    // A match takes 20 to 40 minutes after plug-in, so the wording says what PELS
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
    expect(flowNote().textContent).toContain('a Flow card or the charger itself');
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
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging',
        chargingStateObservedAtMs: 1_000, socPct: 63,
      },
    }));
    await flush();

    expect(flowNote().textContent).toBe('Battery level comes from Polestar 3.');
    // A one-time consequence of a choice, not an ongoing fault: once it works,
    // it stops shouting.
    expect(flowNote().classList.contains('field__hint--alert')).toBe(false);
  });

  it('warns when the matched car has not reported a battery level', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger({
      associatedCar: {
        carId: 'car-1', carName: 'Polestar 3', chargingState: 'plugged_in_charging',
        chargingStateObservedAtMs: 1_000,
      },
    }));
    await flush();

    expect(flowNote().textContent).toContain('has not reported a battery level');
    expect(flowNote().textContent).toContain('Charge boost and Smart tasks cannot use it yet');
    expect(flowNote().classList.contains('field__hint--alert')).toBe(true);
  });

  it('shows under each car whether PELS has matched it to this charger', async () => {
    callApi.mockResolvedValue({
      state: 'resolved',
      cars: [
        { id: 'car-1', name: 'Polestar 3', matchHistory: matchedTo('charger-1') },
        { id: 'car-2', name: 'Kia EV6', matchHistory: matchedTo('charger-2') },
      ],
    });
    const { state } = await import('../src/ui/state.ts');
    state.latestDevices = [charger(), charger({ id: 'charger-2', name: 'Garasje' })] as typeof state.latestDevices;
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    const hints = [...document.querySelectorAll('#device-detail-car-list .field__hint')]
      .map((element) => element.textContent);
    // A match to another charger says nothing about this one, and no "yet":
    // a car that charges elsewhere is not about to match here.
    expect(hints).toEqual([
      'Last matched to this charger on 3 Oct',
      'Not matched to this charger',
    ]);
  });

  it('keeps "yet" for a car whose only other match is a charger no longer in Homey', async () => {
    // Match history is kept for 90 days, so it can name a charger that was
    // since removed or replaced. That car does not charge elsewhere.
    callApi.mockResolvedValue({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Kia EV6', matchHistory: matchedTo('removed-charger') }],
    });
    const { state } = await import('../src/ui/state.ts');
    state.latestDevices = [charger()] as typeof state.latestDevices;
    const { renderCarAssociation } = await import('../src/ui/deviceDetail/carAssociation.ts');
    renderCarAssociation(charger());
    await flush();

    const hints = [...document.querySelectorAll('#device-detail-car-list .field__hint')]
      .map((element) => element.textContent);
    expect(hints).toEqual(['Not matched to this charger yet']);
  });

  it('re-reads the match history each time a charger page opens', async () => {
    const { renderCarAssociation, invalidateCarOptions } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    renderCarAssociation(charger());
    await flush();
    renderCarAssociation(charger());
    await flush();
    expect(callApi).toHaveBeenCalledTimes(1);

    callApi.mockResolvedValue({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Polestar 3', matchHistory: matchedTo('charger-1') }],
    });
    invalidateCarOptions();
    renderCarAssociation(charger());
    await flush();

    expect(callApi).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .toContain('Last matched to this charger on 3 Oct');
  });

  it('hides the previous match history while a re-read is pending', async () => {
    callApi.mockResolvedValue({ state: 'resolved', cars: [{ id: 'car-1', name: 'Polestar 3', matchHistory: matchedTo('charger-1') }] });
    const { renderCarAssociation, invalidateCarOptions } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    renderCarAssociation(charger());
    await flush();
    expect(document.querySelectorAll('#device-detail-car-list .field__hint')).toHaveLength(1);

    callApi.mockReturnValue(new Promise(() => {}));
    invalidateCarOptions();
    renderCarAssociation(charger());

    expect(rows().map((input) => input.dataset.carId)).toEqual(['car-1']);
    expect(document.querySelectorAll('#device-detail-car-list .field__hint')).toHaveLength(0);
  });

  it('keeps the rows on screen when a re-read fails', async () => {
    const { renderCarAssociation, invalidateCarOptions } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    renderCarAssociation(charger());
    await flush();

    callApi.mockRejectedValue(new Error('offline'));
    invalidateCarOptions();
    renderCarAssociation(charger());
    await flush();

    expect(rows().map((input) => input.dataset.carId)).toEqual(['car-1']);
    // The old history can no longer vouch for "not matched".
    expect(document.querySelectorAll('#device-detail-car-list .field__hint')).toHaveLength(0);
  });

  it('gives a page opened during an in-flight read its own fresh read', async () => {
    let resolveFirst!: (value: unknown) => void;
    callApi.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    const { renderCarAssociation, invalidateCarOptions } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    renderCarAssociation(charger());

    callApi.mockResolvedValue({ state: 'resolved', cars: [{ id: 'car-1', name: 'Polestar 3', matchHistory: matchedTo('charger-1') }] });
    invalidateCarOptions();
    renderCarAssociation(charger());
    resolveFirst({ state: 'resolved', cars: CARS });
    await flush();
    await flush();

    expect(callApi).toHaveBeenCalledTimes(2);
    expect(document.querySelector('#device-detail-car-list')?.textContent)
      .toContain('Last matched to this charger on 3 Oct');
  });

  it('tells the owner to clear a selected car that has never matched this charger', async () => {
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger());
    await flush();

    expect(flowNote().textContent)
      .toContain('This charger has no battery level until PELS matches a selected car');
    expect(flowNote().textContent).toContain('clear the selection to keep using it');
  });

  it('keeps the waiting note for a selected car that has matched this charger before', async () => {
    callApi.mockResolvedValue({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Polestar 3', matchHistory: matchedTo('charger-1') }],
    });
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger());
    await flush();

    expect(flowNote().textContent).toContain('Until a car is matched, this charger has no battery level');
    expect(flowNote().textContent).not.toContain('clear the selection');
  });

  it('shows no match hint and no clearing advice while the match history is unreadable', async () => {
    callApi.mockResolvedValue({
      state: 'resolved',
      cars: [{ id: 'car-1', name: 'Polestar 3', matchHistory: { state: 'unavailable' } }],
    });
    const { renderCarAssociation, loadEvCarAssociations } = await import(
      '../src/ui/deviceDetail/carAssociation.ts'
    );
    getSetting.mockResolvedValue({ 'charger-1': { carIds: ['car-1'] } });
    await loadEvCarAssociations();
    renderCarAssociation(charger());
    await flush();

    expect(document.querySelectorAll('#device-detail-car-list .field__hint')).toHaveLength(0);
    expect(flowNote().textContent).toContain('Until a car is matched, this charger has no battery level');
  });
});
