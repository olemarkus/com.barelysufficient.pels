import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import { TEMPERATURE_CONTROL_MODES, MODE_DEVICE_TARGETS, homeScopedSettingsKey } from '../utils/settingsKeys';
import {
  readTemperatureControlModes, type TemperatureControlModes,
} from '../../packages/shared-domain/src/settings/temperatureControl';
import { isWritableModeDeviceTargets } from '../../packages/shared-domain/src/settings/modeDeviceTargets';
import type { SettingsPort } from '../ports/homeyRuntime';
import { getLogger } from '../logging/logger';

export type DeviceModeForTemperatureUpdate =
  | { state: 'resolved'; mode: string | null; homeId: string; catalogHomeId: string }
  | { state: 'unavailable' };

type ModeCatalogReader = { reloadModeCatalog: () => void };

/** Owns observation-origin edits to a device's active mode, including persistence. */
export class ObservedTemperatureModeUpdates {
  private readonly pendingSettings = new Map<string, { serialized: string; count: number }>();

  private lastControlModes?: TemperatureControlModes;

  constructor(
    private readonly settings: SettingsPort,
    private readonly resolveDeviceMode: (deviceId: string) => DeviceModeForTemperatureUpdate,
    private readonly isManaged: (deviceId: string) => boolean,
    private readonly reloadMain: () => void,
    private readonly getAreaCatalogs: () => readonly ModeCatalogReader[],
    private readonly normalizeTarget: (deviceId: string, value: number) => number,
  ) {}

  /** Policy reads retain the last good value across transient SDK gaps. */
  allowsAutomaticAdjustments(deviceId: string): boolean {
    const modes = this.readControlModes();
    return modes !== undefined && modes[deviceId] !== 'update_mode' && modes[deviceId] !== 'external';
  }

  /** A queued adjustment cannot outlive a switch to manual target ownership. */
  allowsTarget(deviceId: string, value: number): boolean {
    const modes = this.readControlModes();
    if (!modes || modes[deviceId] === 'external') return false;
    if (modes[deviceId] !== 'update_mode') return true;
    try {
      const active = this.resolveDeviceMode(deviceId);
      if (active.state !== 'resolved' || active.mode === null) return false;
      const targets = this.settings.get(homeScopedSettingsKey(MODE_DEVICE_TARGETS, active.catalogHomeId));
      if (!isWritableModeDeviceTargets(targets)) return false;
      const target = targets[active.mode]?.[deviceId];
      return target !== undefined && this.normalizeTarget(deviceId, target) === value;
    } catch {
      return false;
    }
  }

  private readControlModes(): TemperatureControlModes | undefined {
    try {
      const raw = this.settings.get(TEMPERATURE_CONTROL_MODES);
      const modes = readTemperatureControlModes(raw);
      if (modes) this.lastControlModes = modes;
      else if (raw === null || raw === undefined) {
        const keys = this.settings.getKeys();
        if (Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === 'string')
          && !keys.includes(TEMPERATURE_CONTROL_MODES)) this.lastControlModes = {};
      }
    } catch { /* Retain the last good policy. */ }
    return this.lastControlModes;
  }

  /** Consume our own notifications, including deferred/coalesced SDK delivery.
   * A different persisted value belongs to another editor and takes the ordinary path. */
  consumeSettingChange(key: string): boolean {
    const pending = this.pendingSettings.get(key);
    if (!pending) return false;
    try {
      const current = this.settings.get(key);
      if (!isWritableModeDeviceTargets(current)) return true;
      if (JSON.stringify(current) !== pending.serialized) {
        this.pendingSettings.delete(key);
        return false;
      }
    } catch {
      return true;
    }
    if (pending.count === 1) this.pendingSettings.delete(key);
    else this.pendingSettings.set(key, { ...pending, count: pending.count - 1 });
    return true;
  }

  accept(adjustment: ExternalTemperatureAdjustment): void {
    try {
      this.update(adjustment);
    } catch (error) {
      getLogger('home/temperature-mode').error({
        event: 'observed_temperature_mode_update_failed', deviceId: adjustment.deviceId, err: error,
      });
    }
  }

  private update(adjustment: ExternalTemperatureAdjustment): void {
    const modes = readTemperatureControlModes(this.settings.get(TEMPERATURE_CONTROL_MODES));
    if (modes?.[adjustment.deviceId] !== 'update_mode' || !this.isManaged(adjustment.deviceId)) return;
    // Bind the edit to this resolved mode before touching persistence. This
    // operation is synchronous: a queued mode change cannot retarget the edit.
    const active = this.resolveDeviceMode(adjustment.deviceId);
    if (active.state !== 'resolved' || active.mode === null) return;
    const key = homeScopedSettingsKey(MODE_DEVICE_TARGETS, active.catalogHomeId);
    const targets = this.settings.get(key);
    // A failed/partial read cannot be a basis for replacing a whole catalog.
    if (!isWritableModeDeviceTargets(targets) || !Object.hasOwn(targets, active.mode)) return;
    const modeTargets = targets[active.mode];
    if (!modeTargets || modeTargets[adjustment.deviceId] === adjustment.temperature) return;
    const next = {
      ...targets,
      [active.mode]: { ...modeTargets, [adjustment.deviceId]: adjustment.temperature },
    };
    const previousNotification = this.pendingSettings.get(key);
    this.pendingSettings.set(key, { serialized: JSON.stringify(next), count: (previousNotification?.count ?? 0) + 1 });
    try {
      this.settings.set(key, next);
    } catch (error) {
      if (previousNotification) this.pendingSettings.set(key, previousNotification);
      else this.pendingSettings.delete(key);
      throw error;
    }
    this.reloadMain();
    for (const catalog of this.getAreaCatalogs()) catalog.reloadModeCatalog();
    getLogger('home/temperature-mode').info({
      event: 'observed_temperature_mode_updated', ...adjustment,
      homeId: active.homeId, mode: active.mode,
    });
  }
}
