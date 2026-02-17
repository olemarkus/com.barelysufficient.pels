import Homey from 'homey';
import CapacityGuard from '../core/capacityGuard';
import { DeviceManager } from '../core/deviceManager';
import type { DevicePlan, ShedAction } from './planTypes';
import type { TargetDeviceSnapshot } from '../utils/types';
import type { PlanEngineState } from './planState';
import { incPerfCounter } from '../utils/perfCounters';

export type PlanExecutorDeps = {
  homey: Homey.App['homey'];
  deviceManager: DeviceManager;
  getCapacityGuard: () => CapacityGuard | undefined;
  getCapacitySettings: () => { limitKw: number; marginKw: number };
  getCapacityDryRun: () => boolean;
  getOperatingMode: () => string;
  getShedBehavior: (deviceId: string) => { action: ShedAction; temperature: number | null };
  applySheddingToDevice?: (deviceId: string, deviceName?: string, reason?: string) => Promise<void>;
  updateLocalSnapshot: (deviceId: string, updates: { target?: number | null; on?: boolean }) => void;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export class PlanExecutor {
  private applySheddingToDeviceCallback: (deviceId: string, deviceName?: string, reason?: string) => Promise<void>;

  constructor(private deps: PlanExecutorDeps, private state: PlanEngineState) {
    this.applySheddingToDeviceCallback = deps.applySheddingToDevice
      ?? ((deviceId, deviceName, reason) => this.applySheddingToDevice(deviceId, deviceName, reason));
  }

  private get deviceManager(): DeviceManager {
    return this.deps.deviceManager;
  }

  private get capacityGuard(): CapacityGuard | undefined {
    return this.deps.getCapacityGuard();
  }

  private get capacitySettings(): { limitKw: number; marginKw: number } {
    return this.deps.getCapacitySettings();
  }

  private get capacityDryRun(): boolean {
    return this.deps.getCapacityDryRun();
  }

  private get operatingMode(): string {
    return this.deps.getOperatingMode();
  }

  private log(...args: unknown[]): void {
    this.deps.log(...args);
  }

  private logDebug(...args: unknown[]): void {
    this.deps.logDebug(...args);
  }

  private error(...args: unknown[]): void {
    this.deps.error(...args);
  }

  private updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void {
    this.deps.updateLocalSnapshot(deviceId, updates);
  }

  private getShedBehavior(deviceId: string): { action: ShedAction; temperature: number | null } {
    return this.deps.getShedBehavior(deviceId);
  }

  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    return this.deviceManager.getSnapshot();
  }

  private async applyShedAction(dev: DevicePlan['devices'][number]): Promise<boolean> {
    if (dev.plannedState !== 'shed') return false;
    const shedAction = dev.shedAction ?? 'turn_off';
    if (shedAction === 'set_temperature') {
      await this.applyShedTemperature(dev);
      return true;
    }
    await this.applyShedOff(dev);
    return true;
  }

  private async applyShedTemperature(dev: DevicePlan['devices'][number]): Promise<void> {
    const plan = this.getShedTemperaturePlan(dev);
    if (!plan) return;
    await this.applyShedTemperaturePlan(dev, plan.targetCap, plan.plannedTarget);
  }

  private getShedTemperaturePlan(dev: DevicePlan['devices'][number]): { targetCap: string; plannedTarget: number } | null {
    const snapshot = this.getShedTemperatureSnapshot(dev.id);
    const currentTarget = typeof snapshot.currentTarget === 'number' ? snapshot.currentTarget : dev.currentTarget;
    if (this.shouldSkipShedTemperature(dev, snapshot.targetCap, currentTarget)) return null;
    if (typeof dev.plannedTarget !== 'number') return null;
    return { targetCap: snapshot.targetCap as string, plannedTarget: dev.plannedTarget };
  }

  private getShedTemperatureSnapshot(deviceId: string): { targetCap: string | undefined; currentTarget: unknown } {
    const snapshotEntry = this.latestTargetSnapshot.find((d) => d.id === deviceId);
    return {
      targetCap: snapshotEntry?.targets?.[0]?.id,
      currentTarget: snapshotEntry?.targets?.[0]?.value,
    };
  }

  private shouldSkipShedTemperature(
    dev: DevicePlan['devices'][number],
    targetCap: string | undefined,
    currentTarget: unknown,
  ): boolean {
    if (this.capacityDryRun) {
      this.log(`Capacity (dry run): would set ${targetCap || 'target'} for ${dev.name || dev.id} to ${dev.plannedTarget ?? '–'}°C (overshoot)`);
      return true;
    }
    if (!targetCap || typeof dev.plannedTarget !== 'number') return true;
    if (typeof currentTarget === 'number' && currentTarget === dev.plannedTarget) {
      this.logDebug(`Capacity: skip setting ${targetCap || 'target'} for ${dev.name || dev.id}, already at ${dev.plannedTarget}°C`);
      return true;
    }
    return false;
  }

  private async applyShedTemperaturePlan(
    dev: DevicePlan['devices'][number],
    targetCap: string,
    plannedTarget: number,
  ): Promise<void> {
    try {
      await this.deviceManager.setCapability(dev.id, targetCap, plannedTarget);
      this.log(`Capacity: set ${targetCap} for ${dev.name || dev.id} to ${plannedTarget}°C (overshoot)`);
      this.updateLocalSnapshot(dev.id, { target: plannedTarget });
      const now = Date.now();
      this.state.lastDeviceShedMs[dev.id] = now;
      const guardShedding = this.capacityGuard?.isSheddingActive?.() === true;
      const guardHeadroom = this.capacityGuard?.getHeadroom?.();
      if (guardShedding || (typeof guardHeadroom === 'number' && guardHeadroom < 0)) {
        this.state.lastSheddingMs = now;
        this.state.lastOvershootMs = now;
      }
    } catch (error) {
      this.error(`Failed to set overshoot temperature for ${dev.name || dev.id} via DeviceManager`, error);
    }
  }

  private async applyShedOff(dev: DevicePlan['devices'][number]): Promise<void> {
    if (dev.currentState === 'off') return;
    const reason = dev.reason;
    const isSwap = reason ? reason.includes('swapped out for') : false;
    await this.applySheddingToDeviceCallback(dev.id, dev.name, isSwap ? reason : undefined);
  }

  private async applyRestorePower(dev: DevicePlan['devices'][number]): Promise<void> {
    if (dev.plannedState === 'shed' || dev.currentState !== 'off') return;
    const snapshot = this.latestTargetSnapshot.find((d) => d.id === dev.id);
    if (!this.canTurnOnDevice(snapshot)) {
      this.logDebug(`Capacity: skip restoring ${dev.name || dev.id}, cannot turn on from current snapshot`);
      return;
    }
    const name = dev.name || dev.id;
    // Check if this device is already being restored (in-flight)
    if (this.state.pendingRestores.has(dev.id)) {
      this.logDebug(`Capacity: skip restoring ${name}, already in progress`);
      return;
    }
    // Mark as pending before async operation
    this.state.pendingRestores.add(dev.id);
    try {
      try {
        await this.deviceManager.setCapability(dev.id, 'onoff', true);
        this.log(`Capacity: turning on ${name} (restored from shed/off state)`);
        this.state.lastRestoreMs = Date.now(); // Track when we restored so we can wait for power to stabilize
        this.state.lastDeviceRestoreMs[dev.id] = this.state.lastRestoreMs;
        // Clear this device from pending swap targets if it was one
        this.state.pendingSwapTargets.delete(dev.id);
        delete this.state.pendingSwapTimestamps[dev.id];
      } catch (error) {
        this.error(`Failed to turn on ${name} via DeviceManager`, error);
      }
    } finally {
      this.state.pendingRestores.delete(dev.id);
    }
  }

  private async applyTargetUpdate(dev: DevicePlan['devices'][number], snapshot?: TargetDeviceSnapshot): Promise<void> {
    const plan = this.getTargetUpdatePlan(dev, snapshot);
    if (!plan) return;
    await this.applyTargetUpdatePlan(dev, plan.targetCap, plan.isRestoring);
  }

  private async applyUncontrolledRestore(
    dev: DevicePlan['devices'][number],
    snapshot?: TargetDeviceSnapshot,
  ): Promise<void> {
    if (dev.currentState !== 'off') return;
    const lastShed = this.state.lastDeviceShedMs[dev.id];
    if (!lastShed) return;
    const entry = snapshot ?? this.latestTargetSnapshot.find((d) => d.id === dev.id);
    if (!this.canTurnOnDevice(entry)) return;
    const name = dev.name || dev.id;
    try {
      await this.deviceManager.setCapability(dev.id, 'onoff', true);
      this.log(`Capacity control off: turning on ${name}`);
      this.updateLocalSnapshot(dev.id, { on: true });
      delete this.state.lastDeviceShedMs[dev.id];
    } catch (error) {
      this.error(`Failed to restore ${name} via DeviceManager`, error);
    }
  }

  private getTargetUpdatePlan(
    dev: DevicePlan['devices'][number],
    snapshot?: TargetDeviceSnapshot,
  ): { targetCap: string; isRestoring: boolean } | null {
    if (typeof dev.plannedTarget !== 'number' || dev.plannedTarget === dev.currentTarget) return null;
    const entry = snapshot ?? this.latestTargetSnapshot.find((d) => d.id === dev.id);
    const targetCap = entry?.targets?.[0]?.id;
    if (!targetCap) return null;

    // Check if this is a restoration (increasing temperature from shed state)
    const currentIsNumber = typeof dev.currentTarget === 'number';
    const shedBehavior = this.getShedBehavior(dev.id);
    const wasAtShedTemp = currentIsNumber && shedBehavior.action === 'set_temperature'
      && shedBehavior.temperature !== null && dev.currentTarget === shedBehavior.temperature;
    const isRestoring = wasAtShedTemp && dev.plannedTarget > (dev.currentTarget as number);
    return { targetCap, isRestoring };
  }

  private canTurnOnDevice(snapshot?: TargetDeviceSnapshot): boolean {
    if (!snapshot) return false;
    if (snapshot.available === false) return false;
    const hasOnOff = snapshot.capabilities?.includes('onoff') === true;
    if (!hasOnOff) return false;
    if (snapshot.currentOn === undefined && snapshot.canSetOnOff === false) {
      return false;
    }
    return snapshot.canSetOnOff !== false;
  }

  private shouldSkipUnavailable(snapshot: TargetDeviceSnapshot | undefined, name: string, operation: string): boolean {
    if (snapshot?.available !== false) return false;
    this.logDebug(`Capacity: skip ${operation} for ${name}, device unavailable`);
    return true;
  }

  private async applyTargetUpdatePlan(
    dev: DevicePlan['devices'][number],
    targetCap: string,
    isRestoring: boolean,
  ): Promise<void> {
    try {
      await this.deviceManager.setCapability(dev.id, targetCap, dev.plannedTarget as number);
      const fromStr = dev.currentTarget === undefined || dev.currentTarget === null
        ? ''
        : `from ${dev.currentTarget} `;
      this.log(
        `Set ${targetCap} for ${dev.name || dev.id} ${fromStr}to ${dev.plannedTarget} (mode: ${this.operatingMode})`,
      );
      this.updateLocalSnapshot(dev.id, { target: dev.plannedTarget as number });

      // If this was a restoration from shed temperature, update lastRestoreMs
      // This ensures cooldown applies between restoring different devices
      if (isRestoring) {
        this.state.lastRestoreMs = Date.now();
        this.state.lastDeviceRestoreMs[dev.id] = this.state.lastRestoreMs;
      }
    } catch (error) {
      this.error(`Failed to set ${targetCap} for ${dev.name || dev.id} via DeviceManager`, error);
    }
  }

  public async applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    if (this.capacityDryRun) return;
    const snapshotState = this.latestTargetSnapshot.find((d) => d.id === deviceId);
    if (this.shouldSkipShedding(deviceId, deviceName, snapshotState)) return;
    const name = deviceName || deviceId;
    const shedBehavior = this.getShedBehavior(deviceId);
    const targetCap = snapshotState?.targets?.[0]?.id;
    const shedTemp = shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null
      ? shedBehavior.temperature
      : null;
    const canSetShedTemp = Boolean(targetCap && shedTemp !== null);
    // Mark as pending before async operation
    this.state.pendingSheds.add(deviceId);
    try {
      const applied = await this.trySetShedTemperature(deviceId, name, targetCap, shedTemp, canSetShedTemp);
      if (!applied) {
        await this.turnOffDevice(deviceId, name, reason);
      }
    } finally {
      this.state.pendingSheds.delete(deviceId);
    }
  }

  private shouldSkipShedding(
    deviceId: string,
    deviceName: string | undefined,
    snapshotState: TargetDeviceSnapshot | undefined,
  ): boolean {
    if (snapshotState?.available === false) {
      this.logDebug(`Actuator: skip shedding ${deviceName || deviceId}, device unavailable`);
      return true;
    }
    const now = Date.now();
    const lastForDevice = this.state.lastDeviceShedMs[deviceId];
    const throttleMs = 5000;
    if (lastForDevice && now - lastForDevice < throttleMs) {
      this.logDebug(
        `Actuator: skip shedding ${deviceName || deviceId}, throttled (${now - lastForDevice}ms since last)`,
      );
      return true;
    }
    // Check if this device is already being shed (in-flight)
    if (this.state.pendingSheds.has(deviceId)) {
      this.logDebug(`Actuator: skip shedding ${deviceName || deviceId}, already in progress`);
      return true;
    }
    if (snapshotState && snapshotState.currentOn === false) {
      this.logDebug(`Actuator: skip shedding ${deviceName || deviceId}, already off in snapshot`);
      return true;
    }
    return false;
  }

  private async trySetShedTemperature(
    deviceId: string,
    name: string,
    targetCap: string | undefined,
    shedTemp: number | null,
    canSetShedTemp: boolean,
  ): Promise<boolean> {
    if (!canSetShedTemp || !targetCap || shedTemp === null) return false;
    const now = Date.now();
    try {
      await this.deviceManager.setCapability(deviceId, targetCap, shedTemp);
      this.log(`Capacity: set ${targetCap} for ${name} to ${shedTemp}°C (shedding)`);
      this.updateLocalSnapshot(deviceId, { target: shedTemp });
      this.state.lastSheddingMs = now;
      this.state.lastOvershootMs = now;
      this.state.lastDeviceShedMs[deviceId] = now;
      return true;
    } catch (error) {
      this.error(`Failed to set shed temperature for ${name} via DeviceManager`, error);
      return false;
    }
  }

  private async turnOffDevice(deviceId: string, name: string, reason?: string): Promise<void> {
    const snapshotEntry = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    const hasOnOff = snapshotEntry?.capabilities?.includes('onoff') === true;
    if (!hasOnOff) {
      const hasTarget = Array.isArray(snapshotEntry?.targets) && snapshotEntry.targets.length > 0;
      const now = Date.now();
      this.state.lastDeviceShedMs[deviceId] = now;
      if (!hasTarget) {
        this.logDebug(`Capacity: skip turn_off for ${name}, device has no onoff or temperature target`);
        return;
      }
      this.logDebug(`Capacity: skip turn_off for ${name}, device has no onoff capability`);
      return;
    }
    const now = Date.now();
    try {
      await this.deviceManager.setCapability(deviceId, 'onoff', false);
      this.log(`Capacity: turned off ${name} (${reason || 'shedding'})`);
      this.updateLocalSnapshot(deviceId, { on: false });
      this.state.lastSheddingMs = now;
      this.state.lastDeviceShedMs[deviceId] = now;
    } catch (error) {
      this.error(`Failed to turn off ${name} via DeviceManager`, error);
    }
  }

  public async handleShortfall(deficitKw: number): Promise<void> {
    if (this.state.inShortfall) return; // Already in shortfall state

    const softLimit = this.capacityGuard ? this.capacityGuard.getSoftLimit() : this.capacitySettings.limitKw;
    const total = this.capacityGuard ? this.capacityGuard.getLastTotalPower() : null;

    this.log(`Capacity shortfall: cannot reach soft limit, deficit ~${deficitKw.toFixed(2)}kW (total ${total === null ? 'unknown' : total.toFixed(2)
      }kW, soft ${softLimit.toFixed(2)}kW)`);

    this.state.inShortfall = true;
    this.deps.homey.settings.set('capacity_in_shortfall', true);
    incPerfCounter('settings_set.capacity_in_shortfall');

    // Create timeline notification
    this.deps.homey.notifications.createNotification({
      excerpt: `Capacity shortfall: **${deficitKw.toFixed(2)} kW** over limit. Manual action may be needed.`,
    }).catch((err: Error) => this.error('Failed to create shortfall notification', err));

    // Trigger flow card
    const card = this.deps.homey.flow?.getTriggerCard?.('capacity_shortfall');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}).catch((err: Error) => this.error('Failed to trigger capacity_shortfall', err));
    }
  }

  public async handleShortfallCleared(): Promise<void> {
    if (!this.state.inShortfall) return; // Not in shortfall state

    this.log('Capacity shortfall resolved');
    this.state.inShortfall = false;
    this.deps.homey.settings.set('capacity_in_shortfall', false);
    incPerfCounter('settings_set.capacity_in_shortfall');

    // Create timeline notification
    this.deps.homey.notifications.createNotification({
      excerpt: 'Capacity shortfall **resolved**. Load is back within limits.',
    }).catch((err: Error) => this.error('Failed to create shortfall cleared notification', err));
  }

  public async applyPlanActions(plan: DevicePlan): Promise<void> {
    if (!plan || !Array.isArray(plan.devices)) return;

    const snapshotMap = new Map(this.latestTargetSnapshot.map((entry) => [entry.id, entry]));
    for (const dev of plan.devices) {
      const snapshot = snapshotMap.get(dev.id);
      try {
        if (this.shouldSkipUnavailable(snapshot, dev.name || dev.id, 'actuation')) {
          continue;
        }
        if (dev.controllable === false) {
          await this.applyUncontrolledRestore(dev, snapshot);
          await this.applyTargetUpdate(dev, snapshot);
          continue;
        }
        const handledShed = await this.applyShedAction(dev);
        if (handledShed) continue;
        await this.applyRestorePower(dev);
        await this.applyTargetUpdate(dev, snapshot);
      } catch (error) {
        this.error(
          `Failed to apply action for ${dev.name || dev.id}; continuing with remaining devices`,
          error,
        );
      }
    }
  }
}
