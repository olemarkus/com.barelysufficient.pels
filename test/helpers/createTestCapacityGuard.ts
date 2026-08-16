import CapacityGuard, { type CapacityGuardOptions } from '../../lib/power/capacityGuard';

/**
 * Constructs a `CapacityGuard` for tests that do not assert on its structured
 * logs.
 *
 * `structuredLog` is required on the production type on purpose: both factories
 * always inject the home-attributed `capacity` logger, and a default inside the
 * guard would silently drop the `homeId` correlation every incident log depends
 * on. Tests that *do* assert on logging pass their own spy through here; the
 * rest get a sink, so the requirement stays honest in production without
 * forcing a logger into every fixture.
 */
export function createTestCapacityGuard(
  options: Omit<CapacityGuardOptions, 'structuredLog'>
    & Partial<Pick<CapacityGuardOptions, 'structuredLog'>>,
): CapacityGuard {
  return new CapacityGuard({
    ...options,
    structuredLog: options.structuredLog ?? { info: () => undefined },
  });
}
