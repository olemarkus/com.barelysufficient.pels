/** The exact Homey app and device an app-action claim controls; no executable card payload. */
export type AppActionControlTarget = { appUri: string; deviceId: string };

/** Claim authority supplied by the battery owner only after its recovery record is stored. */
export type StorageControlBinding =
  | { kind: 'capability' }
  | { kind: 'app_actions'; target: AppActionControlTarget };

/**
 * The two control intents for a home battery, in the actuator's vocabulary: a
 * signed setpoint, and handing the battery back. Declared here rather than in
 * `lib/actuator/deviceCommand.ts` so the battery owner (`lib/battery/`), which
 * may import no peer, can name what it dispatches; the actuator's
 * `DeviceCommand` union includes both.
 *
 * Neither names a capability: the claim capability, its Homey value, the
 * `target_power` range and the app's own sign are the transport's private
 * binding, resolved from the battery's integration (`homeBatteryBinding`) and
 * its control surface. `setpointW` is always PELS's sign.
 */
export type StoragePowerCommand = {
  kind: 'storage_power';
  control: StorageControlBinding;
  deviceId: string;
  /** Finite signed watts: positive charges, negative discharges. */
  setpointW: number;
};

/**
 * Hand a battery back, by the kind of claim PELS recorded (`handBack`). A
 * battery taken over through a claim capability (`claim_capability`) gets
 * `restoreClaimValue`: the claim value it held before PELS first claimed it,
 * from the owner's durable claim record. Whether the battery is still PELS's
 * to hand back, and whether its claim capability declares this value, is the
 * owner's decision (it holds the claim time); transport writes
 * unconditionally. A claim-less battery driven through its app's actions
 * (`app_actions`) runs its integration's own hand-back actions on the exact
 * recorded target. A legacy claim has no target: the adapter may resolve
 * only a historical self-target; an unknown companion remains pending.
 */
export type StorageReleaseCommand =
  | { kind: 'storage_release'; deviceId: string; handBack: 'claim_capability'; restoreClaimValue: string }
  | { kind: 'storage_release'; deviceId: string; handBack: 'app_actions'; target: AppActionControlTarget }
  | { kind: 'storage_release'; deviceId: string; handBack: 'legacy_app_actions' };

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
