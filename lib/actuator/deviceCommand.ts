import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { SteppedLoadStepRequestResult } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';

/**
 * A channel-blind control intent — what control outcome the caller wants, named
 * in domain terms (binary on/off, stepped step, target setpoint). It deliberately
 * names no Homey capability ID, flow card, or native/synthetic channel; the
 * actuator maps the intent onto transport's capability/channel writes.
 *
 * Transport resolves native-vs-Flow routing from its private binding. Every
 * accepted binary dispatch remains pending until observer telemetry confirms it.
 *
 * See `notes/state-management/actuator-write-seam.md` for the two-write-contracts
 * design (transport input = channel-shaped; actuator input = intent-shaped).
 */
export type DeviceCommand =
  | {
    kind: 'binary';
    deviceId: string;
    desired: boolean;
  }
  | {
    kind: 'target';
    deviceId: string;
    /** Producer-resolved target family used by policy fences before transport routing. */
    target: 'temperature';
    value: number;
  }
  | {
    kind: 'step';
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    previousStepId?: string;
  };

/**
 * The Homey SDK write surface the actuator delegates to. Transport stays the
 * sole SDK owner (see the design note); the actuator never imports the concrete
 * `DeviceTransport` — wiring injects an object satisfying this interface, so the
 * actuator layer carries no peer dependency on `lib/device/**`.
 */
export type ActuatorTransport = {
  requestBinaryControl: (
    deviceId: string,
    desired: boolean,
  ) => Promise<void>;
  requestTemperatureTarget: (deviceId: string, desired: number) => Promise<number>;
  /** Resolve the exact semantic setpoint before pending/retry preflight. */
  resolveTemperatureTarget: (deviceId: string, desired: number) => number;
  requestSteppedLoadStep: (params: {
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    previousStepId?: string;
  }) => Promise<SteppedLoadStepRequestResult>;
};

/**
 * Outcome of applying a command. `requested` is `false` only when the command
 * could not be issued at all (e.g. a `step` command on a transport without a
 * stepped-load surface). It is **not** an idempotency signal — callers own
 * "already in posture" skips and never call the actuator in that case.
 */
export type ActuatorOutcome =
  | { requested: false }
  | {
    requested: true;
    kind: 'binary';
  }
  | {
    requested: true;
    kind: 'target';
    /** Transport-resolved value actually sent for a normalized target command. */
    requestedTargetValue: number;
  }
  | {
    requested: true;
    kind: 'step';
    steppedResult: SteppedLoadStepRequestResult;
  };
