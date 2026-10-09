import { vi } from 'vitest';
import type CapacityGuard from '../../lib/power/capacityGuard';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { SheddingDeps } from '../../lib/plan/shedding/types';
import { partialDouble } from './partialDouble';

type SheddingWiring = Pick<SheddingDeps, 'pendingBinaryCommandStore' | 'getShedBehavior' | 'log' | 'debugStructured'>;

/**
 * The `buildSheddingPlan` deps a spec is not about: the pending commands are
 * `state`'s own, every device sheds by turning off, and the logs go to spies.
 * A spec supplies the guard, shortfall threshold and power tracker, and
 * overrides the rest.
 */
export const sheddingWiring = (state: PlanEngineState): SheddingWiring => ({
  pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  getShedBehavior: () => ({ action: 'turn_off' }),
  log: vi.fn(),
  debugStructured: vi.fn(),
});

/** A capacity guard whose writes are spies and which is never in shortfall. */
export const capacityGuardSpy = (): CapacityGuard => partialDouble<CapacityGuard>({
  recordPlanVerdict: vi.fn().mockResolvedValue(undefined),
  recordReading: vi.fn().mockResolvedValue(undefined),
  recordCompletePeriodReading: vi.fn().mockResolvedValue(undefined),
  isInShortfall: vi.fn().mockReturnValue(false),
});
