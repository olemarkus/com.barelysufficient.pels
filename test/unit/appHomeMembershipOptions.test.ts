import { buildAppHomeMembershipOptions } from '../../setup/appInit/appHomeMembershipOptions';
import type { HomeMembershipService } from '../../setup/homeMembership';
import type { HomeRuntimeRegistry } from '../../setup/homeRuntime/homeRuntimeRegistry';

const membership = {} as HomeMembershipService;

const buildOptions = (
  prepareModeCatalogsForOwnership: (allowPendingOwnershipGeneration?: boolean) => boolean,
  retryDeferredOvershootSeed: (
    membership: HomeMembershipService,
    allowPendingOwnershipGeneration: boolean,
  ) => void,
) => buildAppHomeMembershipOptions({
  getRegistry: () => ({
    prepareModeCatalogsForOwnership,
  } as unknown as HomeRuntimeRegistry),
  getMembership: () => membership,
  getMainStableSampleRevision: () => ({ state: 'stable', revision: 1 }),
  beginMainPreparedReconcile: () => () => undefined,
  flushMainShortfallSideEffect: async () => true,
  retryDeferredOvershootSeed,
});

describe('owner-aware support seed ordering', () => {
  it('initializes area mode catalogs before deriving overshoot defaults', () => {
    const order: string[] = [];
    const options = buildOptions(
      () => {
        order.push('catalog');
        return true;
      },
      vi.fn(() => { order.push('seed'); }),
    );

    options.onOwnershipReadyBeforePlanWork?.(membership, false);

    expect(order).toEqual(['catalog', 'seed']);
  });

  it('allows catalog initialization from a classified pending generation during recovery', () => {
    const prepareModeCatalogsForOwnership = vi.fn(() => true);
    const options = buildOptions(prepareModeCatalogsForOwnership, vi.fn());

    options.onOwnershipReadyBeforePlanWork?.(membership, true);

    expect(prepareModeCatalogsForOwnership).toHaveBeenCalledWith(true);
  });

  it('routes unavailable area catalogs into ownership recovery', () => {
    const retryDeferredOvershootSeed = vi.fn();
    const options = buildOptions(() => false, retryDeferredOvershootSeed);

    expect(() => options.onOwnershipReadyBeforePlanWork?.(membership, false))
      .toThrow('Mode catalogs unavailable for ownership preparation');

    expect(retryDeferredOvershootSeed).not.toHaveBeenCalled();
  });
});
