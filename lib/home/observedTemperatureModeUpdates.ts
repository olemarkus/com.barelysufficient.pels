import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import {
  TEMPERATURE_CONTROL_MODES, MODE_DEVICE_TARGETS, OVERSHOOT_BEHAVIORS, homeScopedSettingsKey,
} from '../utils/settingsKeys';
import {
  configuredShedTemperatures, normalizeShedBehaviors, type ConfiguredShedBehavior,
} from '../utils/capacityHelpers';
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

  private lastShedBehaviors: Record<string, ConfiguredShedBehavior> = {};

  constructor(
    private readonly settings: SettingsPort,
    private readonly resolveDeviceMode: (deviceId: string) => DeviceModeForTemperatureUpdate,
    private readonly isManaged: (deviceId: string) => boolean,
    private readonly reloadMain: () => void,
    private readonly getAreaCatalogs: () => readonly ModeCatalogReader[],
    private readonly normalizeTarget: (deviceId: string, value: number) => number,
    /** Whether the latest plan has this device limited. Limiting outranks adoption. */
    private readonly isLimited: (deviceId: string) => boolean,
  ) {}

  /** Policy reads retain the last good value across transient SDK gaps. */
  allowsAutomaticAdjustments(deviceId: string): boolean {
    const modes = this.readControlModes();
    return modes !== undefined && modes[deviceId] !== 'update_mode' && modes[deviceId] !== 'external';
  }

  /**
   * Whether PELS may write a LIMIT setpoint to this device. Narrower than the
   * adjustments question above: "Save as current mode target" turns off the
   * price and solar offsets, not power limiting — the owner's limit still
   * applies, and a temperature they choose while the device is limited is drift
   * the executor reconciles rather than a new target (`update` below). Only
   * "Keep the new temperature" means PELS writes no setpoint at all.
   */
  allowsLimiting(deviceId: string): boolean {
    const modes = this.readControlModes();
    return modes !== undefined && modes[deviceId] !== 'external';
  }

  /**
   * A queued adjustment cannot outlive a switch to manual target ownership.
   *
   * Under "Save as current mode target" two writes are legitimate: the saved
   * mode target itself, and the owner's configured limit — either direction's,
   * because the fence does not know which way the device is moving demand and
   * both numbers are the owner's. A queued price or solar offset is neither.
   */
  allowsTarget(deviceId: string, value: number): boolean {
    const modes = this.readControlModes();
    if (!modes || modes[deviceId] === 'external') return false;
    if (modes[deviceId] !== 'update_mode') return true;
    if (this.configuredLimitTemperatures(deviceId).some((limit) => this.normalizeTarget(deviceId, limit) === value)) {
      return true;
    }
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

  /**
   * The owner's configured limit setpoints for this device, either direction —
   * read off the same settings port the policy is, so the fence needs no second
   * injection. The normalizer is the one writer of that map's shape.
   */
  private configuredLimitTemperatures(deviceId: string): readonly number[] {
    try {
      const raw = this.settings.get(OVERSHOOT_BEHAVIORS);
      // The key is written as a map and never cleared, so a non-map read is a
      // transient miss, not an emptied map: keep the last good one. A key never
      // written reads as the empty map this starts with.
      if (typeof raw === 'object' && raw !== null) this.lastShedBehaviors = normalizeShedBehaviors(raw);
    } catch { /* Retain the last good map: a transient miss must not refuse a limit write. */ }
    return configuredShedTemperatures(deviceId, this.lastShedBehaviors);
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

  /**
   * Whether this adjustment is one the owner meant as a preference.
   *
   * Policy and management first. Then: a change made while PELS has the device
   * limited is a reaction to the limit, not a new preference — saving it would
   * turn "I nudged the thermostat back up during a peak" into the mode's target
   * for good. Not adopted, so the executor sees observed and desired disagree
   * and converges the device back onto its limit: ordinary drift, like any
   * other external change.
   */
  private adopts(adjustment: ExternalTemperatureAdjustment): boolean {
    const modes = readTemperatureControlModes(this.settings.get(TEMPERATURE_CONTROL_MODES));
    if (modes?.[adjustment.deviceId] !== 'update_mode' || !this.isManaged(adjustment.deviceId)) return false;
    if (!this.isLimited(adjustment.deviceId)) return true;
    getLogger('home/temperature-mode').info({
      event: 'observed_temperature_mode_update_skipped_while_limited', ...adjustment,
    });
    return false;
  }

  private update(adjustment: ExternalTemperatureAdjustment): void {
    if (!this.adopts(adjustment)) return;
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
