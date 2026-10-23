import { vi } from 'vitest';
import type CapacityGuard from '../../lib/power/capacityGuard';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { PlanEngineState } from '../../lib/plan/planState';
import type { SheddingDeps } from '../../lib/plan/shedding/types';
import { partialDouble } from './partialDouble';
import { testLogger } from '../utils/testLogger';

type SheddingWiring = Pick<SheddingDeps, 'pendingBinaryCommandStore' | 'getShedBehavior' | 'structuredLog'>;

/**
 * The `buildSheddingPlan` deps a spec is not about: the pending commands are
 * `state`'s own and every device sheds by turning off.
 * A spec supplies the guard, shortfall threshold and power tracker, and
 * overrides the rest.
 */
export const sheddingWiring = (state: PlanEngineState): SheddingWiring => ({
  pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
  getShedBehavior: () => ({ action: 'turn_off' }),
  structuredLog: testLogger,
});

/** A capacity guard whose writes are spies and which is never in shortfall. */
export const capacityGuardSpy = (): CapacityGuard => partialDouble<CapacityGuard>({
  recordPlanVerdict: vi.fn().mockResolvedValue(undefined),
  recordReading: vi.fn().mockResolvedValue(undefined),
  recordCompletePeriodReading: vi.fn().mockResolvedValue(undefined),
  isInShortfall: vi.fn().mockReturnValue(false),
});
