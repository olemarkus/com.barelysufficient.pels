import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import {
  INVERTER_CURTAILMENT_DEVICES,
  isInverterCurtailmentEnabled,
  parseInverterCurtailmentDevices,
  type InverterCurtailmentDevices,
} from '../../packages/shared-domain/src/settings/inverterCurtailment';

/** Resolve absence at the settings boundary; null means no authoritative read. */
export function readInverterCurtailmentDevices(settings: SettingsPort): InverterCurtailmentDevices | null {
  const keys = readSettingsKeyList(settings);
  if (keys.status !== 'resolved') return null;
  if (!keys.keys.includes(INVERTER_CURTAILMENT_DEVICES)) return {};
  try { return parseInverterCurtailmentDevices(settings.get(INVERTER_CURTAILMENT_DEVICES)); } catch { return null; }
}

/** Unreadable settings retain the last accepted opt-in; first-read failure is off. */
export class InverterCurtailmentSettings {
  private accepted: InverterCurtailmentDevices = {};
  constructor(private readonly settings: SettingsPort) {}

  isEnabled(deviceId: string): boolean { return isInverterCurtailmentEnabled(this.read(), deviceId); }

  /** An explicit change in the inverter app ends this opt-in. */
  disable(deviceId: string): void {
    const current = readInverterCurtailmentDevices(this.settings);
    if (current === null) throw new Error('Inverter settings could not be read.');
    const next = { ...current, [deviceId]: false };
    this.settings.set(INVERTER_CURTAILMENT_DEVICES, next);
    this.accepted = next;
  }

  read(): InverterCurtailmentDevices {
    const parsed = readInverterCurtailmentDevices(this.settings);
    if (parsed !== null) this.accepted = parsed;
    return this.accepted;
  }
}
