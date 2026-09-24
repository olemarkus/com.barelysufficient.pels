import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOMEY_ENERGY_METERS_PATH, SETTINGS_UI_DEVICES_PATH } from '../../contracts/src/settingsUiApi.ts';
import {
  SETTINGS_UI_HOMES_PATH,
  type SettingsUiHomesPayload,
} from '../../contracts/src/settingsUiHomes.ts';
import {
  HOMES_METER_HINT,
  HOMES_NO_METER_DEVICES,
  HOMES_REFRESH_FAILED,
} from '../../shared-domain/src/homesManagementCopy.ts';

/* -------------------------------------------------------------------------- *
 * Controller-level coverage for the two load states the "Multiple meters"
 * panel must say out loud: a meter list that answered empty (the home has no
 * meter to pick, so the editor names the remedy) and a `ui_homes` refresh that
 * failed over last-good rows (the controls stay locked, and the owner is told
 * why). Only the outward `homey.ts`/toast/log seams are mocked; the real
 * Preact section renders into the mount.
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
let metersFetch: Deferred<unknown>;

const callApiMock = vi.fn();

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  getSettingFresh: vi.fn().mockResolvedValue(null),
}));
vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
  ERROR_DURATION_MS: 5000,
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

const payload = (homes: SettingsUiHomesPayload['homes']): SettingsUiHomesPayload => ({
  homes,
  membershipByDeviceId: {},
  zoneTree: {
    z1: { id: 'z1', name: 'Home', parent: null },
    z2: { id: 'z2', name: 'Annex', parent: 'z1' },
  },
  hasSubHomes: homes.length > 0,
  runtimeActive: true,
  configDegraded: false,
  mainMeterConflictAreaName: null,
});

const rentalHome = { homeId: 'h_1', name: 'Rental', rootZoneId: 'z2', meterDeviceId: null };

const flushAsync = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const meterHint = (mount: HTMLElement): string | undefined => (
  mount.querySelector('#homes-meter-select')?.parentElement?.querySelector('small.field__hint')?.textContent
    ?? undefined
);

beforeEach(() => {
  vi.resetModules();
  homesFetch = defer<SettingsUiHomesPayload>();
  metersFetch = defer<unknown>();
  callApiMock.mockImplementation((_method: string, path: string) => {
    if (path === SETTINGS_UI_HOMES_PATH) return homesFetch.promise;
    if (path === HOMEY_ENERGY_METERS_PATH) return metersFetch.promise;
    if (path === SETTINGS_UI_DEVICES_PATH) return Promise.resolve({ devices: [] });
    throw new Error(`unexpected path ${path}`);
  });
  const mount = document.createElement('div');
  mount.id = 'homes-settings-mount';
  document.body.append(mount);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('meter picker load states', () => {
  it('names the remedy once the meter list answers empty, and not before', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    const activation = refreshHomesOnHomesPanel();
    homesFetch.resolve(payload([]));
    await activation;
    (mount.querySelector('#homes-add-button') as HTMLElement).click();

    // The list has not answered yet: an empty picker is not yet a claim.
    expect(meterHint(mount)).toBe(HOMES_METER_HINT);

    metersFetch.resolve([]);
    await flushAsync();
    expect(meterHint(mount)).toBe(HOMES_NO_METER_DEVICES);
  });

  it('keeps the loading hint when the meter list could not be read', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    const activation = refreshHomesOnHomesPanel();
    homesFetch.resolve(payload([]));
    await activation;
    (mount.querySelector('#homes-add-button') as HTMLElement).click();

    metersFetch.reject(new Error('Homey Energy live report unavailable'));
    await flushAsync();
    expect(meterHint(mount)).toBe(HOMES_METER_HINT);
  });
});

describe('ui_homes refresh failure over last-good rows', () => {
  it('says why the preserved rows are locked, and clears once a refresh lands', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;
    metersFetch.resolve([]);

    const first = refreshHomesOnHomesPanel();
    homesFetch.resolve(payload([rentalHome]));
    await first;
    expect(mount.querySelector('#homes-refresh-failed')).toBeNull();

    homesFetch = defer<SettingsUiHomesPayload>();
    const failed = refreshHomesOnHomesPanel();
    homesFetch.reject(new Error('ui_homes unavailable'));
    await failed;
    expect(mount.querySelector('#homes-list')).not.toBeNull();
    expect(mount.querySelector('#homes-refresh-failed')?.textContent).toBe(HOMES_REFRESH_FAILED);
    expect((mount.querySelector('#homes-add-button') as HTMLElement & { disabled?: unknown }).disabled)
      .toBe(true);

    homesFetch = defer<SettingsUiHomesPayload>();
    const recovered = refreshHomesOnHomesPanel();
    homesFetch.resolve(payload([rentalHome]));
    await recovered;
    expect(mount.querySelector('#homes-refresh-failed')).toBeNull();
  });
});
