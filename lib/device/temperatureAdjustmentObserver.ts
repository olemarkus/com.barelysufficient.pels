import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { PlanRealtimeUpdateEvent } from './transport/managerRealtimeHandlers';
import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';

// Keep superseded commands through the device confirmation window. The latest
// command remains attributable until another command replaces it, even if its
// echo arrives much later. An SDK rejection does not prove the write never landed.
const SUPERSEDED_COMMAND_WINDOW_MS = 120_000;

type TemperatureCommand = { value: number; supersededAtMs?: number };

/** Observation-side attribution; knows no modes, policy, plans or settings. */
export class TemperatureAdjustmentObserver {
  private readonly commands = new Map<string, TemperatureCommand[]>();

  recordCommand(deviceId: string, value: number, atMs: number): void {
    const commands = this.commands.get(deviceId) ?? [];
    const recent = commands
      .map((command) => ({ ...command, supersededAtMs: command.supersededAtMs ?? atMs }))
      .filter((command) => atMs - command.supersededAtMs < SUPERSEDED_COMMAND_WINDOW_MS);
    this.commands.set(deviceId, [...recent, { value }]);
  }

  observe(deviceId: string, temperature: number, observedAtMs: number): ExternalTemperatureAdjustment | undefined {
    const commands = this.commands.get(deviceId) ?? [];
    if (commands.some((command) => command.value === temperature
      && (command.supersededAtMs === undefined
        || observedAtMs - command.supersededAtMs < SUPERSEDED_COMMAND_WINDOW_MS))) return undefined;
    return { deviceId, temperature, observedAtMs };
  }

  observeControlChange(
    snapshot: TransportDeviceSnapshot | undefined,
    event: PlanRealtimeUpdateEvent,
  ): ExternalTemperatureAdjustment | undefined {
    const changed = event.changes?.some((change) => change.capabilityId === 'target_temperature'
      && change.previousValue !== 'unknown' && change.previousValue !== 'absent'
      && change.previousValue !== change.nextValue);
    if (!snapshot?.temperature || !changed) return undefined;
    return this.observe(event.deviceId, snapshot.temperature.target.value, event.observedAtMs ?? Date.now());
  }

  retainDevices(deviceIds: ReadonlySet<string>): void {
    for (const id of this.commands.keys()) {
      if (!deviceIds.has(id)) this.commands.delete(id);
    }
  }
}
