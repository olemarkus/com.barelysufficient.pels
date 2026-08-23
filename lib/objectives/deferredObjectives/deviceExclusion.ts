import type { DeferredObjectiveDiagnosticReasonCode } from './diagnosticTypes';

/**
 * Why a task's device is out of the main planning lane while the device itself
 * still exists.
 *
 * OWNED BY: this module defines the vocabulary; the wiring layer
 * (`resolveSmartTaskDeviceExclusion`, `setup/appInit/smartTaskHomeScope.ts`)
 * owns the resolution and is the only place that reads home membership or the
 * managed-device map. Governing note: `notes/deferred-load-objectives/README.md`
 * § reason codes.
 *
 * Both arms describe a DURABLE, owner-visible scope fact, never a transient
 * read failure: `sub_home` is multi-home v1 scoping (smart tasks are
 * main-home-only), `unmanaged` is the owner turning "Managed by PELS" off.
 * Neither is "the device is gone" — that stays `objective_missing_device`, and
 * keeping the two apart is the whole point of this seam. A task on an excluded
 * device PAUSES: it is never deleted, it takes no allocation, and it resumes on
 * the first cycle after the exclusion lifts.
 */
export type ObjectiveDeviceExclusion = 'sub_home' | 'unmanaged';

/**
 * Injected by the wiring layer (this leafward subsystem reads neither home
 * membership nor the managed-device map itself). `null` = the device
 * participates in the main lane normally.
 */
export type ResolveObjectiveDeviceExclusion = (deviceId: string) => ObjectiveDeviceExclusion | null;

/**
 * The dedicated `unknown` reason code each exclusion reports.
 *
 * The two-member type above earns its keep over having the wiring layer return
 * the reason code directly: it keeps the set of exclusions closed (wiring
 * cannot invent a code this module has no branch for), and `satisfies` makes
 * the mapping total, so a new exclusion arm cannot ship without one.
 */
export const OBJECTIVE_EXCLUSION_REASON_CODES = {
  sub_home: 'objective_device_in_sub_home',
  unmanaged: 'objective_device_unmanaged',
} as const satisfies Record<ObjectiveDeviceExclusion, DeferredObjectiveDiagnosticReasonCode>;

/**
 * Roster-side view of the same seam: the allocator and the ordering pass only
 * need "is this device out of the main lane", not which way.
 */
export const buildObjectiveDeviceExclusionPredicate = (
  resolve: ResolveObjectiveDeviceExclusion | undefined,
): ((deviceId: string) => boolean) | undefined => (
  resolve === undefined ? undefined : (deviceId: string) => resolve(deviceId) !== null
);
