import type { NativeRelayBinding, NativeRelayOffResult } from '../ports/nativeRelay';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { SteppedLoadStepRequestResult, SteppedLoadStepRequestTransport } from '../ports/steppedLoadWrite';
import type {
  SteppedLoadWrite, TargetPowerControlClaimResult, TargetPowerControlClaimWrite,
} from '../ports/steppedLoadWrite';
import type {
  StorageClaimRejected,
  StoragePowerCommand,
  StoragePowerWrite,
  StorageReleaseCommand,
} from '../ports/storageCommand';

/**
 * A channel-blind control intent — what control outcome the caller wants, named
 * in domain terms (binary on/off, stepped step, target setpoint, a home
 * battery's signed setpoint and its hand-back). It deliberately names no Homey
 * capability ID, flow card, or native/synthetic channel; the actuator maps the
 * intent onto transport's capability/channel writes.
 *
 * Transport resolves native-vs-Flow routing from its private binding. Every
 * accepted binary dispatch remains pending until observer telemetry confirms it.
 *
 * See `notes/state-management/actuator-write-seam.md` for the two-write-contracts
 * design (transport input = channel-shaped; actuator input = intent-shaped).
 */
export type DeviceCommand =
  | import('../ports/chargingPhases').ChargingPhaseCommand
  | import('../ports/inverterControl').InverterCommand
  | {
    kind: 'binary';
    deviceId: string;
    desired: boolean;
    binarySwitchGeneration?: number;
    lastResortMaximumW?: number;
  }
  | {
    kind: 'target';
    deviceId: string;
    /** Producer-resolved target family used by policy fences before transport routing. */
    target: 'temperature';
    /** A resolved limit can still be applied during a manual temperature hold. */
    purpose: 'plan' | 'limit';
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
  }
  // Homey's control of a watt-stepped device PELS manages (`lib/ports/steppedLoadWrite.ts`).
  | ({ kind: 'target_power_claim' } & TargetPowerControlClaimWrite)
  // A home battery's signed setpoint and its hand-back (`lib/ports/storageCommand.ts`).
  | StoragePowerCommand
  | StorageReleaseCommand;

/**
 * The Homey SDK write surface the actuator delegates to. Transport stays the
 * sole SDK owner (see the design note); the actuator never imports the concrete
 * `DeviceTransport` — wiring injects an object satisfying this interface, so the
 * actuator layer carries no peer dependency on `lib/device/**`.
 */
export type ActuatorTransport = {
  requestChargingPhaseControl: (command: import('../ports/chargingPhases').ChargingPhaseCommand) => Promise<boolean>;
  requestProductionControl: (command: import('../ports/inverterControl').InverterCommand) => Promise<void>;
  canTurnOnDevice: (deviceId: string) => boolean;
  getNativeRelayBinding?: (deviceId: string) => NativeRelayBinding | undefined;
  requestBinaryControl: (
    deviceId: string,
    desired: boolean,
    binarySwitchGeneration?: number,
    lastResortMaximumW?: number,
  ) => Promise<NativeRelayOffResult | void | false>;
  requestTemperatureTarget: (deviceId: string, desired: number) => Promise<number>;
  /** Resolve the exact semantic setpoint before pending/retry preflight. */
  resolveTemperatureTarget: (deviceId: string, desired: number) => number;
  requestSteppedLoadStep: (request: SteppedLoadWrite) => Promise<SteppedLoadStepRequestResult>;
  requestTargetPowerControlClaim: (request: TargetPowerControlClaimWrite) => Promise<TargetPowerControlClaimResult>;
  /** Claim the battery for Homey, then write the setpoint: the watts sent, or the claim its app rejected. */
  requestStoragePower: (command: StoragePowerCommand) => Promise<StoragePowerWrite>;
  /** Write a zero setpoint, then restore the recorded claim value. */
  releaseStorageControl: (command: StorageReleaseCommand) => Promise<void>;
};

/**
 * Outcome of applying a command. `requested` is `false` only when the command
 * could not be issued (e.g. a `step` command on a transport without a
 * stepped-load surface). A binary preparation requests its ordinary pause
 * before the step is retried; an issued preparation already wrote to the device
 * instead of the step. It is **not** an idempotency signal — callers own
 * "already in posture" skips and never call the actuator in that case.
 */
export type ActuatorOutcome =
  | { requested: true; kind: 'charging_phase' | 'charging_phase_release' | 'charging_phase_prepare' }
  | { requested: true; kind: 'production_limit' | 'production_release' }
  | {
    requested: false;
  }
  | { requested: false; reason: 'flow_trigger_rejected' }
  | {
    requested: false;
    /**
     * A `step` refused unsent: the previous write to the device is still
     * outstanding past its caller's timeout. Nothing went out, so nothing is
     * pending, stamped or contested; the next plan rebuild asks again.
     */
    reason: 'previous_command_in_flight';
  }
  | {
    requested: false;
    /**
     * A `storage_power` intent whose claim write the battery's app rejected:
     * no setpoint went out. The battery owner judges what that means.
     */
    reason: StorageClaimRejected['kind'];
    errorMessage: string;
  }
  /** The device's app rejected Homey's control of its watt target. */
  | { requested: false; reason: 'target_power_claim_refused'; errorMessage: string }
  | { requested: true; kind: 'target_power_claim' }
  | {
    requested: true;
    kind: 'binary';
    acknowledged: true;
    relayBinding?: string;
    unflaggedRelay?: true;
  }
  | ({ requested: true; kind: 'binary' } & Extract<NativeRelayOffResult, { acknowledged: false }>)
  | {
    requested: true;
    kind: 'binary';
    acknowledged: false;
    reason?: never;
    err: unknown;
  }
  | {
    requested: true;
    kind: 'target';
    /** Transport-resolved value actually sent for a normalized target command. */
    requestedTargetValue: number;
  }
  | ({ kind: 'step' } & (Extract<SteppedLoadStepRequestResult, { requested: true }> | {
    requested: true;
    acknowledged: false;
    transport: SteppedLoadStepRequestTransport;
    reasonCode: 'command_request_timed_out';
    err: unknown;
  }))
  | {
    requested: true;
    kind: 'storage_power';
    /** The setpoint actually sent, after the battery's range, exclude band and step. */
    requestedSetpointW: number;
  }
  | {
    requested: true;
    kind: 'storage_release';
  };
