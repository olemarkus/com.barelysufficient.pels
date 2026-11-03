import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import type { ObservedControlStateChangedEvent } from '../ports/observedStateEvents';

// Keep superseded commands through the device confirmation window. The latest
// command remains attributable until another command replaces it, even if its
// echo arrives much later. An SDK rejection does not prove the write never landed.
const SUPERSEDED_COMMAND_WINDOW_MS = 120_000;
// The device's first other setpoint this soon after PELS's latest command, and
// less than a degree from it, is its answer to the command: a device that only
// takes whole degrees reports its rounded value on its next poll. As long as
// PELS's longest target retry wait. A setpoint further off is someone's choice;
// a device clamping PELS's limit is never adopted anyway, since the owner's
// mode update skips a device PELS has limited.
const COMMAND_ANSWER_WINDOW_MS = 15 * 60_000;
const ROUNDED_ANSWER_MAX_C = 1;

type TemperatureCommand = { value: number; supersededAtMs?: number };

/** Observation-side attribution; knows no modes, policy, plans or settings. */
export class TemperatureAdjustmentObserver {
  private readonly commands = new Map<string, TemperatureCommand[]>();
  /** PELS's latest command to each device whose answer has not come yet. */
  private readonly awaitingAnswer = new Map<string, { value: number; atMs: number }>();

  recordCommand(deviceId: string, value: number, atMs: number): void {
    const commands = this.commands.get(deviceId) ?? [];
    const recent = commands
      .map((command) => ({ ...command, supersededAtMs: command.supersededAtMs ?? atMs }))
      .filter((command) => atMs - command.supersededAtMs < SUPERSEDED_COMMAND_WINDOW_MS);
    this.commands.set(deviceId, [...recent, { value }]);
    this.awaitingAnswer.set(deviceId, { value, atMs });
  }

  /**
   * An external adjustment, or undefined for PELS's own value and for the
   * device's rounded answer to PELS's latest command. A report of PELS's value
   * does not end the wait for the answer: PELS's own write reads the same way.
   */
  observe(deviceId: string, temperature: number, observedAtMs: number): ExternalTemperatureAdjustment | undefined {
    const commands = this.commands.get(deviceId) ?? [];
    if (commands.some((command) => command.value === temperature
      && (command.supersededAtMs === undefined
        || observedAtMs - command.supersededAtMs < SUPERSEDED_COMMAND_WINDOW_MS))) return undefined;
    const command = this.awaitingAnswer.get(deviceId);
    this.awaitingAnswer.delete(deviceId);
    const isAnswer = command !== undefined
      && observedAtMs - command.atMs <= COMMAND_ANSWER_WINDOW_MS
      && Math.abs(temperature - command.value) < ROUNDED_ANSWER_MAX_C;
    return isAnswer ? undefined : { deviceId, temperature, observedAtMs };
  }

  observeControlChange(
    snapshot: TransportDeviceSnapshot | undefined,
    event: ObservedControlStateChangedEvent,
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
    for (const id of this.awaitingAnswer.keys()) {
      if (!deviceIds.has(id)) this.awaitingAnswer.delete(id);
    }
  }
}
