import type { HomeMembershipService } from '../homeMembership';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import type { WireHomeMembershipOptions } from './wireHomeMembership';
import type { StableSampleRevision } from '../powerSamplePipeline';

export type StableSampleRevisionReader = () => StableSampleRevision;

export const createPreparedMainReconcileFence = (
  readStableRevision: StableSampleRevisionReader,
): {
  begin: (sampleRevision: number) => () => void;
  isActive: () => boolean;
  isSuperseded: () => boolean;
} => {
  const activeRevisions = new Map<symbol, number>();
  return {
    begin: (sampleRevision) => {
      const handle = Symbol('preparedMainReconcile');
      activeRevisions.set(handle, sampleRevision);
      return () => { activeRevisions.delete(handle); };
    },
    isActive: () => activeRevisions.size > 0,
    isSuperseded: () => {
      if (activeRevisions.size === 0) return false;
      const current = readStableRevision();
      return current.state !== 'stable'
        || [...activeRevisions.values()].some((revision) => revision !== current.revision);
    },
  };
};

/**
 * Lazy cross-runtime callbacks for membership wiring. The registry is created
 * after membership, so every closure resolves it at the point of use.
 */
export const buildAppHomeMembershipOptions = (params: {
  getRegistry: () => HomeRuntimeRegistry | undefined;
  getMembership: () => HomeMembershipService | undefined;
  getMainStableSampleRevision: () => StableSampleRevision;
  beginMainPreparedReconcile: (sampleRevision: number) => () => void;
  flushMainShortfallSideEffect: () => Promise<boolean>;
  retryDeferredOvershootSeed: (
    membership: HomeMembershipService,
    allowPendingOwnershipGeneration: boolean,
  ) => void;
}): WireHomeMembershipOptions => ({
  onOwnershipReadyBeforePlanWork: (membership, allowPendingOwnershipGeneration) => {
    const registry = params.getRegistry();
    if (
      registry
      && !registry.prepareModeCatalogsForOwnership(allowPendingOwnershipGeneration)
    ) {
      // The membership callback is contained and turns a throw into the owned
      // bounded recovery path. A plain return would consume this readiness
      // edge while leaving the pending ownership generation fenced forever.
      throw new Error('Mode catalogs unavailable for ownership preparation');
    }
    params.retryDeferredOvershootSeed(membership, allowPendingOwnershipGeneration);
  },
  onZoneTreeCommitReady: () => params.getRegistry()?.onMembershipReady(),
  onRuntimeActiveChanged: () => params.getRegistry()?.reconcile(),
  onSubHomeMembershipChanged: () => params.getRegistry()?.onMembershipChanged() ?? true,
  ownershipGenerationRuntime: {
    getMainStableSampleRevision: params.getMainStableSampleRevision,
    beginMainPreparedReconcile: params.beginMainPreparedReconcile,
    flushMainShortfallSideEffect: params.flushMainShortfallSideEffect,
    prepare: async () => {
      const registry = params.getRegistry();
      if (!registry) return params.getMembership()?.hasSubHomes() !== true;
      return registry.prepareOwnershipGeneration();
    },
    isPreparedCurrent: () => (
      params.getRegistry()?.isOwnershipGenerationPreparationCurrent()
      ?? (params.getMembership()?.hasSubHomes() !== true)
    ),
    reconcile: async () => (
      params.getRegistry()?.reconcilePreparedOwnershipGeneration()
      ?? (params.getMembership()?.hasSubHomes() !== true)
    ),
  },
});
