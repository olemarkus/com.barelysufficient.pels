import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import {
  MAIN_HOME_ID, TEMPERATURE_CONTROL_MODES, MODE_DEVICE_TARGETS, homeScopedSettingsKey,
} from '../utils/settingsKeys';
import {
  readTemperatureControlModes, type TemperatureControlModes,
} from '../../packages/shared-domain/src/settings/temperatureControl';
import { isWritableModeDeviceTargets } from '../../packages/shared-domain/src/settings/modeDeviceTargets';
import type {
  ResolveManualTemperatureHold, TemperaturePlanPriceLevel,
} from '../../packages/planner-types/src/temperatureSetpoints';
import type { SmartTaskInProgressRead } from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { getLogger } from '../logging/logger';

export type DeviceModeForTemperatureUpdate =
  | { state: 'resolved'; mode: string | null; homeId: string; catalogHomeId: string }
  | { state: 'unavailable' };

type ModeCatalogReader = { reloadModeCatalog: () => void };

/**
 * The temperature policy map as this service last read it. `unavailable` until
 * one read resolves — a device's policy is unknown then, and every question
 * below answers "no" rather than assume the default policy.
 */
type ControlModesRead =
  | { state: 'unavailable' }
  | { state: 'resolved'; modes: TemperatureControlModes };

type ManualTemperaturePlan = {
  homeId: string;
  mode: string;
  priceLevel: TemperaturePlanPriceLevel;
};

type ManualTemperatureState =
  | { kind: 'planned'; plan: ManualTemperaturePlan }
  | { kind: 'held'; plan: ManualTemperaturePlan; targetC: number };

const resolvePriceBaseline = (
  current: ManualTemperaturePlan, previous: ManualTemperaturePlan | undefined,
): TemperaturePlanPriceLevel => (
  current.priceLevel === 'unknown' && previous?.homeId === current.homeId && previous.priceLevel !== 'not_applied'
    ? previous.priceLevel : current.priceLevel
);

const priceLevelChanged = (
  previous: TemperaturePlanPriceLevel, current: TemperaturePlanPriceLevel,
): boolean => previous !== 'not_applied' && previous !== 'unknown'
  && current !== 'not_applied' && current !== 'unknown' && previous !== current;

/** Owns the temperature policies that adopt a setpoint observed outside PELS. */
export class ObservedTemperatureModeUpdates {
  private readonly pendingSettings = new Map<string, { serialized: string; count: number }>();

  private readonly manualTemperatures = new Map<string, ManualTemperatureState>();

  private controlModes: ControlModesRead = { state: 'unavailable' };

  // eslint-disable-next-line max-params -- Direct owner collaborators, not an argument bag.
  constructor(
    private readonly settings: SettingsPort,
    private readonly resolveDeviceMode: (deviceId: string) => DeviceModeForTemperatureUpdate,
    private readonly isManaged: (deviceId: string) => boolean,
    private readonly reloadMain: () => void,
    private readonly getAreaCatalogs: () => readonly ModeCatalogReader[],
    private readonly normalizeTarget: (deviceId: string, value: number) => number,
    /** Whether the latest plan has this device limited. Limiting outranks adoption. */
    private readonly isLimited: (deviceId: string) => boolean,
    /** Every setpoint a limit may write to this device, as the shed-behaviour producer resolves it. */
    private readonly readLimitTemperatures: (deviceId: string) => readonly number[],
    /** A temperature override while it is in force, as stored, or `null`. */
    private readonly readTemporaryTemperatureC: (deviceId: string) => number | null,
    private readonly readPreparedTemperatureC: (deviceId: string) => number | null,
    private readonly readSmartTaskInProgress: (deviceId: string) => SmartTaskInProgressRead,
  ) {}

  /** Policy reads retain the last good value across transient SDK gaps. */
  allowsAutomaticAdjustments(deviceId: string): boolean {
    const read = this.readControlModes();
    return read.state === 'resolved' && read.modes[deviceId] !== 'update_mode' && read.modes[deviceId] !== 'external';
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
    const read = this.readControlModes();
    return read.state === 'resolved' && read.modes[deviceId] !== 'external';
  }

  /**
   * A queued adjustment cannot outlive a switch to manual target ownership.
   *
   * Under "Save as current mode target" these writes are legitimate: the saved
   * mode target itself, active preparation or override targets, and
   * a limit — either direction's, because the fence
   * does not know which way the device is moving demand. The limits are the
   * shed-behaviour producer's, so a limit the planner derives is one the fence
   * admits. A queued price or solar offset is neither.
   */
  allowsTarget(deviceId: string, value: number, purpose: 'plan' | 'limit'): boolean {
    const read = this.readControlModes();
    if (read.state !== 'resolved' || read.modes[deviceId] === 'external') return false;
    if (read.modes[deviceId] === 'hold_until_change') return this.allowsManualHoldTarget(deviceId, value, purpose);
    return read.modes[deviceId] !== 'update_mode' || this.allowsAdoptedModeTarget(deviceId, value);
  }

  private allowsAdoptedModeTarget(deviceId: string, value: number): boolean {
    if (this.readLimitTemperatures(deviceId).some((limit) => this.normalizeTarget(deviceId, limit) === value)) {
      return true;
    }
    // A temperature override is the owner's own choice for now, the way
    // the saved target is; the resolver applies no offset to it.
    // Compared as the resolver commands it: a stored value off the device's step is
    // commanded on it.
    const overrideC = this.readTemporaryTemperatureC(deviceId);
    if (overrideC !== null && this.normalizeTarget(deviceId, overrideC) === value) return true;
    const preparedC = this.readPreparedTemperatureC(deviceId);
    if (preparedC !== null && this.normalizeTarget(deviceId, preparedC) === value) return true;
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
   * Capture the policy once for this build. A hold is compared with the last
   * planned mode and price level, so a boundary PELS has not planned yet can
   * still end a hold even if the adjustment arrived just after the boundary.
   */
  beginManualTemperaturePlan(homeId: string, mode: string): ResolveManualTemperatureHold {
    const read = this.readControlModes();
    return (deviceId, priceLevel, timedOverrideActive) => {
      if (read.state !== 'resolved' || read.modes[deviceId] !== 'hold_until_change') return undefined;
      return this.resolveManualTemperatureHold(deviceId, { homeId, mode, priceLevel }, timedOverrideActive);
    };
  }

  private resolveManualTemperatureHold(
    deviceId: string, current: ManualTemperaturePlan, timedOverrideActive: boolean,
  ): ReturnType<ResolveManualTemperatureHold> {
    const previous = this.manualTemperatures.get(deviceId);
    const plan = { ...current, priceLevel: resolvePriceBaseline(current, previous?.plan) };
    if (previous?.kind !== 'held' || this.manualHoldEnded(deviceId, previous.plan, plan, timedOverrideActive)) {
      this.manualTemperatures.set(deviceId, { kind: 'planned', plan });
      return undefined;
    }
    this.manualTemperatures.set(deviceId, { ...previous, plan });
    return {
      targetC: previous.targetC,
      releasesOnPriceLevelChange: current.priceLevel !== 'not_applied',
      releasesOnSmartTask: current.homeId === MAIN_HOME_ID,
    };
  }

  private manualHoldEnded(
    deviceId: string, previous: ManualTemperaturePlan, plan: ManualTemperaturePlan, timedOverrideActive: boolean,
  ): boolean {
    return previous.homeId !== plan.homeId || previous.mode !== plan.mode
      || priceLevelChanged(previous.priceLevel, plan.priceLevel)
      || timedOverrideActive || !this.isManaged(deviceId)
      || this.readTaskState(deviceId, plan.homeId) === 'in_progress';
  }

  private readTaskState(deviceId: string, homeId: string): SmartTaskInProgressRead {
    return homeId === MAIN_HOME_ID ? this.readSmartTaskInProgress(deviceId) : 'none';
  }

  hasManualTemperatureHold(deviceId: string): boolean {
    return this.manualTemperatures.get(deviceId)?.kind === 'held';
  }

  private allowsManualHoldTarget(deviceId: string, value: number, purpose: 'plan' | 'limit'): boolean {
    const hold = this.manualTemperatures.get(deviceId);
    if (hold?.kind !== 'held') return true;
    const active = this.resolveDeviceMode(deviceId);
    if (!this.isManaged(deviceId) || (active.state === 'resolved' && active.homeId !== hold.plan.homeId)) {
      this.manualTemperatures.delete(deviceId);
      return true;
    }
    // Only the resolver releases on a mode or price change. Until then an
    // ordinary queued command must still agree with the hold.
    const overrideC = this.readTemporaryTemperatureC(deviceId);
    return purpose === 'limit' || value === this.normalizeTarget(deviceId, overrideC ?? hold.targetC);
  }

  private readControlModes(): ControlModesRead {
    try {
      const raw = this.settings.get(TEMPERATURE_CONTROL_MODES);
      const modes = readTemperatureControlModes(raw);
      if (modes) this.controlModes = { state: 'resolved', modes };
      else if (raw === null || raw === undefined) {
        const keyList = readSettingsKeyList(this.settings);
        if (keyList.status === 'resolved' && !keyList.keys.includes(TEMPERATURE_CONTROL_MODES)) {
          this.controlModes = { state: 'resolved', modes: {} };
        }
      }
    } catch { /* Retain the last good policy. */ }
    return this.controlModes;
  }

  /** Consume our own notifications, including deferred/coalesced SDK delivery.
   * A different persisted value belongs to another editor and takes the ordinary path. */
  consumeSettingChange(key: string): boolean {
    if (key === TEMPERATURE_CONTROL_MODES) this.pruneManualTemperaturePlans();
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

  private pruneManualTemperaturePlans(): void {
    const read = this.readControlModes();
    if (read.state !== 'resolved') return;
    for (const deviceId of this.manualTemperatures.keys()) {
      if (read.modes[deviceId] !== 'hold_until_change') this.manualTemperatures.delete(deviceId);
    }
  }

  accept(adjustment: ExternalTemperatureAdjustment): void {
    try {
      this.acceptExternalAdjustment(adjustment);
    } catch (error) {
      getLogger('home/temperature-mode').error({
        event: 'observed_temperature_mode_update_failed', deviceId: adjustment.deviceId, err: error,
      });
    }
  }

  private acceptExternalAdjustment(adjustment: ExternalTemperatureAdjustment): void {
    const { deviceId } = adjustment;
    // Starting a hold or persisting a target requires a fresh policy read.
    const mode = readTemperatureControlModes(this.settings.get(TEMPERATURE_CONTROL_MODES))?.[deviceId];
    if (mode !== 'update_mode' && mode !== 'hold_until_change') return;
    if (!this.isManaged(deviceId)) return;
    const skipped = this.skipReason(deviceId);
    if (skipped !== null) {
      if (mode === 'update_mode') getLogger('home/temperature-mode').info({ event: skipped, ...adjustment });
      return;
    }
    if (mode === 'update_mode') this.update(adjustment);
    else this.startManualHold(adjustment);
  }

  private startManualHold(adjustment: ExternalTemperatureAdjustment): void {
    const { deviceId, temperature } = adjustment;
    const active = this.resolveDeviceMode(deviceId);
    if (active.state !== 'resolved' || active.mode === null || this.readTaskState(deviceId, active.homeId) !== 'none') {
      return;
    }
    const previous = this.manualTemperatures.get(deviceId)?.plan;
    const plan: ManualTemperaturePlan = previous?.homeId === active.homeId
      ? previous : { homeId: active.homeId, mode: active.mode, priceLevel: 'unknown' };
    this.manualTemperatures.set(deviceId, {
      kind: 'held', targetC: this.normalizeTarget(deviceId, temperature), plan,
    });
  }

  /** A device can report a clamped or rounded answer to its active limit. */
  private skipReason(deviceId: string): string | null {
    if (this.isLimited(deviceId)) return 'observed_temperature_mode_update_skipped_while_limited';
    if (this.readTemporaryTemperatureC(deviceId) !== null) {
      return 'observed_temperature_mode_update_skipped_while_overridden';
    }
    if (this.readPreparedTemperatureC(deviceId) !== null) {
      return 'observed_temperature_mode_update_skipped_while_preparing_mode';
    }
    return null;
  }

  private update(adjustment: ExternalTemperatureAdjustment): void {
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
