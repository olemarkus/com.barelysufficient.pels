/**
 * The two control intents for a home battery, in the actuator's vocabulary: a
 * signed setpoint, and handing the battery back. Declared here rather than in
 * `lib/actuator/deviceCommand.ts` so the battery owner (`lib/battery/`), which
 * may import no peer, can name what it dispatches; the actuator's
 * `DeviceCommand` union includes both.
 *
 * Neither names a capability: the claim capability, its Homey value and the
 * `target_power` range are the transport's private binding, resolved from the
 * battery's control surface.
 */
export type StoragePowerCommand = {
  kind: 'storage_power';
  deviceId: string;
  /** Finite signed watts: positive charges, negative discharges. */
  setpointW: number;
};

export type StorageReleaseCommand = {
  kind: 'storage_release';
  deviceId: string;
  /**
   * The claim value the battery held before PELS first claimed it, from the
   * owner's durable claim record. Whether the battery is still PELS's to hand
   * back, and whether its claim capability declares this value, is the owner's
   * decision (it holds the claim time); transport writes unconditionally.
   */
  restoreClaimValue: string;
};

export type StorageCommand = StoragePowerCommand | StorageReleaseCommand;

/**
 * The battery's app rejected the write to its claim capability, so no
 * setpoint was written. What that means is the battery owner's call, made
 * against the binding (`HomeBatteryControlSurface` claim `rejection`).
 * `errorMessage` is the app's own words, localized: for the log only, never
 * matched.
 */
export type StorageClaimRejected = { kind: 'claim_rejected'; errorMessage: string };

/**
 * What the transport did with a `storage_power` intent: the watts it wrote,
 * or the claim write the battery's app rejected (Homey answered it with an
 * HTTP error status). Any other failure (a setpoint write refused, a claim
 * write with no answer, whose outcome is unknown, no REST client yet) throws,
 * as every other write does.
 */
export type StoragePowerWrite = { kind: 'written'; setpointW: number } | StorageClaimRejected;

/**
 * The write seam as the battery owner sees it. The injected `Actuator`
 * satisfies it structurally. The owner needs only whether the command went
 * out; a throw is a write the device or Homey refused.
 */
export type StorageActuation = {
  apply(command: StorageCommand): Promise<{ requested: boolean }>;
};
