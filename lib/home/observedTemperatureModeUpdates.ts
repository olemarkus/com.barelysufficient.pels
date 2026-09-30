import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import {
  TEMPERATURE_CONTROL_MODES, MODE_DEVICE_TARGETS, homeScopedSettingsKey,
} from '../utils/settingsKeys';
import {
  resolveShedBehavior, shedLimitTemperatures, type ConfiguredShedBehavior,
} from '../../packages/shared-domain/src/settings/shedBehaviors';
import { readShedBehaviorsSetting } from './shedBehaviorsRead';
import {
  readTemperatureControlModes, type TemperatureControlModes,
} from '../../packages/shared-domain/src/settings/temperatureControl';
import {
  isWritableModeDeviceTargets, type ModeDeviceTargets,
} from '../../packages/shared-domain/src/settings/modeDeviceTargets';
import type { SettingsPort } from '../ports/homeyRuntime';
import type { ManualTemperaturePriceShiftPolicy } from '../ports/temperaturePriceShiftPolicy';
import { getLogger } from '../logging/logger';

export type DeviceModeForTemperatureUpdate =
  | { state: 'resolved'; mode: string | null; homeId: string; catalogHomeId: string }
  | { state: 'unavailable' };

/**
 * The temperature policy map as this service last read it. `unavailable` until
 * one read resolves — a device's policy is unknown then, and every question
 * below answers "no" rather than assume the default policy.
 */
type ControlModesRead =
  | { state: 'unavailable' }
  | { state: 'resolved'; modes: TemperatureControlModes };

/** Owns observation-origin edits to a device's active mode, including persistence. */
export class ObservedTemperatureModeUpdates {
  private readonly pendingSettings = new Map<string, { serialized: string; count: number }>();

  private controlModes: ControlModesRead = { state: 'unavailable' };

  private lastShedBehaviors: Record<string, ConfiguredShedBehavior> = {};

  constructor(
    private readonly settings: SettingsPort,
    private readonly resolveDeviceMode: (deviceId: string) => DeviceModeForTemperatureUpdate,
    private readonly isManaged: (deviceId: string) => boolean,
    private readonly reloadModeCatalogs: () => void,
    private readonly normalizeTarget: (deviceId: string, value: number) => number,
    /** Whether the latest plan has this device limited. Limiting outranks adoption. */
    private readonly isLimited: (deviceId: string) => boolean,
    private readonly priceShiftPolicy: ManualTemperaturePriceShiftPolicy,
  ) {}

  /** Solar temperature adjustments remain available under the default policy only. */
  allowsSolarAdjustments(deviceId: string): boolean {
    const read = this.readControlModes();
    return read.state === 'resolved' && read.modes[deviceId] !== 'update_mode' && read.modes[deviceId] !== 'external';
  }

  /** Temperature Smart Tasks still require the default mode-target policy. */
  allowsTemperatureSmartTasks(deviceId: string): boolean {
    return this.allowsSolarAdjustments(deviceId);
  }

  /** Price deltas remain available when manual changes update the mode target. */
  allowsPriceBasedDeltas(deviceId: string): boolean {
    const read = this.readControlModes();
    return read.state === 'resolved' && read.modes[deviceId] !== 'external';
  }

  /**
   * Whether PELS may write a LIMIT setpoint to this device. "Save as current
   * mode target" turns off solar adjustments and temperature Smart Tasks, not
   * price deltas or power limiting. The owner's limit still applies, and a
   * temperature they choose while the device is limited is drift the executor
   * reconciles rather than a new target (`update` below). Only
   * "Keep the new temperature" means PELS writes no setpoint at all.
   */
  allowsLimiting(deviceId: string): boolean {
    const read = this.readControlModes();
    return read.state === 'resolved' && read.modes[deviceId] !== 'external';
  }

  /**
   * A queued adjustment cannot outlive a switch to manual target ownership.
   *
   * Under "Save as current mode target" two writes are legitimate: the saved
   * mode target itself, the current calculated price target, and the owner's
   * configured limit — either direction's, because the fence does not know
   * which way the device is moving demand and both numbers are the owner's.
   * Solar and stale price writes remain outside the fence.
   */
  allowsTarget(deviceId: string, value: number): boolean {
    const read = this.readControlModes();
    if (read.state !== 'resolved' || read.modes[deviceId] === 'external') return false;
    if (read.modes[deviceId] !== 'update_mode') return true;
    if (this.configuredLimitTemperatures(deviceId).some((limit) => this.normalizeTarget(deviceId, limit) === value)) {
      return true;
    }
    try {
      const active = this.resolveDeviceMode(deviceId);
      if (active.state !== 'resolved' || active.mode === null) return false;
      const targets = this.settings.get(homeScopedSettingsKey(MODE_DEVICE_TARGETS, active.catalogHomeId));
      if (!isWritableModeDeviceTargets(targets)) return false;
      const target = targets[active.mode]?.[deviceId];
      return target !== undefined && (
        this.normalizeTarget(deviceId, target) === value
        || this.priceShiftPolicy.allowsCurrentPriceShiftTarget(deviceId, target, value)
      );
    } catch {
      return false;
    }
  }

  /**
   * The owner's configured limit setpoints for this device, either direction —
   * read off the same settings port the policy is, so the fence needs no second
   * injection. The key's owner (`shedBehaviors.ts`) reads the bytes.
   */
  private configuredLimitTemperatures(deviceId: string): readonly number[] {
    // An unavailable read keeps the last good map: a transient miss must not
    // refuse a limit write.
    const read = readShedBehaviorsSetting(this.settings);
    if (read.state === 'resolved') this.lastShedBehaviors = read.behaviors;
    return shedLimitTemperatures(resolveShedBehavior(this.lastShedBehaviors, deviceId));
  }

  private readControlModes(): ControlModesRead {
    try {
      const raw = this.settings.get(TEMPERATURE_CONTROL_MODES);
      const modes = readTemperatureControlModes(raw);
      if (modes) this.controlModes = { state: 'resolved', modes };
      else if (raw === null || raw === undefined) {
        const keys = this.settings.getKeys();
        if (Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === 'string')
          && !keys.includes(TEMPERATURE_CONTROL_MODES)) this.controlModes = { state: 'resolved', modes: {} };
      }
    } catch { /* Retain the last good policy. */ }
    return this.controlModes;
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
    // A fresh read, not the retained policy: adopting PERSISTS a target, and a
    // write is not something to base on a policy this read could not confirm.
    const modes = readTemperatureControlModes(this.settings.get(TEMPERATURE_CONTROL_MODES));
    if (modes === null || modes[adjustment.deviceId] !== 'update_mode') return false;
    if (!this.isManaged(adjustment.deviceId)) return false;
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
    if (!modeTargets) return;
    if (modeTargets[adjustment.deviceId] === adjustment.temperature) {
      if (!this.priceShiftPolicy.cancelCurrentPriceShift(adjustment.deviceId)) {
        throw new Error('Could not persist cancellation of the current thermostat price shift');
      }
      return;
    }
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
    if (!this.priceShiftPolicy.cancelCurrentPriceShift(adjustment.deviceId)) {
      this.rollbackModeTargets(key, targets, adjustment.deviceId);
      throw new Error('Could not persist cancellation of the current thermostat price shift');
    }
    this.reloadModeCatalogs();
    getLogger('home/temperature-mode').info({
      event: 'observed_temperature_mode_updated', ...adjustment,
      homeId: active.homeId, mode: active.mode,
    });
  }

  private rollbackModeTargets(key: string, targets: ModeDeviceTargets, deviceId: string): void {
    // Include the rollback in our notification count so delayed SDK events are
    // still consumed without triggering a second update.
    const pending = this.pendingSettings.get(key);
    this.pendingSettings.set(key, {
      serialized: JSON.stringify(targets),
      count: (pending?.count ?? 0) + 1,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.settings.set(key, targets);
        return;
      } catch {
        // Retry briefly when settings writes fail transiently.
      }
    }
    getLogger('home/temperature-mode').error({
      event: 'observed_temperature_mode_rollback_failed', deviceId, key,
    });
  }
}
