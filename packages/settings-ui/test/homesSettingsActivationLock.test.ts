import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_UI_DEVICES_PATH } from '../../contracts/src/settingsUiApi.ts';
import { SETTINGS_UI_HOMES_PATH, type SettingsUiHomesPayload } from '../../contracts/src/settingsUiHomes.ts';

/* -------------------------------------------------------------------------- *
 * Controller-level coverage for the "Multiple meters" activation load lock:
 * on panel (re)activation the cached `ui_homes` payload renders as ready
 * immediately, so the mutation controls (Add/Edit/Remove/Save) must stay
 * disabled until that activation's FRESH `ui_homes` read resolves — otherwise
 * a quick Edit could capture stale same-area fields whose full upsert would
 * overwrite newer edits made elsewhere. Only the outward `homey.ts`/toast/log
 * seams are mocked; the real Preact section renders into the mount.
 * -------------------------------------------------------------------------- */

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
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
});
