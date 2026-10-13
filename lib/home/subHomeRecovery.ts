/**
 * A meter area's prepared-rebuild lanes (multi-home R7b), each one rebuild
 * behind the area's prepared-reconcile fence: the membership-ready apply-edge,
 * the actuation retry after a transient meter-source read closed the write
 * seam, and the area's side of the ownership-generation protocol. They keep
 * state across attempts or decide whether a prepared apply is current — the
 * edge's latch, the retry's backoff, the generation's currency — so they live
 * in lib/home with the area's `SubHomeRuntime`, and the wiring
 * (`setup/homeRuntime/createHomeCapacityBundle.ts`) only connects them. The
 * lanes are `subHomeMembershipReadyEdge.ts`, `subHomeSourceRecovery.ts` and
 * `subHomeOwnershipGeneration.ts`; this module holds what they rebuild through.
 *
 * Home imports no other domain: the plan rebuild and the sample ledger arrive
 * as the structural ports below, which `PlanService` and the area's sample
 * pipeline satisfy.
 */
import type { Logger as PinoLogger } from '../logging/logger';
import type { TimerRegistry } from '../utils/timerRegistry';
import type { SubHomeRuntime } from './subHomeRuntime';

/**
 * Whether every sample the area's pipeline was asked to ingest has finished,
 * as its ledger reports it (`StableSampleRevision`, `lib/power/sampleIngestQueue.ts`).
 */
export type SubHomeSampleRevision =
  | { state: 'stable'; revision: number }
  | { state: 'pending' };

/**
 * The area's plan as a lane asks it: one rebuild that both plans and actuates.
 * A rebuild prepared against a sample revision carries the point-of-use abort;
 * the ownership-change rebuild is the one that does not.
 */
export type SubHomePlanRebuild = {
  rebuildPlanFromCache(trigger: 'home_membership_changed'): Promise<{ failed: boolean; gated: boolean }>;
  rebuildPlanFromCache(
    trigger: 'home_membership_ready' | 'home_source_authority_recovered' | 'home_ownership_generation_prepared',
    options: { shouldAbort: () => boolean; onAbort: () => void },
  ): Promise<{ failed: boolean; gated: boolean }>;
};

/** The area's sample pipeline as a lane reads it. */
export type SubHomeSampleLedger = {
  getStableSampleRevision(): SubHomeSampleRevision;
};

/** What the lanes rebuild through: the area's plan, its sample ledger and its prepared-reconcile protocol. */
export type SubHomeRecoveryDeps = {
  runtime: SubHomeRuntime;
  timers: TimerRegistry;
  timerKey: (suffix: string) => string;
  getLogger: () => PinoLogger | undefined;
  planService: SubHomePlanRebuild;
  pipeline: SubHomeSampleLedger;
  /** Arm the prepared-reconcile fence for `sampleRevision`; the returned callback disarms it. */
  beginPreparedReconcile: (sampleRevision: number) => () => void;
  /** Release a shortfall transition held for a prepared apply; false keeps it held. */
  flushDeferredShortfallSideEffect: () => Promise<boolean>;
};

/** Whether `revision` is still the stable sample revision the area's pipeline serves. */
export const isCurrentSampleRevision = (pipeline: SubHomeSampleLedger, revision: number): boolean => {
  const current = pipeline.getStableSampleRevision();
  return current.state === 'stable' && current.revision === revision;
};
