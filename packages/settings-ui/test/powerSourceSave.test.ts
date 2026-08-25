// The Power source select persists through the guarded ui_homes_save seam
// (the runtime refuses Flow while meter areas run). This covers the surfaced
// side of that refusal: the select rolls back to the last confirmed source and
// the toast carries the remedy line; a success patches the local settings
// cache and never writes settings directly.

import {
  HOMES_POWER_SOURCE_NEEDED_BY_AREAS,
  HOMES_POWER_SOURCE_SAVE_DEGRADED,
  HOMES_POWER_SOURCE_SAVE_FAILED,
} from '../../shared-domain/src/homeAreaConfigRulesCopy';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  HOMEY_ENERGY_METER_DEVICE_ID,
  HOMES_CONFIG,
  HOMES_CONFIG_INITIALIZED,
  POWER_SOURCE,
} from '../../contracts/src/settingsKeys';

const POWER_SOURCE_DOM = [
  '<md-filled-text-field id="settings-capacity-limit"></md-filled-text-field>',
  '<md-filled-text-field id="settings-capacity-margin"></md-filled-text-field>',
  '<span id="settings-capacity-reaction"></span>',
  '<small id="settings-capacity-margin-alert" hidden></small>',
  '<md-switch id="settings-simulation-mode"></md-switch>',
  '<md-filled-select id="settings-power-source"></md-filled-select>',
  '<div id="settings-homey-energy-meter-field" hidden></div>',
  '<md-filled-select id="settings-homey-energy-meter"></md-filled-select>',
  '<div id="stale-data-banner"><span id="stale-data-text"></span><button id="stale-data-action"></button></div>',
].join('');

const ERROR_DURATION_MS = 6000;

type SelectLike = HTMLElement & { value: string; disabled: boolean };

const loadCapacityModule = async (params: {
  persistedSource: unknown;
  saveResult: () => Promise<unknown>;
  getSetting?: (key: string) => Promise<unknown>;
  getSettingFresh?: (key: string) => Promise<unknown>;
  setSetting?: (key: string, value: unknown) => Promise<void>;
}) => {
  vi.resetModules();
  // Static template constructed from a literal — no untrusted content.
  document.body.innerHTML = POWER_SOURCE_DOM;
  const select = document.querySelector('#settings-power-source') as SelectLike;
  let persistedSource = params.persistedSource;
  const callApi = vi.fn().mockImplementation(async (method: string, path: string, body?: unknown) => {
    if (method === 'POST' && path === '/ui_homes_save') {
      const result = await params.saveResult();
      if (
        typeof result === 'object'
        && result !== null
        && (result as { ok?: unknown }).ok === true
        && typeof body === 'object'
        && body !== null
      ) {
        persistedSource = (body as { source?: unknown }).source;
      }
      return result;
    }
    // The meter picker lazily fetches its options when a rollback re-shows it.
    return [];
  });
  const applySettingsPatch = vi.fn();
  const setSetting = vi.fn().mockImplementation(async (key: string, value: unknown) => (
    params.setSetting?.(key, value)
  ));
  const getSetting = vi.fn().mockImplementation(async (key: string) => (
    params.getSetting
      ? params.getSetting(key)
      : key === POWER_SOURCE ? persistedSource : undefined
  ));
  const getSettingFresh = vi.fn().mockImplementation(async (key: string) => (
    params.getSettingFresh
      ? params.getSettingFresh(key)
      : key === POWER_SOURCE ? persistedSource : params.getSetting?.(key)
  ));
  vi.doMock('../src/ui/homey.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/ui/homey.ts')>();
    return {
      ...actual, callApi, applySettingsPatch, setSetting, getSetting, getSettingFresh,
    };
  });
  const showToast = vi.fn().mockResolvedValue(undefined);
  const showToastError = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../src/ui/toast.ts', () => ({
    showToast, showToastError, ERROR_DURATION_MS,
  }));
  vi.doMock('../src/ui/logging.ts', () => ({
    logSettingsError: vi.fn().mockResolvedValue(undefined),
    logSettingsWarn: vi.fn().mockResolvedValue(undefined),
  }));
  const capacity = await import('../src/ui/powerSourceSave.ts');
  const capacitySettings = await import('../src/ui/capacity.ts');
  const homeyEnergyMeter = await import('../src/ui/homeyEnergyMeter.ts');
  return {
    capacity,
    capacitySettings,
    homeyEnergyMeter,
    select,
    meterSelect: document.querySelector('#settings-homey-energy-meter') as SelectLike,
    callApi,
    applySettingsPatch,
    setSetting,
    showToast,
    showToastError,
  };
};

describe('savePowerSourceSetting', () => {
  it('persists through the ui_homes_save seam and patches the local cache, never settings directly', async () => {
    const {
      capacity, select, callApi, applySettingsPatch, setSetting, showToast,
    } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: async () => ({ ok: true }),
    });
    select.value = 'flow';

    await capacity.savePowerSourceSetting();

    expect(callApi).toHaveBeenCalledWith(
      'POST', '/ui_homes_save', { op: 'set_power_source', source: 'flow' },
    );
    expect(applySettingsPatch).toHaveBeenCalledWith({ power_source: 'flow' });
    expect(setSetting).not.toHaveBeenCalled();
    expect(select.value).toBe('flow');
    expect(select.disabled).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Power source saved.', 'ok');
  });

  it('rejects a malformed truthy save response instead of reporting success', async () => {
    const {
      capacity, select, applySettingsPatch, showToast, showToastError,
    } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: async () => ({ ok: 'yes' }),
    });
    select.value = 'flow';

    await capacity.savePowerSourceSetting();

    expect(select.value).toBe('homey_energy');
    expect(applySettingsPatch).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalledWith('Power source saved.', 'ok');
    expect(showToastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Invalid power-source save response.' }),
      HOMES_POWER_SOURCE_SAVE_FAILED,
    );
  });

  it('keeps a concurrent Whole-home meter refresh when a source save fences source paint', async () => {
    let blockMeterRead = false;
    let markMeterReadStarted!: () => void;
    const meterReadStarted = new Promise<void>((resolve) => {
      markMeterReadStarted = resolve;
    });
    let resolveMeterRead!: (value: unknown) => void;
    const meterRead = new Promise<unknown>((resolve) => {
      resolveMeterRead = resolve;
    });
    const {
      capacity,
      capacitySettings,
      homeyEnergyMeter,
      select,
      meterSelect,
    } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: async () => ({ ok: true }),
      getSetting: async (key) => {
        if (key === HOMES_CONFIG || key === HOMES_CONFIG_INITIALIZED) return null;
        if (key === CAPACITY_LIMIT_KW) return 10;
        if (key === CAPACITY_MARGIN_KW) return 0.2;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) return 'homey_energy';
        if (key === HOMEY_ENERGY_METER_DEVICE_ID) {
          if (!blockMeterRead) return 'meter-old';
          markMeterReadStarted();
          return meterRead;
        }
        return undefined;
      },
    });
    await capacitySettings.loadCapacitySettings();
    expect(meterSelect.value).toBe('meter-old');

    blockMeterRead = true;
    const concurrentRefresh = capacitySettings.loadCapacitySettings();
    await meterReadStarted;
    select.value = 'flow';
    await capacity.savePowerSourceSetting();

    resolveMeterRead('meter-new');
    await concurrentRefresh;

    expect(select.value).toBe('flow');
    homeyEnergyMeter.syncHomeyEnergyMeterVisibility('homey_energy');
    expect(meterSelect.value).toBe('meter-new');
  });

  it('commits an older valid load when a newer settings load fails', async () => {
    let limitReads = 0;
    let markMeterReadStarted!: () => void;
    const meterReadStarted = new Promise<void>((resolve) => {
      markMeterReadStarted = resolve;
    });
    let resolveMeterRead!: (value: unknown) => void;
    const meterRead = new Promise<unknown>((resolve) => {
      resolveMeterRead = resolve;
    });
    const { capacitySettings } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: async () => ({ ok: true }),
      getSetting: async (key) => {
        if (key === HOMES_CONFIG || key === HOMES_CONFIG_INITIALIZED) return null;
        if (key === CAPACITY_LIMIT_KW) {
          limitReads += 1;
          if (limitReads === 2) throw new Error('newer load failed');
          return 12;
        }
        if (key === CAPACITY_MARGIN_KW) return 0.3;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) return 'homey_energy';
        if (key === HOMEY_ENERGY_METER_DEVICE_ID) {
          markMeterReadStarted();
          return meterRead;
        }
        return undefined;
      },
    });

    const olderValidLoad = capacitySettings.loadCapacitySettings();
    await meterReadStarted;
    await expect(capacitySettings.loadCapacitySettings()).rejects.toThrow('newer load failed');
    resolveMeterRead(null);
    await olderValidLoad;

    expect((document.querySelector('#settings-capacity-limit') as SelectLike).value).toBe('12');
    expect((document.querySelector('#settings-capacity-margin') as SelectLike).value).toBe('0.3');
  });

  it('does not let a stale unavailable-source load repaint a failed-save rollback', async () => {
    let powerSourceReads = 0;
    let markMeterReadStarted!: () => void;
    const meterReadStarted = new Promise<void>((resolve) => {
      markMeterReadStarted = resolve;
    });
    let resolveMeterRead!: (value: unknown) => void;
    const meterRead = new Promise<unknown>((resolve) => {
      resolveMeterRead = resolve;
    });
    const { capacity, capacitySettings, select } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: async () => ({ ok: false, reason: 'degraded' }),
      getSetting: async (key) => {
        if (key === HOMES_CONFIG || key === HOMES_CONFIG_INITIALIZED) return null;
        if (key === CAPACITY_LIMIT_KW) return 10;
        if (key === CAPACITY_MARGIN_KW) return 0.2;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) {
          powerSourceReads += 1;
          return powerSourceReads === 1 ? undefined : 'homey_energy';
        }
        if (key === HOMEY_ENERGY_METER_DEVICE_ID) {
          markMeterReadStarted();
          return meterRead;
        }
        return undefined;
      },
    });

    const staleLoad = capacitySettings.loadCapacitySettings();
    await meterReadStarted;
    select.value = 'flow';
    await capacity.savePowerSourceSetting();
    expect(select.value).toBe('homey_energy');

    resolveMeterRead(null);
    await staleLoad;
    expect(select.value).toBe('homey_energy');
  });

  it('preserves the rollback when an unavailable load starts after the save fence', async () => {
    let resolveSave!: (value: unknown) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveResponse = new Promise<unknown>((resolve) => {
      resolveSave = resolve;
    });
    let blockMeterRead = false;
    let markMeterReadStarted!: () => void;
    const meterReadStarted = new Promise<void>((resolve) => {
      markMeterReadStarted = resolve;
    });
    let resolveMeterRead!: (value: unknown) => void;
    const meterRead = new Promise<unknown>((resolve) => {
      resolveMeterRead = resolve;
    });
    let powerSourceReads = 0;
    const { capacity, capacitySettings, select } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: () => {
        markSaveStarted();
        return saveResponse;
      },
      getSetting: async (key) => {
        if (key === HOMES_CONFIG || key === HOMES_CONFIG_INITIALIZED) return null;
        if (key === CAPACITY_LIMIT_KW) return 10;
        if (key === CAPACITY_MARGIN_KW) return 0.2;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) {
          powerSourceReads += 1;
          return powerSourceReads <= 2 ? 'homey_energy' : undefined;
        }
        if (key === HOMEY_ENERGY_METER_DEVICE_ID) {
          if (!blockMeterRead) return null;
          markMeterReadStarted();
          return meterRead;
        }
        return undefined;
      },
    });
    await capacitySettings.loadCapacitySettings();
    blockMeterRead = true;
    select.value = 'flow';

    const save = capacity.savePowerSourceSetting();
    await saveStarted;
    const unavailableLoad = capacitySettings.loadCapacitySettings();
    await meterReadStarted;

    resolveSave({ ok: false, reason: 'degraded' });
    await save;
    expect(select.value).toBe('homey_energy');

    resolveMeterRead(null);
    await unavailableLoad;
    expect(select.value).toBe('homey_energy');
    expect(document.querySelector<HTMLElement>('#settings-homey-energy-meter-field')!.hidden).toBe(false);
  });

  it('preserves a confirmed source refresh that lands before a failed save settles', async () => {
    let rejectSave!: (reason: Error) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveResponse = new Promise<unknown>((_resolve, reject) => {
      rejectSave = reject;
    });
    let powerSourceReads = 0;
    const { capacity, capacitySettings, select } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: () => {
        markSaveStarted();
        return saveResponse;
      },
      getSetting: async (key) => {
        if (key === HOMES_CONFIG || key === HOMES_CONFIG_INITIALIZED) return null;
        if (key === CAPACITY_LIMIT_KW) return 10;
        if (key === CAPACITY_MARGIN_KW) return 0.2;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) {
          powerSourceReads += 1;
          return powerSourceReads === 1 ? 'homey_energy' : 'flow';
        }
        if (key === HOMEY_ENERGY_METER_DEVICE_ID) return null;
        return undefined;
      },
    });
    select.value = 'flow';

    const save = capacity.savePowerSourceSetting();
    await saveStarted;
    // Models the settings.set emitted by a committed write whose transport
    // callback subsequently reports failure (or a newer write in another
    // WebView). This is newer authority than the save's rollback anchor.
    await capacitySettings.loadCapacitySettings();
    expect(select.value).toBe('flow');

    rejectSave(new Error('transport callback failed'));
    await save;

    expect(select.value).toBe('flow');
    expect(select.disabled).toBe(false);
  });

  it('keeps the saved source when an older capacity refresh finishes after the success reapply', async () => {
    let resolveSave!: (value: unknown) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveResponse = new Promise<unknown>((resolve) => {
      resolveSave = resolve;
    });
    let resolveMeterRead!: (value: unknown) => void;
    let markMeterReadStarted!: () => void;
    const meterReadStarted = new Promise<void>((resolve) => {
      markMeterReadStarted = resolve;
    });
    const meterRead = new Promise<unknown>((resolve) => {
      resolveMeterRead = resolve;
    });
    const {
      capacity,
      capacitySettings,
      select,
      applySettingsPatch,
    } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: () => {
        markSaveStarted();
        return saveResponse;
      },
      getSetting: async (key) => {
        if (key === HOMES_CONFIG || key === HOMES_CONFIG_INITIALIZED) return null;
        if (key === CAPACITY_LIMIT_KW) return 10;
        if (key === CAPACITY_MARGIN_KW) return 0.2;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) return 'homey_energy';
        if (key === HOMEY_ENERGY_METER_DEVICE_ID) {
          markMeterReadStarted();
          return meterRead;
        }
        return undefined;
      },
    });

    select.value = 'homey_energy';
    capacitySettings.setPowerSourceConfigured(true);
    capacitySettings.updateStaleDataStatusFromPowerPayload({
      tracker: null, status: { state: 'unavailable', reason: 'no_measurement' }, heartbeat: null,
    });
    select.value = 'flow';

    const save = capacity.savePowerSourceSetting();
    await saveStarted;

    // A refresh starts after the request's opening fence but before the
    // backend commits the write. It still reads and may paint the previously
    // persisted source while the POST is pending.
    const staleLoad = capacitySettings.loadCapacitySettings();
    await meterReadStarted;
    resolveMeterRead(null);
    await staleLoad;
    expect(select.value).toBe('homey_energy');
    expect(document.querySelector('#stale-data-text')!.textContent).toContain('Homey Energy');

    resolveSave({ ok: true });
    await save;
    expect(applySettingsPatch).toHaveBeenCalledWith({ power_source: 'flow' });
    expect(select.value).toBe('flow');
    expect(document.querySelector<HTMLElement>('#settings-homey-energy-meter-field')!.hidden).toBe(true);
    expect(select.disabled).toBe(false);
    expect(document.querySelector('#stale-data-text')!.textContent).toContain('Check your Flow');
    expect((document.querySelector('#settings-capacity-limit') as SelectLike).value).toBe('10');
    expect((
      document.querySelector('#settings-simulation-mode') as HTMLElement & { selected: boolean }
    ).selected).toBe(false);
  });

  it('preserves a later source write when this request success callback settles last', async () => {
    let resolveSave!: (value: unknown) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveResponse = new Promise<unknown>((resolve) => {
      resolveSave = resolve;
    });
    const {
      capacity,
      capacitySettings,
      select,
      applySettingsPatch,
    } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: () => {
        markSaveStarted();
        return saveResponse;
      },
      getSetting: async (key) => {
        if (key === HOMES_CONFIG || key === HOMES_CONFIG_INITIALIZED) return null;
        if (key === CAPACITY_LIMIT_KW) return 10;
        if (key === CAPACITY_MARGIN_KW) return 0.2;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) return 'homey_energy';
        if (key === HOMEY_ENERGY_METER_DEVICE_ID) return null;
        return undefined;
      },
      // Another WebView restored Homey Energy after this request committed
      // Flow but before its delayed success callback reached this WebView.
      getSettingFresh: async (key) => (key === POWER_SOURCE ? 'homey_energy' : undefined),
    });
    select.value = 'flow';

    const save = capacity.savePowerSourceSetting();
    await saveStarted;
    await capacitySettings.loadCapacitySettings();
    resolveSave({ ok: true });
    await save;

    expect(applySettingsPatch).toHaveBeenCalledWith({ power_source: 'homey_energy' });
    expect(select.value).toBe('homey_energy');
    expect(document.querySelector<HTMLElement>('#settings-homey-energy-meter-field')!.hidden).toBe(false);
  });

  it('keeps the saved source when an older limits save finishes afterwards', async () => {
    let resolveLimitWrite!: () => void;
    let markLimitWriteStarted!: () => void;
    const limitWriteStarted = new Promise<void>((resolve) => {
      markLimitWriteStarted = resolve;
    });
    const limitWrite = new Promise<void>((resolve) => {
      resolveLimitWrite = resolve;
    });
    const {
      capacity,
      capacitySettings,
      select,
      applySettingsPatch,
    } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: async () => ({ ok: true }),
      getSetting: async (key) => {
        if (key === CAPACITY_LIMIT_KW) return 10;
        if (key === CAPACITY_MARGIN_KW) return 0.2;
        if (key === CAPACITY_DRY_RUN) return false;
        if (key === POWER_SOURCE) return 'homey_energy';
        return undefined;
      },
      setSetting: async (key) => {
        if (key !== CAPACITY_LIMIT_KW) return;
        markLimitWriteStarted();
        await limitWrite;
      },
    });
    const limit = document.querySelector('#settings-capacity-limit') as SelectLike;
    const margin = document.querySelector('#settings-capacity-margin') as SelectLike;
    limit.value = '12';
    margin.value = '0.2';

    // The Limits save started while Homey Energy was current and is now
    // waiting for its own setting write. It does not own the source control.
    const staleLimitsSave = capacitySettings.saveSettingsLimitsSettings();
    await limitWriteStarted;
    select.value = 'flow';

    await capacity.savePowerSourceSetting();

    expect(applySettingsPatch).toHaveBeenCalledWith({ power_source: 'flow' });
    expect(select.value).toBe('flow');

    // Completing the older Limits save used to run the broad controls sync
    // with its captured source, repainting Homey Energy after Flow had saved.
    resolveLimitWrite();
    await staleLimitsSave;

    expect(select.value).toBe('flow');
    expect(document.querySelector<HTMLElement>('#settings-homey-energy-meter-field')!.hidden).toBe(true);
  });

  it('rolls the select back and names the remedy when the runtime refuses Flow', async () => {
    const {
      capacity, select, applySettingsPatch, setSetting, showToast,
    } = await loadCapacityModule({
      persistedSource: 'homey_energy',
      saveResult: async () => ({ ok: false, reason: 'homey_energy_required' }),
    });
    const meterField = document.querySelector('#settings-homey-energy-meter-field') as HTMLElement;
    select.value = 'flow';

    await capacity.savePowerSourceSetting();

    // The screen never shows the unsaved choice as current: back to the last
    // confirmed source, with the meter picker visible again for it.
    expect(select.value).toBe('homey_energy');
    expect(meterField.hidden).toBe(false);
    expect(select.disabled).toBe(false);
    expect(applySettingsPatch).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
    // Error dwell: the refusal is an instruction to read.
    expect(showToast).toHaveBeenCalledWith(
      HOMES_POWER_SOURCE_NEEDED_BY_AREAS, 'warn', { durationMs: ERROR_DURATION_MS },
    );
  });

  // An unset/unavailable `power_source` read is NOT evidence that Flow is the
  // saved source. The runtime never writes a default, and a realtime cache
  // invalidation can make the read fulfil with `undefined` while `homey_energy`
  // is still persisted. Normalizing that to `flow` would fabricate a rollback
  // anchor and write a source the user never chose into the select.
  it('shows an unavailable source when the pre-change read has no value and the seam refuses', async () => {
    const { capacity, select, showToast } = await loadCapacityModule({
      persistedSource: undefined,
      saveResult: async () => ({ ok: false, reason: 'degraded' }),
    });
    select.value = 'homey_energy';

    await capacity.savePowerSourceSetting();

    expect(select.value).toBe('');
    expect(select.disabled).toBe(false);
    expect(document.querySelector<HTMLElement>('#settings-homey-energy-meter-field')!.hidden).toBe(true);
    expect(showToast).toHaveBeenCalledWith(
      HOMES_POWER_SOURCE_SAVE_DEGRADED, 'warn', { durationMs: ERROR_DURATION_MS },
    );
  });

  it('shows an unavailable source when the pre-change read has no value and the seam throws', async () => {
    const { capacity, select, showToastError } = await loadCapacityModule({
      persistedSource: null,
      saveResult: async () => { throw new Error('api down'); },
    });
    select.value = 'homey_energy';

    await capacity.savePowerSourceSetting();

    expect(select.value).toBe('');
    expect(select.disabled).toBe(false);
    expect(document.querySelector<HTMLElement>('#settings-homey-energy-meter-field')!.hidden).toBe(true);
    expect(showToastError).toHaveBeenCalledWith(expect.any(Error), HOMES_POWER_SOURCE_SAVE_FAILED);
  });

  it('rolls back and surfaces the failure toast when the seam call throws', async () => {
    const {
      capacity, select, applySettingsPatch, showToastError,
    } = await loadCapacityModule({
      persistedSource: 'flow',
      saveResult: async () => { throw new Error('api down'); },
    });
    select.value = 'homey_energy';

    await capacity.savePowerSourceSetting();

    expect(select.value).toBe('flow');
    expect(select.disabled).toBe(false);
    expect(applySettingsPatch).not.toHaveBeenCalled();
    expect(showToastError).toHaveBeenCalledWith(expect.any(Error), HOMES_POWER_SOURCE_SAVE_FAILED);
  });
});
