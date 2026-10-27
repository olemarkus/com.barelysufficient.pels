import { asUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import {
  INVERTER_CURTAILMENT_DEVICES, parseInverterCurtailmentDevices,
} from '../../../shared-domain/src/settings/inverterCurtailment.ts';
import { getApiReadModel, invalidateApiCache, setSetting } from './homey.ts';
import type { InverterCurtailmentSettingsProps, InverterSettingsRead } from './views/InverterCurtailmentSettings.tsx';

const PATH = '/ui_inverter_curtailment';

function parseRead(raw: unknown): InverterSettingsRead {
  const value = asUnknownRecord(raw);
  const selected = parseInverterCurtailmentDevices(value?.selected);
  const devices = value?.devices;
  if (selected === null || !Array.isArray(devices) || !devices.every((entry: unknown) => {
    const device = asUnknownRecord(entry);
    return typeof device?.id === 'string' && device.id.length > 0 && typeof device.name === 'string';
  })) throw new Error('Invalid inverter settings response');
  return { selected, devices: devices as InverterSettingsRead['devices'] };
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
    invalidateApiCache(PATH);
    if (this.loaded) void this.reload();
  }

  props(): InverterCurtailmentSettingsProps {
    return {
      read: this.read, busy: this.busy, error: this.writeError || this.readError,
      onEnabledChange: (id, enabled) => { void this.save(id, enabled); },
      onRetry: () => { void this.reload(); },
    };
  }

  private async reload(): Promise<void> {
    this.loaded = true;
    const generation = ++this.generation;
    this.readError = '';
    invalidateApiCache(PATH);
    try {
      const next = parseRead(await getApiReadModel<unknown>(PATH));
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
      invalidateApiCache(PATH);
      const current = parseRead(await getApiReadModel<unknown>(PATH));
      const next = { ...current.selected, [deviceId]: enabled };
      this.read = { ...current, selected: next };
      await setSetting(INVERTER_CURTAILMENT_DEVICES, next);
      invalidateApiCache(PATH);
    } catch {
      this.read = previous;
      this.writeError = 'The change was not saved. Try again.';
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
