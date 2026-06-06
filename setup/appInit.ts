/**
 * Thin composition entry for the app-init wiring. The concrete service
 * factories and registrars live in focused `setup/appInit/` sub-files
 * (one purpose each, per the `setup/` convention); this barrel keeps the
 * public surface that `app.ts` and the integration tests import stable.
 */
export {
  buildDeferredObjectiveDeviceWriteDeps,
  createDeferredObjectiveActivePlanRecorder,
  createDeferredObjectivePlanHistoryRecorder,
  persistDeferredObjectiveObservationWatermark,
} from './appInit/deferredRecorders';
export { createDeferredObjectiveLifecycleEmitter } from './appInit/deferredObjectiveLifecycle';
export { createDeviceDiagnosticsService } from './appInit/deviceDiagnosticsService';
export { createPlanEngine } from './appInit/createPlanEngine';
export { createPlanService } from './appInit/createPlanService';
export { createPriceCoordinator, createPriceFlowTagPublisher } from './appInit/priceServices';
export { registerAppFlowCards } from './appInit/registerAppFlowCards';
export { evictMissingDeviceCacheEntries, toPlanDevice } from './appInit/toPlanDevice';
