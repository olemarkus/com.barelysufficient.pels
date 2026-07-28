import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_UI_DEVICES_PATH } from '../../contracts/src/settingsUiApi.ts';
import {
  SETTINGS_UI_HOMES_PATH,
  SETTINGS_UI_HOMES_SAVE_PATH,
  type SettingsUiHomesPayload,
} from '../../contracts/src/settingsUiHomes.ts';

/* -------------------------------------------------------------------------- *
 * Controller-level coverage for the "Multiple meters" activation load lock:
 * on panel (re)activation the cached `ui_homes` payload renders as ready
 * immediately, so the mutation controls (Add/Edit/Remove/Save) must stay
 * disabled until that activation's FRESH `ui_homes` read resolves — otherwise
 * a quick Edit could capture stale same-area fields whose full upsert would
 * overwrite newer edits made elsewhere. Only the outward `homey.ts`/toast/log
 * seams are mocked; the real Preact section renders into the mount.
 * -------------------------------------------------------------------------- */

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};
const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
};

let homesFetch: Deferred<SettingsUiHomesPayload>;

const callApiMock = vi.fn();
const getSettingFreshMock = vi.fn();

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  getSettingFresh: (...args: unknown[]) => getSettingFreshMock(...args),
}));
vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
  // `homesSettings.ts` gives a typed save refusal the error dwell; a factory
  // mock must carry the constant or the module throws on import.
  ERROR_DURATION_MS: 5000,
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

const readyPayload = (): SettingsUiHomesPayload => ({
  homes: [{ homeId: 'h_1', name: 'Rental', rootZoneId: 'z2', meterDeviceId: null }],
  membershipByDeviceId: {},
  zoneTree: {
    z1: { id: 'z1', name: 'Home', parent: null },
    z2: { id: 'z2', name: 'Upstairs', parent: 'z1' },
  },
  hasSubHomes: true,
  runtimeActive: true,
  configDegraded: false,
});

const addButtonDisabled = (mount: HTMLElement): boolean => (
  (mount.querySelector('#homes-add-button') as (HTMLElement & { disabled?: unknown }) | null)?.disabled === true
);

const rowButtonsAllDisabled = (mount: HTMLElement): boolean => {
  const buttons = [...mount.querySelectorAll('.homes-settings__actions md-text-button')];
  return buttons.length > 0
    && buttons.every((button) => (button as HTMLElement & { disabled?: unknown }).disabled === true);
};

const flushAsync = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

beforeEach(() => {
  homesFetch = defer<SettingsUiHomesPayload>();
  getSettingFreshMock.mockResolvedValue(null);
  callApiMock.mockImplementation((_method: string, path: string) => {
    if (path === SETTINGS_UI_HOMES_PATH) return homesFetch.promise;
    if (path === SETTINGS_UI_DEVICES_PATH) return Promise.resolve({ devices: [] });
    return Promise.resolve([]); // /homey_energy_meters picker list
  });
  const mount = document.createElement('div');
  mount.id = 'homes-settings-mount';
  document.body.append(mount);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('homes panel activation lock', () => {
  it('keeps Add/Edit/Remove disabled until the activation ui_homes refetch resolves', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    // First activation resolves cleanly → payload cached, controls live.
    const first = refreshHomesOnHomesPanel();
    homesFetch.resolve(readyPayload());
    await first;
    expect(mount.querySelector('#homes-list')).not.toBeNull();
    expect(addButtonDisabled(mount)).toBe(false);
    expect(rowButtonsAllDisabled(mount)).toBe(false);

    // Re-entry: the fresh ui_homes read is still in flight. The cached payload
    // renders as ready (not a skeleton), yet every mutation control is locked.
    homesFetch = defer<SettingsUiHomesPayload>();
    const second = refreshHomesOnHomesPanel();
    expect(mount.querySelector('#homes-list')).not.toBeNull();
    expect(addButtonDisabled(mount)).toBe(true);
    expect(rowButtonsAllDisabled(mount)).toBe(true);

    // The fresh read lands → the lock releases.
    homesFetch.resolve(readyPayload());
    await second;
    expect(addButtonDisabled(mount)).toBe(false);
    expect(rowButtonsAllDisabled(mount)).toBe(false);
  });

  it('keeps last-good homes visible but locked when the activation refetch fails', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    const first = refreshHomesOnHomesPanel();
    homesFetch.resolve(readyPayload());
    await first;
    expect(addButtonDisabled(mount)).toBe(false);

    homesFetch = defer<SettingsUiHomesPayload>();
    const failedRefresh = refreshHomesOnHomesPanel();
    expect(addButtonDisabled(mount)).toBe(true);
    homesFetch.reject(new Error('ui_homes unavailable'));
    await failedRefresh;

    expect(mount.querySelector('#homes-list')).not.toBeNull();
    expect(addButtonDisabled(mount)).toBe(true);
    expect(rowButtonsAllDisabled(mount)).toBe(true);
  });

  it('keeps overlapping activations locked until their shared refetch fails', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    const initial = refreshHomesOnHomesPanel();
    homesFetch.resolve(readyPayload());
    await initial;
    expect(addButtonDisabled(mount)).toBe(false);

    homesFetch = defer<SettingsUiHomesPayload>();
    const firstRefresh = refreshHomesOnHomesPanel();
    await flushAsync();
    const secondRefresh = refreshHomesOnHomesPanel();
    await flushAsync();

    expect(mount.querySelector('#homes-list')).not.toBeNull();
    expect(addButtonDisabled(mount)).toBe(true);
    expect(rowButtonsAllDisabled(mount)).toBe(true);
    expect(callApiMock.mock.calls.filter(
      ([, path]) => path === SETTINGS_UI_HOMES_PATH,
    )).toHaveLength(2);

    homesFetch.reject(new Error('ui_homes unavailable'));
    await Promise.all([firstRefresh, secondRefresh]);

    expect(addButtonDisabled(mount)).toBe(true);
    expect(rowButtonsAllDisabled(mount)).toBe(true);
  });

  it('lets only the latest activation release the mutation lock', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    const initial = refreshHomesOnHomesPanel();
    homesFetch.resolve(readyPayload());
    await initial;
    expect(addButtonDisabled(mount)).toBe(false);

    homesFetch = defer<SettingsUiHomesPayload>();
    const olderActivation = refreshHomesOnHomesPanel();
    await flushAsync();

    // The newer activation has started and re-locked the cached view, but its
    // advisory setting reads have not yet reached the homes fetch.
    const newerNoticeRead = defer<unknown>();
    getSettingFreshMock.mockImplementation(() => newerNoticeRead.promise);
    const newerActivation = refreshHomesOnHomesPanel();
    await flushAsync();
    expect(addButtonDisabled(mount)).toBe(true);

    // The older homes fetch settles first. It must not unlock controls while
    // the newer activation is still waiting on its notice inputs.
    homesFetch.resolve(readyPayload());
    await olderActivation;
    expect(addButtonDisabled(mount)).toBe(true);
    expect(rowButtonsAllDisabled(mount)).toBe(true);

    homesFetch = defer<SettingsUiHomesPayload>();
    newerNoticeRead.resolve(null);
    await flushAsync();
    expect(callApiMock.mock.calls.filter(
      ([, path]) => path === SETTINGS_UI_HOMES_PATH,
    )).toHaveLength(3);
    expect(addButtonDisabled(mount)).toBe(true);

    homesFetch.resolve(readyPayload());
    await newerActivation;
    expect(addButtonDisabled(mount)).toBe(false);
    expect(rowButtonsAllDisabled(mount)).toBe(false);
  });

  it('keeps cached rows locked when a successful delete refetch fails', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;
    callApiMock.mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === SETTINGS_UI_HOMES_PATH) return homesFetch.promise;
      if (method === 'POST' && path === SETTINGS_UI_HOMES_SAVE_PATH) {
        return Promise.resolve({ ok: true });
      }
      if (path === SETTINGS_UI_DEVICES_PATH) return Promise.resolve({ devices: [] });
      return Promise.resolve([]);
    });

    const initial = refreshHomesOnHomesPanel();
    homesFetch.resolve(readyPayload());
    await initial;
    expect(addButtonDisabled(mount)).toBe(false);

    homesFetch = defer<SettingsUiHomesPayload>();
    const remove = [...mount.querySelectorAll<HTMLElement>('.homes-settings__row md-text-button')]
      .find((button) => button.textContent?.trim() === 'Remove');
    remove?.click();
    const confirm = [...mount.querySelectorAll<HTMLElement>('.homes-settings__confirm md-text-button')]
      .find((button) => button.textContent?.trim() === 'Remove');
    confirm?.click();
    await flushAsync();

    expect(callApiMock.mock.calls.filter(
      ([method, path]) => method === 'POST' && path === SETTINGS_UI_HOMES_SAVE_PATH,
    )).toHaveLength(1);
    expect(mount.querySelector('#homes-list')).not.toBeNull();
    expect(addButtonDisabled(mount)).toBe(true);

    homesFetch.reject(new Error('post-delete ui_homes unavailable'));
    await flushAsync();

    // The last-good pre-delete row remains useful context, but no stale
    // follow-up mutation can be opened or posted.
    expect(mount.querySelector('#homes-list')).not.toBeNull();
    expect(addButtonDisabled(mount)).toBe(true);
    expect(rowButtonsAllDisabled(mount)).toBe(true);
    for (const button of mount.querySelectorAll<HTMLElement>('.homes-settings__row md-text-button')) {
      button.click();
    }
    await flushAsync();
    expect(mount.querySelector('#homes-editor')).toBeNull();
    expect(mount.querySelector('.homes-settings__confirm')).toBeNull();
    expect(callApiMock.mock.calls.filter(
      ([method, path]) => method === 'POST' && path === SETTINGS_UI_HOMES_SAVE_PATH,
    )).toHaveLength(1);
  });
});
