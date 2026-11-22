import type { Actuator } from './deviceActuator';
import type { ActuatorOutcome, DeviceCommand } from './deviceCommand';

/**
 * Something that wants to know when each device write goes out and how it
 * ended, without taking part in it. Told before the send and once after, with
 * the outcome or the failure; it cannot change, delay or refuse a command.
 *
 * Implemented by the home meter's response timing capture
 * (`lib/device/meterResponseTimings.ts`), which needs every write PELS sends,
 * to every device, to know when a change on the meter can be one device's.
 */
export type DeviceCommandWitness = {
  commandDispatched(command: DeviceCommand, dispatchedAtMs: number): void;
  commandSettled(command: DeviceCommand, outcome: ActuatorOutcome, settledAtMs: number): void;
  commandFailed(command: DeviceCommand, failedAtMs: number): void;
};

/** A witness that fails is the witness's problem, never the write's. */
const tell = (report: () => void): void => {
  try {
    report();
  } catch {
    // The witness logs its own failures; the write goes on regardless.
  }
};

/**
 * `base`, with every write reported to `witness`. The witness is told and the
 * write proceeds exactly as before: what `base` returns or throws is what the
 * caller gets.
 */
export const createWitnessedActuator = (base: Actuator, witness: DeviceCommandWitness): Actuator => ({
  getNativeRelayBinding: base.getNativeRelayBinding,
  canTurnOnDevice: base.canTurnOnDevice.bind(base),
  resolveTemperatureTarget: base.resolveTemperatureTarget.bind(base),
  apply: async (command) => {
    tell(() => witness.commandDispatched(command, Date.now()));
    let outcome: ActuatorOutcome;
    try {
      outcome = await base.apply(command);
    } catch (error) {
      tell(() => witness.commandFailed(command, Date.now()));
      throw error;
    }
    tell(() => witness.commandSettled(command, outcome, Date.now()));
    return outcome;
  },
});
