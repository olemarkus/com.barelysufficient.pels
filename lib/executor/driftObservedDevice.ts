/**
 * What the drift predicate compares planner intent against: the device as the
 * OBSERVER currently reports it, plus the command state the EXECUTOR itself
 * holds. Nothing here has passed through a plan.
 *
 * That provenance is the whole point. Drift used to take a `PlanInputDevice` —
 * the planner's input shape, with observations already folded into it — so the
 * executor never actually saw an observation, only a plan carrying one. The
 * consequence was concrete: `ExecutableObservedDeviceState.observedBinaryState`
 * had to mean two different things depending on which construction path built
 * it, because one path had `currentOn` and no `binaryControl` and the other had
 * the reverse.
 *
 * Ownership, per field:
 * - **Observed** (`lib/observer`, live per-device read): availability, the
 *   binary axis, setpoints, measured draw, the device's reported rung, EV plug
 *   state. What the device is doing.
 * - **Commanded** (`lib/executor`, this layer's own stores): whether a binary or
 *   step command is in flight and what it asked for. What PELS asked for.
 * - **Configured** (the effective ladder): DeviceConfiguration owns resolution;
 *   Observer carries that resolved ladder beside the reported rung, so this
 *   reader can interpret observed state without asking the transport or settings.
 *
 * The two are kept apart deliberately — see `lib/device/AGENTS.md` on never
 * collapsing `observed` into `commanded`. This type joins them at the point of
 * comparison without merging their meanings.
 */
import type { StorageDecidedDevice, StorageReleaseIntent } from '../planContract/storageDecision';
import type { ExecutorDeviceRead } from './executorDeviceRead';

/** In-flight command state, owned by this layer. */
export type DriftCommandRead = {
  binary: { kind: 'pending'; desired: boolean | 'unknown' } | { kind: 'none' };
  step: { kind: 'pending' } | { kind: 'none' };
};

/**
 * The three readers the drift path needs, each pointed at the layer that owns
 * its answer. Injected rather than reached for so the executor keeps no handle
 * on a projection, a store, or a plan.
 */
export type DriftObservationDeps = {
  /**
   * The executor's live read: Observer's record joined with the resolved
   * identity from device configuration (`readExecutorDevice`). `undefined`
   * before a device's first observation.
   */
  getObservedState: (deviceId: string) => ExecutorDeviceRead | undefined;
  /** This layer's pending-command state for the device. */
  getCommandState: (deviceId: string) => DriftCommandRead;
  /**
   * "Leave off until turned on again". A persisted POSTURE rather than a
   * reading — the observer owns the store, and the resolved bit reaches here
   * as a flat boolean so this layer never asks why a device is off.
   */
  isExternalOffHeld: (deviceId: string) => boolean;
  /**
   * Whether a home battery's storage decision still has work in the storage
   * lane (`BatteryExecutor.hasDrift`): a setpoint unsent or unverified, or a
   * release while the claim is held.
   */
  hasStorageDrift: (device: StorageDecidedDevice) => boolean;
  hasStorageReleaseDrift: (intent: StorageReleaseIntent) => boolean;
};
