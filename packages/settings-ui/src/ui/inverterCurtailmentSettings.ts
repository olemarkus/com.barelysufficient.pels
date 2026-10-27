import { asUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import {
  INVERTER_CURTAILMENT_DEVICES, parseInverterCurtailmentDevices, type InverterCurtailmentDevices,
} from '../../../shared-domain/src/settings/inverterCurtailment.ts';
import { callApi, getApiReadModel, getSetting, getSettingFresh, invalidateApiCache, setSetting } from './homey.ts';
import { SETTINGS_UI_BOOTSTRAP_PATH, SETTINGS_UI_DEVICES_PATH } from '../../../contracts/src/settingsUiApi.ts';
import type { InverterCurtailmentSettingsProps, InverterSettingsRead } from './views/InverterCurtailmentSettings.tsx';

function parseDevices(raw: unknown): InverterSettingsRead['devices'] {
  const value = asUnknownRecord(raw);
  const devices = value?.inverterDevices;
  if (asUnknownRecord(value?.homeScope)?.state === 'unavailable' || !Array.isArray(devices)
    || !devices.every((entry: unknown) => {
      const device = asUnknownRecord(entry);
      return typeof device?.id === 'string' && device.id.length > 0 && typeof device.name === 'string';
    })) throw new Error('Invalid inverter device response');
  return devices as InverterSettingsRead['devices'];
}

async function readSelected(fresh: boolean): Promise<InverterCurtailmentDevices> {
  const raw = await (fresh ? getSettingFresh(INVERTER_CURTAILMENT_DEVICES) : getSetting(INVERTER_CURTAILMENT_DEVICES));
  if (raw != null) {
    const parsed = parseInverterCurtailmentDevices(raw);
    if (parsed === null) throw new Error('Invalid inverter settings');
    return parsed;
  }
  // Only a new runtime-owner read can distinguish a never-written key from a
  // transient WebView miss. Do not merge into the UI's last accepted map.
  const bootstrap = asUnknownRecord(await callApi<unknown>('GET', SETTINGS_UI_BOOTSTRAP_PATH));
  const selected = parseInverterCurtailmentDevices(
    asUnknownRecord(bootstrap?.settings)?.[INVERTER_CURTAILMENT_DEVICES],
  );
  if (selected === null) throw new Error('Inverter settings are unavailable');
  return selected;
}

/** Owns the settings read, write and refresh lifecycle; the view receives props only. */
export class InverterCurtailmentSettingsController {
  private read: InverterSettingsRead | null = null;
  private loaded = false;
  private busy = false;
  private readError = '';
  private writeError = '';
  private generation = 0;

  constructor(private readonly changed: () => void) {}

  ensureLoaded(): void {
    if (!this.loaded) void this.reload();
  }

  settingChanged(key: string): void {
    if (key !== INVERTER_CURTAILMENT_DEVICES) return;
    if (this.loaded) void this.reload();
  }

  props(): InverterCurtailmentSettingsProps {
    return {
      read: this.read, busy: this.busy, error: this.writeError || this.readError,
      onEnabledChange: (id, enabled) => { void this.save(id, enabled); },
      onRetry: () => { invalidateApiCache(SETTINGS_UI_DEVICES_PATH); void this.reload(); },
    };
  }

  private async reload(): Promise<void> {
    this.loaded = true;
    const generation = ++this.generation;
    this.readError = '';
    try {
      const [devices, selected] = await Promise.all([
        getApiReadModel<unknown>(SETTINGS_UI_DEVICES_PATH).then(parseDevices), readSelected(false),
      ]);
      const next = { devices, selected };
      if (generation === this.generation) this.read = next;
    } catch {
      if (generation === this.generation) this.readError = 'Inverter settings could not be loaded.';
    }
    if (generation === this.generation) this.changed();
  }

  private async save(deviceId: string, enabled: boolean): Promise<void> {
    if (this.read === null || this.busy) return;
    const previous = this.read;
    const selected = { ...previous.selected, [deviceId]: enabled };
    this.busy = true;
    this.writeError = '';
    this.read = { ...previous, selected };
    this.changed();
    try {
      // Preserve other inverters' changes, including a runtime owner-mode opt-out.
      const current = await readSelected(true);
      const next = { ...current, [deviceId]: enabled };
      this.read = { ...previous, selected: next };
      await setSetting(INVERTER_CURTAILMENT_DEVICES, next);
    } catch {
      this.read = previous;
      this.writeError = 'The change was not saved. Try again.';
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
