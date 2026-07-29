import { createHomeyMock } from './helpers/homeyApiMock';

const AREA_A = 'h_11111111';
const AREA_B = 'h_22222222';

let selectedHomeId = AREA_A;

const setupDom = (): void => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <md-filled-select id="mode-select"></md-filled-select>
    <div id="priority-list"></div>
    <p id="priority-empty" hidden></p>
    <button id="add-mode-button"></button>
    <button id="rename-mode-button"></button>
    <button id="delete-mode-button"></button>
    <div id="mode-name-editor" hidden>
      <md-filled-text-field id="mode-new"></md-filled-text-field>
      <button id="mode-name-confirm"></button>
      <button id="mode-name-cancel"></button>
    </div>
  `;
};

const install = async () => {
  vi.doMock('../src/ui/homeScope.ts', () => ({
    getHomeScope: () => ({ selectedHomeId }),
    getHomeIdForUiDevice: () => selectedHomeId,
  }));
  const homey = createHomeyMock({
    settings: {
      [`operating_mode:${AREA_A}`]: 'Home',
      [`capacity_priorities:${AREA_A}`]: {
        Home: { 'device-a': 1 },
        Away: { 'device-a': 1 },
      },
      [`mode_device_targets:${AREA_A}`]: {
        Home: { 'device-a': 21 },
        Away: { 'device-a': 16 },
      },
    },
  });
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  setHomeyClient(homey);
  const { state } = await import('../src/ui/state.ts');
  state.loadedModeHomeId = AREA_A;
  state.activeMode = 'Home';
  state.editingMode = 'Home';
  state.capacityPriorities = {
    Home: { 'device-a': 1 },
    Away: { 'device-a': 1 },
  };
  state.modeTargets = {
    Home: { 'device-a': 21 },
    Away: { 'device-a': 16 },
  };
  state.modeAliases = {};
  state.latestDevices = [];
  return { homey, state };
};

const switchGlobalStateToAreaB = (state: Awaited<ReturnType<typeof install>>['state']): void => {
  selectedHomeId = AREA_B;
  state.loadedModeHomeId = AREA_B;
  state.activeMode = 'Sleep';
  state.editingMode = 'Sleep';
  state.capacityPriorities = { Sleep: { 'device-b': 1 } };
  state.modeTargets = { Sleep: { 'device-b': 17 } };
  state.modeAliases = {};
};

describe('mode mutations stay bound to their starting meter area', () => {
  beforeEach(() => {
    vi.resetModules();
    selectedHomeId = AREA_A;
    setupDom();
  });

  it('renames from an immutable catalog after Showing changes mid-write', async () => {
    const { homey, state } = await install();
    let releaseFirstWrite: (() => void) | undefined;
    const writes: Array<[string, unknown]> = [];
    homey.set.mockImplementation((key, value, callback) => {
      writes.push([key, structuredClone(value)]);
      if (!releaseFirstWrite) {
        releaseFirstWrite = () => callback?.(null);
        return;
      }
      callback?.(null);
    });
    const { renameMode } = await import('../src/ui/modes.ts');

    const rename = renameMode('Home', 'Cozy');
    await vi.waitFor(() => expect(releaseFirstWrite).toBeDefined());
    switchGlobalStateToAreaB(state);
    releaseFirstWrite?.();
    await rename;

    expect(writes.every(([key]) => key.endsWith(`:${AREA_A}`))).toBe(true);
    expect(writes.some(([, value]) => JSON.stringify(value).includes('device-b'))).toBe(false);
    expect(state.capacityPriorities).toEqual({ Sleep: { 'device-b': 1 } });
  });

  it('adds from an immutable catalog after Showing changes mid-read', async () => {
    const { homey, state } = await install();
    const pending: Array<() => void> = [];
    homey.get.mockImplementation((key, callback) => {
      if (
        key === `capacity_priorities:${AREA_A}`
        || key === `mode_device_targets:${AREA_A}`
      ) {
        const value = homey.__settingsStore[key];
        pending.push(() => callback(null, value));
        return;
      }
      callback(null, homey.__settingsStore[key] ?? null);
    });
    const { initModeHandlers } = await import('../src/ui/modes.ts');
    initModeHandlers();

    document.querySelector<HTMLButtonElement>('#add-mode-button')?.click();
    const input = document.querySelector('#mode-new') as HTMLElement & { value: string };
    input.value = 'Cozy';
    document.querySelector<HTMLButtonElement>('#mode-name-confirm')?.click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    switchGlobalStateToAreaB(state);
    pending.forEach((release) => release());
    await vi.waitFor(() => expect(homey.set).toHaveBeenCalledTimes(2));

    const writes = homey.set.mock.calls.map(([key, value]) => [key, value] as const);
    expect(writes.every(([key]) => key.endsWith(`:${AREA_A}`))).toBe(true);
    expect(writes.some(([, value]) => JSON.stringify(value).includes('device-b'))).toBe(false);
    expect(state.capacityPriorities).toEqual({ Sleep: { 'device-b': 1 } });
  });

  it('locks same-area mode mutations while one is pending', async () => {
    const { homey } = await install();
    const pending: Array<() => void> = [];
    homey.get.mockImplementation((key, callback) => {
      if (
        key === `capacity_priorities:${AREA_A}`
        || key === `mode_device_targets:${AREA_A}`
      ) {
        const value = homey.__settingsStore[key];
        pending.push(() => callback(null, value));
        return;
      }
      callback(null, homey.__settingsStore[key] ?? null);
    });
    const { applyTargetChange, initModeHandlers, savePriorities } = await import('../src/ui/modes.ts');
    initModeHandlers();

    document.querySelector<HTMLButtonElement>('#add-mode-button')?.click();
    const input = document.querySelector('#mode-new') as HTMLElement & { value: string };
    const confirm = document.querySelector<HTMLElement>('#mode-name-confirm');
    input.value = 'Cozy';
    confirm?.click();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(confirm?.hasAttribute('disabled')).toBe(true);

    input.value = 'Dropped';
    confirm?.dispatchEvent(new Event('click'));
    await applyTargetChange('device-a', '19');
    await savePriorities();
    pending.forEach((release) => release());
    await vi.waitFor(() => expect(homey.set).toHaveBeenCalledTimes(2));

    const writes = homey.set.mock.calls.map(([, value]) => JSON.stringify(value));
    expect(writes.every((value) => value.includes('Cozy'))).toBe(true);
    expect(writes.every((value) => !value.includes('Dropped'))).toBe(true);
    await vi.waitFor(() => expect(confirm?.hasAttribute('disabled')).toBe(false));
  });

  it('does not overwrite a malformed persisted catalog while adding a mode', async () => {
    const { homey } = await install();
    homey.__settingsStore[`capacity_priorities:${AREA_A}`] = 'malformed';
    const { initModeHandlers } = await import('../src/ui/modes.ts');
    initModeHandlers();

    document.querySelector<HTMLButtonElement>('#add-mode-button')?.click();
    const input = document.querySelector('#mode-new') as HTMLElement & { value: string };
    const confirm = document.querySelector<HTMLElement>('#mode-name-confirm');
    input.value = 'Cozy';
    confirm?.click();

    await vi.waitFor(() => expect(homey.get).toHaveBeenCalledWith(
      `capacity_priorities:${AREA_A}`,
      expect.any(Function),
    ));
    await Promise.resolve();
    expect(homey.set).not.toHaveBeenCalled();
  });

  it('deletes from an immutable catalog after Showing changes mid-write', async () => {
    const { homey, state } = await install();
    let releaseActiveWrite: (() => void) | undefined;
    const writes: Array<[string, unknown]> = [];
    homey.set.mockImplementation((key, value, callback) => {
      writes.push([key, structuredClone(value)]);
      if (key === `operating_mode:${AREA_A}` && !releaseActiveWrite) {
        releaseActiveWrite = () => callback?.(null);
        return;
      }
      callback?.(null);
    });
    const { initModeHandlers } = await import('../src/ui/modes.ts');
    initModeHandlers();
    const select = document.querySelector('#mode-select') as HTMLElement & { value: string };
    select.value = 'Home';

    document.querySelector<HTMLButtonElement>('#delete-mode-button')?.click();
    await vi.waitFor(() => expect(releaseActiveWrite).toBeDefined());
    switchGlobalStateToAreaB(state);
    releaseActiveWrite?.();
    await vi.waitFor(() => expect(homey.set).toHaveBeenCalledTimes(3));

    expect(writes.every(([key]) => key.endsWith(`:${AREA_A}`))).toBe(true);
    expect(writes.some(([, value]) => JSON.stringify(value).includes('device-b'))).toBe(false);
    expect(state.capacityPriorities).toEqual({ Sleep: { 'device-b': 1 } });
  });
});
