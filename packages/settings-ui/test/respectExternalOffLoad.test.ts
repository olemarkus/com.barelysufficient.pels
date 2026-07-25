// The LOAD side of `respect_external_off_devices`.
//
// The runtime validates this map as a whole (`isBooleanMap` in
// `setup/externalOffHoldAdapter.ts`) and rejects it outright on a single
// non-boolean entry. A shape-only cast here would render a device as opted in
// while PELS honoured no opt-in at all — the switch asserting behaviour that is
// not happening. The write path repairs the stored map on the next toggle.
import { createHomeyMock } from './helpers/homeyApiMock';

const buildDom = () => {
  document.body.innerHTML = `
    <select id="mode-select"></select>
    <select id="mode-edit-select"></select>
    <div id="mode-list"></div>
  `;
};

const loadWith = async (stored: unknown) => {
  const homeyModule = await import('../src/ui/homey.ts');
  homeyModule.setHomeyClient(createHomeyMock({
    settings: { respect_external_off_devices: stored },
  }));
  const { loadModeAndPriorities } = await import('../src/ui/modes.ts');
  const { state } = await import('../src/ui/state.ts');
  await loadModeAndPriorities();
  return state.respectExternalOffMap;
};

describe('"Leave off until turned on again" — reading the persisted opt-in map', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
  });

  it('reflects a clean map', async () => {
    expect(await loadWith({ 'heater-1': true })).toEqual({ 'heater-1': true });
  });

  it('drops explicit false entries rather than carrying them forward', async () => {
    expect(await loadWith({ 'heater-1': true, 'pump-1': false })).toEqual({ 'heater-1': true });
  });

  it('keeps the last known map when a reload is malformed', async () => {
    // The runtime rejects the whole map here and keeps ITS last-good copy, so
    // collapsing to `{}` would show a held device as opted out while PELS went
    // on leaving it off — a disagreement the user cannot see or act on.
    const { state } = await import('../src/ui/state.ts');
    state.respectExternalOffMap = { 'heater-1': true };
    expect(await loadWith({ 'heater-1': true, 'junk-1': 'yes' })).toEqual({ 'heater-1': true });
  });

  it('treats an absent value as nobody opted in, so clearing the setting works', async () => {
    const { state } = await import('../src/ui/state.ts');
    state.respectExternalOffMap = { 'heater-1': true };
    expect(await loadWith(undefined)).toEqual({});
  });

  it('keeps the last known map for a non-object value', async () => {
    const { state } = await import('../src/ui/state.ts');
    state.respectExternalOffMap = { 'heater-1': true };
    expect(await loadWith(['heater-1'])).toEqual({ 'heater-1': true });
  });
});
