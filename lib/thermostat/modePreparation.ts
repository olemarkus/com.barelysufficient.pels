import type { ModePreparationPlanDevice } from '../../packages/contracts/src/schedules';
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
type PreparationLeadDevice = Omit<PlanInputDevice, 'priority'>;

export type ModePreparationReads = {
  occurrence(): ModePreparationRead;
  readDevice(deviceId: string): PreparationDevice | undefined;
  readPreviewDevices(): readonly PreparationLeadDevice[];
  nowMs(): number;
  currentMode(): string;
  modeTargets(): Readonly<Record<string, Readonly<Record<string, number>>>>;
  thermalDirection(deviceId: string): ThermalDirection;
  canSetTemperature(deviceId: string): boolean;
  temporaryTemperatureC(deviceId: string): number | null;
  hasManualTemperatureHold(deviceId: string): boolean;
  smartTaskState(deviceId: string): 'open' | 'none' | 'unavailable';
  leadMs(device: PreparationLeadDevice, fromC: number, targetC: number): number;
};

type PreparationWindow = {
  occurrence: ModePreparationOccurrence;
  currentMode: string;
  /** The last accepted Smart task state for each device that started preparation. */
  started: Map<string, 'open' | 'none'>;
};

export class ModePreparationResolver {
  private window: PreparationWindow | undefined;
  constructor(private readonly reads: ModePreparationReads) {}

  getPreparedModeTargets = (devices: readonly PlanInputDevice[]): ReadonlyMap<string, PreparedModeTarget> => {
    const occurrence = this.reads.occurrence();
    if (occurrence === 'unavailable') {
      const window = this.lastUsableWindow();
      if (!window) return new Map();
      return this.resolve(devices.filter((device) => window.started.has(device.id)), window);
    }
    if (!occurrence) {
      this.window = undefined;
      return new Map();
    }
    const currentMode = this.reads.currentMode();
    const window = this.activeWindow(occurrence, currentMode)
      ?? { occurrence, currentMode, started: new Map<string, 'open' | 'none'>() };
    const prepared = this.resolve(devices, window);
    for (const deviceId of prepared.keys()) window.started.set(deviceId, 'none');
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
    return this.eligibleTemperatures(
      device, targets[current]?.[deviceId], targets[occurrence.mode]?.[deviceId], window.started,
    )
      ?.targetC ?? null;
  };

  /** Estimate the next occurrence without marking a device as having started. */
  preview = (occurrence: ModePreparationOccurrence): ModePreparationPlanDevice[] => {
    const current = this.reads.currentMode();
    if (current === occurrence.mode) return [];
    const targets = this.reads.modeTargets();
    const started = this.activeWindow(occurrence, current)?.started;
    const now = this.reads.nowMs();
    return this.reads.readPreviewDevices().flatMap((device): ModePreparationPlanDevice[] => {
      const temperatures = this.candidateTemperatures(device, targets[current]?.[device.id],
        targets[occurrence.mode]?.[device.id]);
      if (!temperatures) return [];
      const row = { deviceId: device.id, name: device.name, ...temperatures };
      const blocker = this.preparationBlocker(device.id, started);
      if (blocker !== 'none') return [{ ...row, state: blocker }];
      if (started?.has(device.id)) return [{ ...row, state: 'preparing' }];
      const startAtMs = occurrence.atMs - this.reads.leadMs(device, temperatures.fromC, temperatures.targetC);
      return startAtMs <= now ? [{ ...row, state: 'waiting_to_start' }] : [{ ...row, state: 'estimated', startAtMs }];
    });
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
    devices: readonly PlanInputDevice[], window: PreparationWindow,
  ): Map<string, PreparedModeTarget> {
    const result = new Map<string, PreparedModeTarget>();
    const { occurrence, currentMode: current, started } = window;
    if (current === occurrence.mode) return result;
    const targets = this.reads.modeTargets();
    const nextTargets = targets[occurrence.mode];
    if (nextTargets === undefined) return result;
    const remainingMs = occurrence.atMs - this.reads.nowMs();
    for (const device of devices) {
      const temperatures = this.eligibleTemperatures(
        device, targets[current]?.[device.id], nextTargets[device.id], started,
      );
      if (!temperatures) continue;
      const { fromC, targetC } = temperatures;
      if (!started.has(device.id) && remainingMs > 0
        && remainingMs > this.reads.leadMs(device, fromC, targetC)) continue;
      result.set(device.id, { targetC, mode: occurrence.mode, at: occurrence.at });
    }
    return result;
  }

  private eligibleTemperatures(
    device: PreparationDevice, currentC: number | undefined, nextC: number | undefined,
    started: PreparationWindow['started'],
  ) {
    const temperatures = this.candidateTemperatures(device, currentC, nextC);
    return temperatures && this.preparationBlocker(device.id, started) === 'none' ? temperatures : undefined;
  }

  private candidateTemperatures(device: PreparationDevice, currentC: number | undefined, nextC: number | undefined) {
    if (currentC === undefined || nextC === undefined || !isTemperatureControlDevice(device)
      || !device.control.commandAuthority || !device.control.managed
      || this.reads.thermalDirection(device.id) !== 'heating') return undefined;
    const target = getPrimaryTargetCapability(device.targets);
    const fromC = normalizeTargetCapabilityValue({ target, value: currentC });
    const targetC = normalizeTargetCapabilityValue({ target, value: nextC });
    if (!setpointAddsDemand('heating', fromC, targetC) || !this.reads.canSetTemperature(device.id)) return undefined;
    return { fromC, targetC };
  }

  private preparationBlocker(
    deviceId: string, started: PreparationWindow['started'] | undefined,
  ): 'override' | 'manual_temperature_hold' | 'smart_task' | 'unavailable' | 'none' {
    if (this.reads.temporaryTemperatureC(deviceId) !== null) return 'override';
    if (this.reads.hasManualTemperatureHold(deviceId)) return 'manual_temperature_hold';
    const task = this.reads.smartTaskState(deviceId);
    // A failed read preserves a started device's last accepted state for this window.
    const state = task === 'unavailable' ? started?.get(deviceId) ?? task : task;
    if (task !== 'unavailable' && started?.has(deviceId)) started.set(deviceId, task);
    return state === 'open' ? 'smart_task' : state;
  }

  result(devices: readonly PlanInputDevice[], occurrence: ModePreparationOccurrence): string {
    const window = this.activeWindow(occurrence, this.reads.currentMode());
    if (!window || window.started.size === 0) return '';
    const participants = devices.filter((device) => window.started.has(device.id));
    const targets = this.resolve(participants, window);
    if (targets.size === 0) return '';
    const ready = participants.filter((device) => {
      const prepared = targets.get(device.id);
      return prepared && isTemperatureDevice(device) && device.currentTemperature >= prepared.targetC - 0.5;
    }).length;
    if (targets.size === 1) return ready ? 'The device was ready.' : 'The device was below its target.';
    return `${ready} of ${targets.size} devices were ready.`;
  }
}
