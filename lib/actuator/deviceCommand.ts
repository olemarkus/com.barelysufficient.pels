import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import type { SteppedLoadStepRequestResult } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';

/**
 * A channel-blind control intent — what control outcome the caller wants, named
 * in domain terms (binary on/off, stepped step, target setpoint). It deliberately
 * names no Homey capability ID, flow card, or native/synthetic channel; the
 * actuator maps the intent onto transport's capability/channel writes.
 *
 * Resolution belongs in the producer: `flowBacked` (whether a binary control is
 * a Homey Flow trigger vs a direct capability write) is snapshot-derived and is
 * resolved by the producing layer before the command is constructed. The actuator
 * only *routes* on the flag — it does not decide it.
 *
 * See `notes/state-management/actuator-write-seam.md` for the two-write-contracts
 * design (transport input = channel-shaped; actuator input = intent-shaped).
 */
export type DeviceCommand =
  | {
    kind: 'binary';
    deviceId: string;
    /** Which binary control to drive — a control outcome, not an SDK channel. */
    control: 'onoff' | 'evcharger_charging';
    desired: boolean;
    /** Producer-resolved: true → route via the Flow trigger, not setCapability. */
    flowBacked: boolean;
  }
  | {
    kind: 'target';
    deviceId: string;
    value: number;
    /** Free-text context tag forwarded to transport for diagnostics. */
    contextInfo?: string;
  }
  | {
    kind: 'step';
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    actuationMode?: 'plan' | 'reconcile';
    previousStepId?: string;
  };

/**
 * The Homey SDK write surface the actuator delegates to. Transport stays the
 * sole SDK owner (see the design note); the actuator never imports the concrete
 * `DeviceTransport` — wiring injects an object satisfying this interface, so the
 * actuator layer carries no peer dependency on `lib/device/**`.
 */
export type ActuatorTransport = {
  setCapability: (deviceId: string, capabilityId: string, value: unknown) => Promise<unknown>;
  applyDeviceTargets: (targets: Record<string, number>, contextInfo?: string) => Promise<void>;
  triggerFlowBackedBinaryControl: (
    deviceId: string,
    capabilityId: 'onoff' | 'evcharger_charging',
    desired: boolean,
  ) => Promise<void>;
  requestSteppedLoadStep?: (params: {
    deviceId: string;
    profile: SteppedLoadProfile;
    desiredStepId: string;
    planningPowerW: number;
    planningCurrentA: number;
    actuationMode?: 'plan' | 'reconcile';
    previousStepId?: string;
  }) => Promise<SteppedLoadStepRequestResult>;
};

/**
 * Outcome of applying a command. `requested` is `false` only when the command
 * could not be issued at all (e.g. a `step` command on a transport without a
 * stepped-load surface). It is **not** an idempotency signal — callers own
 * "already in posture" skips and never call the actuator in that case.
 */
export type ActuatorOutcome = {
  requested: boolean;
  /** Present for `step` commands so callers can record desired-step bookkeeping. */
  steppedResult?: SteppedLoadStepRequestResult;
};
