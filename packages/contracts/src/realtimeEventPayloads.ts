// Payloads of the realtime events the runtime emits to the settings UI. The
// event names live with the shared settings keys in
// `packages/shared-domain/src/settings/settingsKeys.ts`.

import type { ResolvedDeferredObjectiveActivePlansV2 } from './deferredObjectiveActivePlans.js';

/** `POWER_TRACKER_PERSISTED_EVENT`: emitted after every tracker persist, for every home. */
export type PowerTrackerPersistedPayload = { homeId: string };

/** `PLAN_STATUS_PUBLISHED_EVENT`: emitted after a status publish or device presentation refresh. */
export type PlanStatusPublishedPayload = { homeId: string };

/**
 * `DEFERRED_OBJECTIVE_ACTIVE_PLANS_UPDATED_EVENT`: emitted on every save of the
 * smart-task active plans; the resolved view the bootstrap carries.
 */
export type DeferredObjectiveActivePlansUpdatedPayload = ResolvedDeferredObjectiveActivePlansV2;
