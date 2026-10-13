import type { CapacityScalarSettings } from '../../packages/contracts/src/capacitySettings';
import type { HomeId, SubHomeConfig } from './homeConfig';

// A meter area's OWN fallback seed for its capacity scalars, until its store
// reads. Mirrors the app-boot defaults (`PelsApp.capacitySettings` /
// `capacityDryRun`) but is deliberately a per-area constant — NEVER Main's live
// snapshot: seeding an area from Main's configured hard cap would silently run
// a second controller against Main's contract limit. Dry-run defaults TRUE (the
// safe boot default): an unconfigured area plans but never actuates.
const SUB_HOME_CAPACITY_DEFAULTS: CapacityScalarSettings = {
  capacityEnabled: true,
  gridImportLimitKw: null,
  limitKw: 10,
  marginKw: 0.2,
  dryRun: true,
  periodMinutes: 60,
};

const unboundSourceActuationRetry = (): void => {
  throw new Error('SubHomeRuntime: the source actuation retry was asked for before it was bound');
};

/**
 * One meter area's runtime state (multi-home R7b), owned here rather than in
 * the wiring that builds the area's control loop
 * (`setup/homeRuntime/createHomeCapacityBundle.ts`): the reconciled config, the
 * one-way teardown latch, the capacity scalars the running loop holds, and the
 * effective no-actuation switch those fold into with the registry's membership
 * and meter-source gates.
 *
 * The gates arrive as plain predicates from the owning registry; this module
 * reads no settings and imports no other domain.
 */
export class SubHomeRuntime {
  private home: SubHomeConfig;

  private tornDown = false;

  private capacityScalars = SUB_HOME_CAPACITY_DEFAULTS;

  // Bound once, during the bundle's construction and before its plan runtime
  // can ask: the retry rebuilds through the plan service the execution
  // predicate below is handed to, so the two cannot be built in one order.
  private scheduleSourceActuationRetry: () => void = unboundSourceActuationRetry;

  constructor(
    home: SubHomeConfig,
    /** Membership-readiness signal (a committed zone tree has been joined). */
    readonly isMembershipReady: () => boolean,
    /**
     * Source-epoch gate resolved by the registry. True only while the current
     * global source and the last fully handled source epoch are Homey Energy.
     */
    readonly isMeterSourceAuthorized: () => boolean,
    /**
     * Permanent source-epoch invalidation for this runtime. Unlike a transient
     * settings-read failure, this means a deferred global Flow transition belongs
     * to a superseded meter epoch and must be discarded.
     */
    readonly isMeterSourceEpochDiscarded: () => boolean,
  ) {
    this.home = home;
  }

  get homeId(): HomeId {
    return this.home.homeId;
  }

  /** The current reconciled config; a same-meter rename lands without a teardown. */
  readonly getHomeConfig = (): SubHomeConfig => this.home;

  updateHomeConfig(home: SubHomeConfig): void {
    this.home = home;
  }

  /** True after teardown has closed every writer/actuator seam. */
  readonly isTornDown = (): boolean => this.tornDown;

  /** Close the teardown latch. There is no reset: a torn-down area is replaced, never revived. */
  markTornDown(): void {
    this.tornDown = true;
  }

  /** Last-good capacity scalars, seeded from the area's own defaults above. */
  readonly getCapacityScalars = (): CapacityScalarSettings => this.capacityScalars;

  setCapacityScalars(capacityScalars: CapacityScalarSettings): void {
    this.capacityScalars = capacityScalars;
  }

  /**
   * Permanent: torn down, or this runtime's meter-source epoch was superseded.
   * Neither reopens for this runtime, so work held behind it is dropped.
   */
  readonly isDiscarded = (): boolean => this.tornDown || this.isMeterSourceEpochDiscarded();

  /**
   * Reopenable: membership not yet joined, or the meter source not authorized.
   * The registry's raw gate, so asking it arms no recovery.
   */
  readonly isAuthorityClosed = (): boolean => !this.isMembershipReady() || !this.isMeterSourceAuthorized();

  /** Install the area's source-authority actuation retry; see the field above. */
  bindSourceActuationRetry(schedule: () => void): void {
    if (this.scheduleSourceActuationRetry !== unboundSourceActuationRetry) {
      throw new Error('SubHomeRuntime: the source actuation retry is already bound');
    }
    this.scheduleSourceActuationRetry = schedule;
  }

  /**
   * The meter-source gate on the CONTROL path: the registry's answer, and a
   * retained actuation retry when a transient read closed it. Only the control
   * path may ask this; the read surface asks {@link isMeterSourceAuthorized}.
   */
  readonly isMeterSourceAuthorizedForExecution = (): boolean => {
    const authorized = this.isMeterSourceAuthorized();
    if (!authorized && !this.isMeterSourceEpochDiscarded()) this.scheduleSourceActuationRetry();
    return authorized;
  };

  /**
   * The canonical effective no-actuation switch: both external trust boundaries
   * fold into the persisted per-home toggle — membership must be committed and
   * this meter-bearing source epoch must be authorized before writes are enabled.
   * The CONTROL path's form, which arms the source recovery when it is asked.
   */
  readonly isEffectiveDryRunForExecution = (): boolean => (
    this.resolveEffectiveDryRun(this.isMeterSourceAuthorizedForExecution)
  );

  /** The same switch for the read surface: the registry's raw gate, no recovery armed. */
  readonly readEffectiveDryRun = (): boolean => this.resolveEffectiveDryRun(this.isMeterSourceAuthorized);

  /**
   * The area's final write fence, consulted at the actuator: the dry-run gates,
   * plus a prepared reconcile superseded mid-apply. The execution source gate
   * is asked last, so a retry is armed only when nothing else is fencing.
   */
  isActuationFenced(isPreparedReconcileSuperseded: () => boolean): boolean {
    if (
      this.tornDown
      || !this.isMembershipReady()
      || isPreparedReconcileSuperseded()
    ) return true;
    return !this.isMeterSourceAuthorizedForExecution();
  }

  private resolveEffectiveDryRun(isMeterSourceAuthorized: () => boolean): boolean {
    return this.tornDown
      || !this.isMembershipReady()
      || !isMeterSourceAuthorized()
      || this.capacityScalars.dryRun;
  }
}
