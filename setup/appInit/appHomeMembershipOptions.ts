import type { HomeMembershipWiring } from '../homeMembershipWiring';
import type { HomeRuntimeRegistry } from '../homeRuntime/homeRuntimeRegistry';
import type { WireHomeMembershipOptions } from './wireHomeMembership';
import type { StableSampleRevision } from '../powerSamplePipeline';

type HomeMembershipService = HomeMembershipWiring['service'];

/**
 * Lazy cross-runtime callbacks for membership wiring. The registry is created
 * after membership, so every closure resolves it at the point of use.
 */
export const buildAppHomeMembershipOptions = (
  getRegistry: () => HomeRuntimeRegistry | undefined,
  getMembership: () => HomeMembershipService | undefined,
  getMainStableSampleRevision: () => StableSampleRevision,
  beginMainPreparedReconcile: (sampleRevision: number) => () => void,
  flushMainShortfallSideEffect: () => Promise<boolean>,
): WireHomeMembershipOptions => ({
  onOwnershipReadyBeforePlanWork: (allowPendingOwnershipGeneration) => {
    const registry = getRegistry();
    if (
      registry
      && !registry.prepareModeCatalogsForOwnership(allowPendingOwnershipGeneration)
    ) {
      // The membership callback is contained and turns a throw into the owned
      // bounded recovery path. A plain return would consume this readiness
      // edge while leaving the pending ownership generation fenced forever.
      throw new Error('Mode catalogs unavailable for ownership preparation');
    }
  },
  onZoneTreeCommitReady: () => getRegistry()?.onMembershipReady(),
  onRuntimeActiveChanged: () => getRegistry()?.reconcile(),
  onSubHomeMembershipChanged: () => getRegistry()?.onMembershipChanged() ?? true,
  ownershipGenerationRuntime: {
    getMainStableSampleRevision,
    beginMainPreparedReconcile,
    flushMainShortfallSideEffect,
    prepare: async () => {
      const registry = getRegistry();
      if (!registry) return getMembership()?.hasSubHomes() !== true;
      return registry.prepareOwnershipGeneration();
    },
    isPreparedCurrent: () => (
      getRegistry()?.isOwnershipGenerationPreparationCurrent()
      ?? (getMembership()?.hasSubHomes() !== true)
    ),
    reconcile: async () => (
      getRegistry()?.reconcilePreparedOwnershipGeneration()
      ?? (getMembership()?.hasSubHomes() !== true)
    ),
  },
});
