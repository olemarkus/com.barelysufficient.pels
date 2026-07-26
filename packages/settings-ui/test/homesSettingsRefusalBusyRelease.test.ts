import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_UI_DEVICES_PATH } from '../../contracts/src/settingsUiApi.ts';
import {
  SETTINGS_UI_HOMES_PATH,
  SETTINGS_UI_HOMES_SAVE_PATH,
  type SettingsUiHomesPayload,
} from '../../contracts/src/settingsUiHomes.ts';

/* -------------------------------------------------------------------------- *
 * Regression: a typed save refusal shows a five-second instructional toast
 * ("remove an area", "pick a meter"), but the editor's Cancel/Save disable
 * while `writeBusy`. The busy lock must therefore release BEFORE the toast
 * dwell is awaited — otherwise the user cannot act on the very instruction on
 * screen until it disappears. The lock must still hold while the write itself
 * is in flight — including a RETRY started during that dwell: when the older
 * handler's toast finally resolves, its release backstop must not un-gate the
 * lock the retry now owns. Only the outward `homey.ts`/toast/log seams are
 * mocked; the real Preact section renders into the mount.
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

let savePost: Deferred<unknown>;
let retrySavePost: Deferred<unknown>;
let refusalToast: Deferred<void>;
let savePostCount = 0;

const callApiMock = vi.fn();
const getSettingFreshMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  getSettingFresh: (...args: unknown[]) => getSettingFreshMock(...args),
}));
vi.mock('../src/ui/toast.ts', () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
  showToastError: vi.fn().mockResolvedValue(undefined),
  ERROR_DURATION_MS: 5000,
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

const emptyPayload = (): SettingsUiHomesPayload => ({
  homes: [],
  membershipByDeviceId: {},
  zoneTree: {
    z1: { id: 'z1', name: 'Home', parent: null },
    z2: { id: 'z2', name: 'Annex', parent: 'z1' },
  },
  hasSubHomes: false,
  runtimeActive: false,
  configDegraded: false,
});

const flushAsync = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
};

const buttonDisabled = (mount: HTMLElement, id: string): boolean => (
  (mount.querySelector(`#${id}`) as (HTMLElement & { disabled?: unknown }) | null)?.disabled === true
);

/** Open the create editor and compose a draft that passes client validation. */
const composeValidDraft = (mount: HTMLElement): void => {
  (mount.querySelector('#homes-add-button') as HTMLElement).click();
  const meterSelect = mount.querySelector('#homes-meter-select') as HTMLSelectElement;
  meterSelect.value = 'meter-1';
  meterSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const zoneSelect = mount.querySelector('#homes-zone-select') as HTMLSelectElement;
  zoneSelect.value = 'z2';
  zoneSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const nameInput = mount.querySelector('#homes-name-input') as HTMLInputElement;
  nameInput.value = 'Annex area';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
  vi.resetModules();
  savePost = defer<unknown>();
  retrySavePost = defer<unknown>();
  refusalToast = defer<void>();
  savePostCount = 0;
  getSettingFreshMock.mockResolvedValue(null);
  showToastMock.mockReturnValue(refusalToast.promise);
  callApiMock.mockImplementation((method: string, path: string) => {
    if (method === 'POST' && path === SETTINGS_UI_HOMES_SAVE_PATH) {
      savePostCount += 1;
      // First write refuses; a retry started during that refusal's toast dwell
      // gets its own still-pending POST.
      return savePostCount === 1 ? savePost.promise : retrySavePost.promise;
    }
    if (path === SETTINGS_UI_HOMES_PATH) return Promise.resolve(emptyPayload());
    if (path === SETTINGS_UI_DEVICES_PATH) return Promise.resolve({ devices: [] });
    // /homey_energy_meters picker list — one selectable meter for the draft.
    return Promise.resolve([{ id: 'meter-1', name: 'Garage meter' }]);
  });
  const mount = document.createElement('div');
  mount.id = 'homes-settings-mount';
  document.body.append(mount);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('homes editor busy release on a save refusal', () => {
  it('unlocks Cancel before the refusal toast dwell, while still locking during the write', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    await refreshHomesOnHomesPanel();
    await flushAsync();

    composeValidDraft(mount);

    (mount.querySelector('#homes-editor-save') as HTMLElement).click();
    await flushAsync();

    // Write in flight: the busy lock is correct here.
    expect(callApiMock.mock.calls.filter(
      ([method, path]) => method === 'POST' && path === SETTINGS_UI_HOMES_SAVE_PATH,
    )).toHaveLength(1);
    expect(buttonDisabled(mount, 'homes-editor-cancel')).toBe(true);
    expect(buttonDisabled(mount, 'homes-editor-save')).toBe(true);

    // The runtime refuses; the instructional toast dwell begins (unresolved).
    savePost.resolve({ ok: false, reason: 'area_limit_reached', maxCount: 2 });
    await flushAsync();
    expect(showToastMock).toHaveBeenCalledTimes(1);

    // The write is over, so the editor must be actionable DURING the dwell —
    // the toast says "remove an area", and Cancel is the way back to the list.
    expect(buttonDisabled(mount, 'homes-editor-cancel')).toBe(false);
    expect(buttonDisabled(mount, 'homes-editor-save')).toBe(false);
    (mount.querySelector('#homes-editor-cancel') as HTMLElement).click();
    expect(mount.querySelector('#homes-editor')).toBeNull();

    // Let the dwell finish so the save handler's post-refusal refetch settles.
    refusalToast.resolve();
    await flushAsync();
    await flushAsync();
  });

  it('keeps the retry write locked when the older refusal dwell ends', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    await refreshHomesOnHomesPanel();
    await flushAsync();
    composeValidDraft(mount);

    (mount.querySelector('#homes-editor-save') as HTMLElement).click();
    await flushAsync();
    savePost.resolve({ ok: false, reason: 'area_limit_reached', maxCount: 2 });
    await flushAsync();
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(buttonDisabled(mount, 'homes-editor-save')).toBe(false);

    // The owner retries DURING the refusal dwell: the second write takes the
    // lock while the first handler is still parked on its toast.
    (mount.querySelector('#homes-editor-save') as HTMLElement).click();
    await flushAsync();
    expect(savePostCount).toBe(2);
    expect(buttonDisabled(mount, 'homes-editor-save')).toBe(true);
    expect(buttonDisabled(mount, 'homes-editor-cancel')).toBe(true);

    // The older handler now finishes its dwell (and its post-refusal refetch)
    // while the retry POST is still pending. Its release backstop must be a
    // no-op: the flag guards whichever write is in flight, not one handler.
    refusalToast.resolve();
    await flushAsync();
    await flushAsync();
    expect(buttonDisabled(mount, 'homes-editor-save')).toBe(true);
    expect(buttonDisabled(mount, 'homes-editor-cancel')).toBe(true);

    // ...so no third write can overlap the one still in flight.
    (mount.querySelector('#homes-editor-save') as HTMLElement).click();
    await flushAsync();
    expect(savePostCount).toBe(2);

    retrySavePost.resolve({ ok: true });
    await flushAsync();
    await flushAsync();
  });

  it('never lets the refused handler supply the retry with a pre-write roster', async () => {
    const { refreshHomesOnHomesPanel } = await import('../src/ui/homesSettings.ts');
    const mount = document.getElementById('homes-settings-mount') as HTMLElement;

    // The roster the runtime would answer a GET with, and a hold on the reply
    // so a read issued BEFORE the retry's write can still be in flight after
    // it. Each GET captures the roster as it stands when the request is made —
    // that is exactly what makes a pre-write read stale.
    let savedAreas: SettingsUiHomesPayload['homes'] = [];
    let heldFetch: { deferred: Deferred<SettingsUiHomesPayload>; snapshot: SettingsUiHomesPayload } | null = null;
    let homesGetCount = 0;
    let holdFetches = false;
    callApiMock.mockImplementation((method: string, path: string) => {
      if (method === 'POST' && path === SETTINGS_UI_HOMES_SAVE_PATH) {
        savePostCount += 1;
        return savePostCount === 1 ? savePost.promise : retrySavePost.promise;
      }
      if (path === SETTINGS_UI_HOMES_PATH) {
        homesGetCount += 1;
        const snapshot = { ...emptyPayload(), homes: savedAreas, hasSubHomes: savedAreas.length > 0 };
        if (!holdFetches) return Promise.resolve(snapshot);
        const deferred = defer<SettingsUiHomesPayload>();
        heldFetch = { deferred, snapshot };
        return deferred.promise;
      }
      if (path === SETTINGS_UI_DEVICES_PATH) return Promise.resolve({ devices: [] });
      return Promise.resolve([{ id: 'meter-1', name: 'Garage meter' }]);
    });

    await refreshHomesOnHomesPanel();
    await flushAsync();
    expect(homesGetCount).toBe(1);
    composeValidDraft(mount);

    holdFetches = true;
    (mount.querySelector('#homes-editor-save') as HTMLElement).click();
    await flushAsync();
    savePost.resolve({ ok: false, reason: 'area_limit_reached', maxCount: 2 });
    await flushAsync();

    // The owner retries during the refusal dwell; the retry POST is in flight.
    (mount.querySelector('#homes-editor-save') as HTMLElement).click();
    await flushAsync();
    expect(savePostCount).toBe(2);

    // The refused handler's dwell now ends WHILE the retry is still writing.
    // It must not issue its post-refusal read: that GET would read the roster
    // from before the retry's write, and the retry would coalesce onto it.
    refusalToast.resolve();
    await flushAsync();
    await flushAsync();
    expect(homesGetCount).toBe(1);
    expect(heldFetch).toBeNull();

    // The retry lands. Its own reconciliation must be a FRESH read, taken
    // after the write, so the saved area is in the roster it publishes.
    savedAreas = [{ homeId: 'h_1', name: 'Annex area', rootZoneId: 'z2', meterDeviceId: 'meter-1' }];
    retrySavePost.resolve({ ok: true });
    await flushAsync();
    expect(homesGetCount).toBe(2);
    const held = heldFetch as { deferred: Deferred<SettingsUiHomesPayload>; snapshot: SettingsUiHomesPayload } | null;
    expect(held?.snapshot.homes).toHaveLength(1);
    held?.deferred.resolve(held.snapshot);
    await flushAsync();
    await flushAsync();

    // The editor closed reporting success, and the list it left behind shows
    // the area that was actually saved.
    expect(mount.querySelector('#homes-editor')).toBeNull();
    expect(mount.querySelectorAll('.homes-settings__row')).toHaveLength(1);
    expect(mount.textContent).toContain('Annex area');
  });
});
