import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { HomeMembershipWiring } from './homeMembershipWiring';
import type { HomeRuntimeRegistry } from './homeRuntime/homeRuntimeRegistry';
import type { createHomeCapacityGuard } from './homeRuntime/createHomeCapacityGuard';
import type { BackgroundCollectors } from './appInit/startBackgroundCollectors';

/**
 * Handles to the services ordered startup constructs, held by `PelsApp` — the
 * composition root — and filled and cleared by `AppServiceWiring`. The wiring
 * builds them and hands them over; it does not remember them: a handle to a
 * constructed service belongs to whoever composed the app.
 */
export type AppRuntimeHandles = {
  structuredLogger?: PinoLogger;
  homeMembershipService?: HomeMembershipWiring['service'];
  homeRuntimeRegistry?: HomeRuntimeRegistry;
  /** The Main-home shortfall gate, as the wiring hands it over and reads it back. */
  mainShortfallSideEffectGate?: ReturnType<typeof createHomeCapacityGuard>['shortfallSideEffectGate'];
  /** Ask Main to re-establish meter authority, now or on the next scheduled pass. */
  requestMainAuthorityRecovery?: (timing?: 'scheduled' | 'immediate') => void;
  stopSettingsHandler?: () => void;
  /**
   * The weather collector and both solar-forecast controllers, started together
   * by the post-startup background step. Absent until then: the settings hook,
   * the power pipeline and the uninit sweep are all wired before it.
   */
  backgroundCollectors?: BackgroundCollectors;
};
