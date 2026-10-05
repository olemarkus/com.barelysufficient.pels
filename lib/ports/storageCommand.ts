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
 * The write seam as the battery owner sees it. The injected `Actuator`
 * satisfies it structurally. The owner needs only whether the command went
 * out; a throw is a write the device or Homey refused.
 */
export type StorageActuation = {
  apply(command: StorageCommand): Promise<{ requested: boolean }>;
};
