// Payloads of the realtime events the runtime emits to the settings UI. The
// event names live with the shared settings keys in
// `packages/shared-domain/src/settings/settingsKeys.ts`.

/** `POWER_TRACKER_PERSISTED_EVENT`: emitted after every tracker persist, for every home. */
export type PowerTrackerPersistedPayload = { homeId: string };

/** `PLAN_STATUS_PUBLISHED_EVENT`: emitted after a status publish or device presentation refresh. */
export type PlanStatusPublishedPayload = { homeId: string };
