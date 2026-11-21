import type { PlanInputDevice, TemperaturePlanInputKind } from '../../packages/planner-types/src/planInputDevice';
import type { PreparedModeTarget } from '../../packages/planner-types/src/temperatureSetpoints';
import type { ThermalDirection } from '../../packages/contracts/src/types';
import { isTemperatureControlDevice } from '../../packages/shared-domain/src/temperatureDeviceKind';
import {
  getPrimaryTargetCapability, normalizeTargetCapabilityValue,
} from '../../packages/shared-domain/src/targetCapabilities';
import { setpointAddsDemand } from './setpointDemand';

import {
  MAX_MODE_PREPARATION_LEAD_MS, SCHEDULE_CATCH_UP_MS, type ModePreparationOccurrence, type ModePreparationRead,
} from '../ports/modePreparation';

const isTemperatureDevice = (device: PlanInputDevice): device is PlanInputDevice & TemperaturePlanInputKind => (
  isTemperatureControlDevice(device)
);

type PreparationDevice = Pick<PlanInputDevice, 'id' | 'deviceType' | 'control' | 'targets'>;

export type ModePreparationReads = {
  occurrence(): ModePreparationRead;
  readDevice(deviceId: string): PreparationDevice | undefined;
  nowMs(): number;
  currentMode(): string;
  modeTargets(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  thermalDirection(deviceId: string): ThermalDirection;
  canSetTemperature(deviceId: string): boolean;
  temporaryTemperatureC(deviceId: string): number | null;
  smartTaskState(deviceId: string): 'open' | 'none' | 'unavailable';
  leadMs(device: PlanInputDevice, fromC: number, targetC: number): number;
};

type PreparationWindow = {
  occurrence: ModePreparationOccurrence;
  currentMode: string;
  started: Set<string>;
};

export class ModePreparationResolver {
  private window: PreparationWindow | undefined;
  constructor(private readonly reads: ModePreparationReads) {}

  getPreparedModeTargets = (devices: readonly PlanInputDevice[]): ReadonlyMap<string, PreparedModeTarget> => {
    const occurrence = this.reads.occurrence();
    if (occurrence === 'unavailable') {
      const window = this.lastUsableWindow();
      if (!window) return new Map();
      return this.resolve(devices.filter((device) => window.started.has(device.id)), window.occurrence);
    }
    if (!occurrence) {
      this.window = undefined;
      return new Map();
    }
    const currentMode = this.reads.currentMode();
    const window = this.activeWindow(occurrence, currentMode)
      ?? { occurrence, currentMode, started: new Set<string>() };
    const prepared = this.resolve(devices, occurrence);
    for (const deviceId of prepared.keys()) window.started.add(deviceId);
    this.window = window;
    return prepared;
  };

  readPreparedTemperatureC = (deviceId: string): number | null => {
    const window = this.window;
    if (!window?.started.has(deviceId)) return null;
    const read = this.reads.occurrence();
    const occurrence = read === 'unavailable' ? this.lastUsableWindow()?.occurrence : read;
    const current = this.reads.currentMode();
    if (!occurrence || !this.activeWindow(occurrence, current)) return null;
    const device = this.reads.readDevice(deviceId);
    if (!device) return null;
    const targets = this.reads.modeTargets();
    return this.eligibleTemperatures(device, targets[current]?.[deviceId], targets[occurrence.mode]?.[deviceId])
      ?.targetC ?? null;
  };

  private lastUsableWindow(): PreparationWindow | undefined {
    const window = this.window;
    if (!window || window.currentMode !== this.reads.currentMode()) return undefined;
    const remainingMs = window.occurrence.atMs - this.reads.nowMs();
    return remainingMs <= MAX_MODE_PREPARATION_LEAD_MS && remainingMs > -SCHEDULE_CATCH_UP_MS ? window : undefined;
  }

  private activeWindow(occurrence: ModePreparationOccurrence, currentMode: string): PreparationWindow | undefined {
    const window = this.window;
    return window?.occurrence.scheduleId === occurrence.scheduleId && window.occurrence.atMs === occurrence.atMs
      && window.occurrence.mode === occurrence.mode
      && window.currentMode === currentMode ? window : undefined;
  }

  private resolve(
    devices: readonly PlanInputDevice[], occurrence: ModePreparationOccurrence,
  ): Map<string, PreparedModeTarget> {
    const result = new Map<string, PreparedModeTarget>();
    const current = this.reads.currentMode();
    if (current === occurrence.mode) return result;
    const targets = this.reads.modeTargets();
    const nextTargets = targets[occurrence.mode];
    if (nextTargets === undefined) return result;
    const remainingMs = occurrence.atMs - this.reads.nowMs();
    const started = this.activeWindow(occurrence, current)?.started;
    for (const device of devices) {
      const temperatures = this.eligibleTemperatures(device, targets[current]?.[device.id], nextTargets[device.id]);
      if (!temperatures) continue;
      const { fromC, targetC } = temperatures;
      if (!started?.has(device.id) && remainingMs > 0
        && remainingMs > this.reads.leadMs(device, fromC, targetC)) continue;
      result.set(device.id, { targetC, mode: occurrence.mode, at: occurrence.at });
    }
    return result;
  }

  private eligibleTemperatures(device: PreparationDevice, currentC: number | undefined, nextC: number | undefined) {
    if (currentC === undefined || nextC === undefined || !isTemperatureControlDevice(device)
      || !device.control.commandAuthority || !device.control.managed
      || this.reads.thermalDirection(device.id) !== 'heating') return undefined;
    const target = getPrimaryTargetCapability(device.targets);
    const fromC = normalizeTargetCapabilityValue({ target, value: currentC });
    const targetC = normalizeTargetCapabilityValue({ target, value: nextC });
    if (!setpointAddsDemand('heating', fromC, targetC) || !this.reads.canSetTemperature(device.id)
      || this.reads.temporaryTemperatureC(device.id) !== null
      || this.reads.smartTaskState(device.id) !== 'none') return undefined;
    return { fromC, targetC };
  }

  result(devices: readonly PlanInputDevice[], occurrence: ModePreparationOccurrence): string {
    const window = this.activeWindow(occurrence, this.reads.currentMode());
    if (!window || window.started.size === 0) return '';
    const participants = devices.filter((device) => window.started.has(device.id));
    const targets = this.resolve(participants, occurrence);
    if (targets.size === 0) return '';
    const ready = participants.filter((device) => {
      const prepared = targets.get(device.id);
      return prepared && isTemperatureDevice(device) && device.currentTemperature >= prepared.targetC - 0.5;
    }).length;
    if (targets.size === 1) return ready ? 'The device was ready.' : 'The device was below its target.';
    return `${ready} of ${targets.size} devices were ready.`;
  }
}
