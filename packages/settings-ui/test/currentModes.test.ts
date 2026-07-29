import { createHomeyMock } from './helpers/homeyApiMock';

const AREA_A = 'h_11111111';
const AREA_B = 'h_22222222';

const homesPayload = {
  homes: [
    {
      homeId: AREA_A,
      name: 'Basement apartment with a long name',
      rootZoneId: 'z_a',
      meterDeviceId: 'meter-a',
    },
    {
      homeId: AREA_B,
      name: 'Annex',
      rootZoneId: 'z_b',
      meterDeviceId: 'meter-b',
    },
  ],
  membershipByDeviceId: {},
  zoneTree: null,
  hasSubHomes: true,
  runtimeActive: true,
  configDegraded: false,
};

const mount = (): void => {
  document.body.innerHTML = '<div id="toast"></div><div id="current-modes-root"></div>';
};

const loadView = async (settings: Record<string, unknown>, homes: unknown) => {
  const homey = createHomeyMock({ settings, uiState: { homes } });
  const { setHomeyClient } = await import('../src/ui/homey.ts');
  setHomeyClient(homey);
  const { refreshHomeScope } = await import('../src/ui/homeScope.ts');
  const { refreshCurrentModes } = await import('../src/ui/currentModes.ts');
  await refreshHomeScope();
  await refreshCurrentModes();
  return homey;
};

describe('current modes settings hub', () => {
  beforeEach(() => {
    vi.resetModules();
    mount();
  });

  it('keeps the single-meter selector and historical Main setting key', async () => {
    const homey = await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {}, Away: {} },
      mode_device_targets: { Home: {}, Away: {} },
    }, {
      homes: [],
      membershipByDeviceId: {},
      zoneTree: null,
      hasSubHomes: false,
      runtimeActive: false,
      configDegraded: false,
    });

    expect(document.querySelector('#settings-active-mode-summary')?.textContent).toBe('Current mode');
    const select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
    expect(select.value).toBe('Home');

    select.value = 'Away';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(homey.set).toHaveBeenCalledWith('operating_mode', 'Away', expect.any(Function));
    });
  });

  it('renders one independently backed selector for Main and every active meter area', async () => {
    const homey = await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {}, Away: {} },
      mode_device_targets: { Home: {}, Away: {} },
      [`operating_mode:${AREA_A}`]: 'Sleep',
      [`capacity_priorities:${AREA_A}`]: { Sleep: {}, Guests: {} },
      [`mode_device_targets:${AREA_A}`]: { Sleep: {}, Guests: {} },
      [`mode_catalog_initialized:${AREA_A}`]: true,
      [`operating_mode:${AREA_B}`]: 'Eco',
      [`capacity_priorities:${AREA_B}`]: { Eco: {} },
      [`mode_device_targets:${AREA_B}`]: { Eco: {} },
      [`mode_catalog_initialized:${AREA_B}`]: true,
    }, homesPayload);

    expect(document.querySelector('#settings-active-mode-summary')?.textContent).toBe('Current modes');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.settings-current-mode__row'));
    expect(rows.map((row) => row.querySelector('.settings-current-mode__home-name')?.textContent))
      .toEqual(['Main home', 'Basement apartment with a long name', 'Annex']);
    expect(rows.map((row) => (
      row.querySelector('md-filled-select') as HTMLElement & { value: string }
    ).value)).toEqual(['Home', 'Sleep', 'Eco']);

    const areaSelect = rows[1].querySelector('md-filled-select') as HTMLElement & { value: string };
    areaSelect.value = 'Guests';
    areaSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(homey.set).toHaveBeenCalledWith(
        `operating_mode:${AREA_A}`,
        'Guests',
        expect.any(Function),
      );
    });
    expect((document.querySelector('#active-mode-select') as HTMLElement & { value: string }).value)
      .toBe('Home');
  });

  it('shows the default Home mode while a new meter-area catalog is still unwritten', async () => {
    await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {} },
      mode_device_targets: { Home: {} },
    }, homesPayload);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.settings-current-mode__row'));
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).map((row) => (
      row.querySelector('md-filled-select') as HTMLElement & { value: string }
    ).value)).toEqual(['Home', 'Home']);
    expect(document.body.textContent).not.toContain('Modes couldn’t be loaded.');
  });

  it('shows Home when successful missing-key reads return undefined', async () => {
    const homey = createHomeyMock({
      settings: {
        operating_mode: 'Home',
        capacity_priorities: { Home: {} },
        mode_device_targets: { Home: {} },
      },
      uiState: { homes: homesPayload },
    });
    homey.get.mockImplementation((key, callback) => {
      callback(null, key.includes(':') ? undefined : homey.__settingsStore[key] ?? null);
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(homey);
    const { refreshHomeScope } = await import('../src/ui/homeScope.ts');
    const { refreshCurrentModes } = await import('../src/ui/currentModes.ts');

    await refreshHomeScope();
    await refreshCurrentModes();

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.settings-current-mode__row'));
    expect(rows.slice(1).map((row) => (
      row.querySelector('md-filled-select') as HTMLElement & { value: string }
    ).value)).toEqual(['Home', 'Home']);
    expect(document.body.textContent).not.toContain('Modes couldn’t be loaded.');
  });

  it('reports an incomplete meter-area catalog as a load failure', async () => {
    await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {} },
      mode_device_targets: { Home: {} },
      [`operating_mode:${AREA_A}`]: 'Home',
      [`capacity_priorities:${AREA_A}`]: { Home: {} },
    }, homesPayload);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.settings-current-mode__row'));
    expect(rows[1].textContent).toContain('Modes couldn’t be loaded.');
  });

  it('keeps a fully written meter-area catalog unavailable until its marker lands', async () => {
    await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {} },
      mode_device_targets: { Home: {} },
      [`operating_mode:${AREA_A}`]: 'Away',
      [`capacity_priorities:${AREA_A}`]: { Home: {}, Away: {} },
      [`mode_device_targets:${AREA_A}`]: { Home: {}, Away: {} },
    }, homesPayload);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.settings-current-mode__row'));
    expect(rows[1].textContent).toContain('Modes couldn’t be loaded.');
  });

  it('does not fabricate Home when an initialized catalog read misses transiently', async () => {
    const homey = createHomeyMock({
      settings: {
        operating_mode: 'Home',
        capacity_priorities: { Home: {} },
        mode_device_targets: { Home: {} },
        [`mode_catalog_initialized:${AREA_A}`]: true,
      },
      uiState: { homes: homesPayload },
    });
    homey.get.mockImplementation((key, callback) => {
      if (key === `mode_catalog_initialized:${AREA_A}`) {
        callback(null, true);
        return;
      }
      if (key.endsWith(`:${AREA_A}`)) {
        callback(null, undefined);
        return;
      }
      callback(null, homey.__settingsStore[key] ?? null);
    });
    const { setHomeyClient } = await import('../src/ui/homey.ts');
    setHomeyClient(homey);
    const { refreshHomeScope } = await import('../src/ui/homeScope.ts');
    const { refreshCurrentModes } = await import('../src/ui/currentModes.ts');

    await refreshHomeScope();
    await refreshCurrentModes();

    const rows = Array.from(document.querySelectorAll<HTMLElement>('.settings-current-mode__row'));
    expect(rows[1].textContent).toContain('Modes couldn’t be loaded.');
  });

  it('persists rapid same-area changes in selection order', async () => {
    const homey = await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {}, Away: {}, Sleep: {} },
      mode_device_targets: { Home: {}, Away: {}, Sleep: {} },
    }, {
      homes: [],
      membershipByDeviceId: {},
      zoneTree: null,
      hasSubHomes: false,
      runtimeActive: false,
      configDegraded: false,
    });
    const releases: Array<() => void> = [];
    homey.set.mockImplementation((_key, _value, callback) => {
      releases.push(() => callback?.(null));
    });
    let select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };

    select.value = 'Away';
    select.dispatchEvent(new Event('change'));
    select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
    select.value = 'Sleep';
    select.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(homey.set.mock.calls.map(([, value]) => value)).toEqual(['Away']);
    releases[0]();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(homey.set.mock.calls.map(([, value]) => value)).toEqual(['Away', 'Sleep']);
    releases[1]();
  });

  it('rolls a failed current-mode change back to the persisted mode', async () => {
    const homey = await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {}, Away: {} },
      mode_device_targets: { Home: {}, Away: {} },
    }, {
      homes: [],
      membershipByDeviceId: {},
      zoneTree: null,
      hasSubHomes: false,
      runtimeActive: false,
      configDegraded: false,
    });
    let rejectWrite: (() => void) | undefined;
    homey.set.mockImplementation((_key, _value, callback) => {
      rejectWrite = () => callback?.(new Error('write failed'));
    });
    let select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };

    select.value = 'Away';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(rejectWrite).toBeDefined());
    rejectWrite?.();

    await vi.waitFor(() => {
      select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
      expect(select.value).toBe('Home');
    });
  });

  it('rolls two failed rapid changes back to the last persisted mode', async () => {
    const homey = await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {}, Away: {}, Sleep: {} },
      mode_device_targets: { Home: {}, Away: {}, Sleep: {} },
    }, {
      homes: [],
      membershipByDeviceId: {},
      zoneTree: null,
      hasSubHomes: false,
      runtimeActive: false,
      configDegraded: false,
    });
    const rejectWrites: Array<() => void> = [];
    homey.set.mockImplementation((_key, _value, callback) => {
      rejectWrites.push(() => callback?.(new Error('write failed')));
    });
    let select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };

    select.value = 'Away';
    select.dispatchEvent(new Event('change'));
    select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
    select.value = 'Sleep';
    select.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(rejectWrites).toHaveLength(1));
    rejectWrites[0]();
    await vi.waitFor(() => expect(rejectWrites).toHaveLength(2));
    rejectWrites[1]();

    await vi.waitFor(() => {
      select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
      expect(select.value).toBe('Home');
    });
  });

  it('does not let an overlapping stale refresh replace a successful write baseline', async () => {
    const homey = await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {}, Away: {}, Sleep: {} },
      mode_device_targets: { Home: {}, Away: {}, Sleep: {} },
    }, {
      homes: [],
      membershipByDeviceId: {},
      zoneTree: null,
      hasSubHomes: false,
      runtimeActive: false,
      configDegraded: false,
    });
    const writes: Array<(error?: Error) => void> = [];
    homey.set.mockImplementation((_key, _value, callback) => {
      writes.push((error) => callback?.(error ?? null));
    });
    let select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
    select.value = 'Away';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(writes).toHaveLength(1));

    const { refreshCurrentModes } = await import('../src/ui/currentModes.ts');
    await refreshCurrentModes();
    select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
    expect(select.value).toBe('Away');

    writes[0]();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Active mode set to Away'));
    select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
    select.value = 'Sleep';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1](new Error('write failed'));

    await vi.waitFor(() => {
      select = document.querySelector('#active-mode-select') as HTMLElement & { value: string };
      expect(select.value).toBe('Away');
    });
  });

  it('reruns a discarded refresh after an unrelated home write settles', async () => {
    const homey = await loadView({
      operating_mode: 'Home',
      capacity_priorities: { Home: {}, Away: {} },
      mode_device_targets: { Home: {}, Away: {} },
      [`operating_mode:${AREA_A}`]: 'Sleep',
      [`capacity_priorities:${AREA_A}`]: { Sleep: {}, Guests: {} },
      [`mode_device_targets:${AREA_A}`]: { Sleep: {}, Guests: {} },
      [`mode_catalog_initialized:${AREA_A}`]: true,
      [`operating_mode:${AREA_B}`]: 'Eco',
      [`capacity_priorities:${AREA_B}`]: { Eco: {} },
      [`mode_device_targets:${AREA_B}`]: { Eco: {} },
      [`mode_catalog_initialized:${AREA_B}`]: true,
    }, homesPayload);
    let finishWrite: (() => void) | undefined;
    homey.set.mockImplementation((_key, _value, callback) => {
      finishWrite = () => callback?.(null);
    });
    const mainSelect = document.querySelector('#active-mode-select') as HTMLElement & {
      value: string;
    };
    mainSelect.value = 'Away';
    mainSelect.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(finishWrite).toBeDefined());

    const { getHomeScope, refreshHomeScope } = await import('../src/ui/homeScope.ts');
    const { refreshCurrentModes } = await import('../src/ui/currentModes.ts');
    await refreshHomeScope();
    expect(getHomeScope()).toMatchObject({ runtimeActive: true });
    expect(getHomeScope().areas).toHaveLength(2);
    await refreshCurrentModes();
    homey.__settingsStore.operating_mode = 'Away';
    homey.__settingsStore[`operating_mode:${AREA_A}`] = 'Guests';
    const { invalidateSettingCache } = await import('../src/ui/homey.ts');
    invalidateSettingCache(`operating_mode:${AREA_A}`);
    finishWrite?.();

    await vi.waitFor(() => {
      expect(homey.get.mock.calls.filter(([key]) => key === `operating_mode:${AREA_A}`))
        .toHaveLength(2);
    });
    await vi.waitFor(() => {
      const areaRow = [...document.querySelectorAll<HTMLElement>('.settings-current-mode__row')]
        .find((row) => row.querySelector('.settings-current-mode__home-name')?.textContent
          === 'Basement apartment with a long name');
      const areaSelect = areaRow?.querySelector('md-filled-select') as HTMLElement & {
        value: string;
      };
      expect(areaSelect.value).toBe('Guests');
    });
  });
});
