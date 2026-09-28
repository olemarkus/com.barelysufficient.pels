import { createHomeMembershipService, type HomeMembershipFactoryDeps } from '../lib/home/createHomeMembershipService';
import type { HomeMembershipService } from '../lib/home/homeMembershipService';
import { normalizeError } from '../lib/utils/errorUtils';
import { readConfiguredPowerSource } from './powerSourceSettings';

/** The membership service and the transport-trigger subscriptions it owns. */
export type HomeMembershipWiring = {
  service: HomeMembershipService;
  teardown: () => void;
};

/** Inputs for constructing the membership service and connecting its triggers. */
export type HomeMembershipWiringParams = Omit<HomeMembershipFactoryDeps, 'getConfiguredPowerSource'> & {
  subscribeToObservedStateRefresh: (listener: () => void) => () => void;
  /** The transport's zone-tree-commit seam; called with `undefined` to detach. */
  setOnZoneTreeCommitted: (callback: (() => void) | undefined) => void;
  /** The transport's realtime zone-move seam; called with `undefined` to detach. */
  setOnDeviceZoneChanged: (callback: (() => void) | undefined) => void;
};

/**
 * Build the home-owned membership service and connect it to transport-owned
 * committed-snapshot and zone-change events. Setup supplies collaborators;
 * persisted reads and membership classification stay with `lib/home`.
 */
export const wireHomeMembershipService = (
  params: HomeMembershipWiringParams,
): HomeMembershipWiring => {
  const service = createHomeMembershipService({
    ...params,
    getConfiguredPowerSource: () => readConfiguredPowerSource(params.settings),
  });
  const recomputeContained = (
    trigger: 'startup' | 'snapshot_refresh' | 'zone_tree_commit' | 'realtime_zone_move',
  ): void => {
    try {
      service.recompute();
    } catch (error) {
      params.getLogger()?.error({
        event: 'home_membership_recompute_failed',
        trigger,
        err: normalizeError(error),
      });
    }
  };
  const unsubscribeRefresh = params.subscribeToObservedStateRefresh(
    () => recomputeContained('snapshot_refresh'),
  );
  params.setOnZoneTreeCommitted(() => recomputeContained('zone_tree_commit'));
  params.setOnDeviceZoneChanged(() => recomputeContained('realtime_zone_move'));
  recomputeContained('startup');

  return {
    service,
    teardown: () => {
      unsubscribeRefresh();
      params.setOnZoneTreeCommitted(undefined);
      params.setOnDeviceZoneChanged(undefined);
    },
  };
};
