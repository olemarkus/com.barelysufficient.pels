import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import type { ObservedControlStateChangedEvent } from '../ports/observedStateEvents';
import type { ControlReported } from '../ports/controlContest';
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../ports/controlCommandConfirmation';
import { getLogger } from '../logging/logger';

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

type TemperatureCommand = { value: number; atMs: number; supersededAtMs?: number };
type TimedOutCommand = {
  command: TemperatureCommand;
  targetCommandId: string;
  transactionId: string;
  timedOutAtMs: number;
  awaitingSetpointReport: boolean;
};
const logger = getLogger('device/temperature');

/** Observation-side attribution; knows no modes, policy, plans or settings. */
export class TemperatureAdjustmentObserver {
  private readonly commands = new Map<string, TemperatureCommand[]>();
  /** PELS's latest command to each device whose answer has not come yet. */
  private readonly awaitingAnswer = new Map<string, TemperatureCommand>();
  private readonly timedOutCommands = new Map<string, TimedOutCommand[]>();

  recordCommand(deviceId: string, value: number, atMs: number): TemperatureCommand {
    const commands = this.commands.get(deviceId) ?? [];
    const recent = commands
      .map((command) => ({ ...command, supersededAtMs: command.supersededAtMs ?? atMs }))
      .filter((command) => atMs - command.supersededAtMs < SUPERSEDED_COMMAND_WINDOW_MS);
    const command = { value, atMs };
    this.commands.set(deviceId, [...recent, command]);
    this.awaitingAnswer.set(deviceId, command);
    this.recentTimeouts(deviceId, atMs);
    return command;
  }

  recordTimeout(
    deviceId: string,
    command: TemperatureCommand,
    targetCommandId: string,
    transactionId: string,
    timedOutAtMs: number,
    awaitingSetpointReport: boolean,
  ): void {
    if (timedOutAtMs >= command.atMs + CONTROL_COMMAND_CONFIRMATION_MS) return;
    const attempts = this.recentTimeouts(deviceId, timedOutAtMs);
    this.timedOutCommands.set(deviceId, [
      ...attempts, { command, targetCommandId, transactionId, timedOutAtMs, awaitingSetpointReport },
    ]);
  }

  /** Only a later non-echo report can show that Homey observed the requested setpoint. */
  observeTimedOutCommand(report: ControlReported): void {
    if (report.setting !== 'temperature') return;
    const { deviceId, reportedAtMs: observedAtMs, value } = report;
    const latest = this.commands.get(deviceId)?.at(-1);
    const attempt = this.recentTimeouts(deviceId, observedAtMs).find((entry) => entry.command === latest);
    if (!attempt?.awaitingSetpointReport
      || observedAtMs < attempt.timedOutAtMs || value !== attempt.command.value) return;
    attempt.awaitingSetpointReport = false;
    logger.info({
      event: 'target_command_observed_after_timeout',
      targetCommandId: attempt.targetCommandId,
      transactionId: attempt.transactionId,
      deviceId,
      targetValue: value,
      observedAtMs,
      elapsedSinceTimeoutMs: observedAtMs - attempt.timedOutAtMs,
    });
  }

  /** Homey's own-write echo provides acknowledgement, separate from a device report. */
  observeTimedOutEcho(deviceId: string, transactionId: string, atMs: number): void {
    const attempt = this.recentTimeouts(deviceId, atMs).find((entry) => entry.transactionId === transactionId);
    if (!attempt || atMs < attempt.timedOutAtMs) return;
    logger.info({
      event: 'target_command_echoed_after_timeout',
      targetCommandId: attempt.targetCommandId,
      transactionId,
      deviceId,
      elapsedSinceTimeoutMs: atMs - attempt.timedOutAtMs,
    });
  }

  private recentTimeouts(deviceId: string, nowMs: number): TimedOutCommand[] {
    const attempts = this.timedOutCommands.get(deviceId) ?? [];
    const recent = attempts.filter(({ command }) => nowMs < command.atMs + CONTROL_COMMAND_CONFIRMATION_MS);
    if (recent.length === 0) this.timedOutCommands.delete(deviceId);
    else if (recent.length < attempts.length) this.timedOutCommands.set(deviceId, recent);
    return recent;
  }

  forgetTimedOutCommand(deviceId: string): void {
    this.timedOutCommands.delete(deviceId);
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
    if (event.pelsEcho) return undefined;
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
    for (const id of this.timedOutCommands.keys()) {
      if (!deviceIds.has(id)) this.timedOutCommands.delete(id);
    }
  }
}
