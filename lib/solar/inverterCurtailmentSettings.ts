import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import {
  INVERTER_CURTAILMENT_DEVICES,
  isInverterCurtailmentEnabled,
  parseInverterCurtailmentDevices,
  type InverterCurtailmentDevices,
} from '../../packages/shared-domain/src/settings/inverterCurtailment';

/** Unreadable settings retain the last accepted opt-in; first-read failure is off. */
export class InverterCurtailmentSettings {
  private accepted: InverterCurtailmentDevices = {};
  constructor(private readonly settings: SettingsPort) {}

  isEnabled(deviceId: string): boolean { return isInverterCurtailmentEnabled(this.read(), deviceId); }

  /** An explicit change in the inverter app ends this opt-in. */
  disable(deviceId: string): void {
    const keys = readSettingsKeyList(this.settings);
    if (keys.status !== 'resolved') throw new Error('Inverter settings could not be read.');
    const saved = this.settings.get(INVERTER_CURTAILMENT_DEVICES);
    const current = !keys.keys.includes(INVERTER_CURTAILMENT_DEVICES) ? {} : parseInverterCurtailmentDevices(saved);
    if (current === null) throw new Error('Inverter settings could not be read.');
    const next = { ...current, [deviceId]: false };
    this.settings.set(INVERTER_CURTAILMENT_DEVICES, next);
    this.accepted = next;
  }

  read(): InverterCurtailmentDevices {
    const keys = readSettingsKeyList(this.settings);
    if (keys.status !== 'resolved') return this.accepted;
    if (!keys.keys.includes(INVERTER_CURTAILMENT_DEVICES)) {
      this.accepted = {};
      return this.accepted;
    }
    try {
      const parsed = parseInverterCurtailmentDevices(this.settings.get(INVERTER_CURTAILMENT_DEVICES));
      if (parsed !== null) this.accepted = parsed;
    } catch { /* Keep the accepted configuration on a transient read failure. */ }
    return this.accepted;
  }
}
