import { buildAppHomeMembershipOptions } from '../../setup/appInit/appHomeMembershipOptions';
import type { HomeMembershipService } from '../../lib/home/homeMembershipService';
import type { HomeRuntimeRegistry } from '../../setup/homeRuntime/homeRuntimeRegistry';

const membership = {} as HomeMembershipService;

const buildOptions = (
  prepareModeCatalogsForOwnership: (allowPendingOwnershipGeneration?: boolean) => boolean,
) => buildAppHomeMembershipOptions(
  () => ({
    prepareModeCatalogsForOwnership,
  } as unknown as HomeRuntimeRegistry),
  () => membership,
  () => ({ state: 'stable', revision: 1 }),
  () => () => undefined,
  async () => true,
);

describe('ownership readiness before plan work', () => {
  it('initializes area mode catalogs', () => {
    const prepareModeCatalogsForOwnership = vi.fn(() => true);
    const options = buildOptions(prepareModeCatalogsForOwnership);

    options.onOwnershipReadyBeforePlanWork?.(false);

    expect(prepareModeCatalogsForOwnership).toHaveBeenCalledWith(false);
  });

  it('allows catalog initialization from a classified pending generation during recovery', () => {
    const prepareModeCatalogsForOwnership = vi.fn(() => true);
    const options = buildOptions(prepareModeCatalogsForOwnership);

    options.onOwnershipReadyBeforePlanWork?.(true);

    expect(prepareModeCatalogsForOwnership).toHaveBeenCalledWith(true);
  });

  it('routes unavailable area catalogs into ownership recovery', () => {
    const options = buildOptions(() => false);

    expect(() => options.onOwnershipReadyBeforePlanWork?.(false))
      .toThrow('Mode catalogs unavailable for ownership preparation');
  });
});
