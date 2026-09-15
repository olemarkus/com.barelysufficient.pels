import type { DevicePlan } from './planTypes';

/**
 * The plan `PlanService` last published, and when. One value because neither
 * exists without the other: every publish stamps both, so "a plan with no
 * publish time" is not a state the service can be in — as two nullable fields
 * it was one the type allowed.
 */
export type PublishedPlan = {
  plan: DevicePlan;
  publishedAtMs: number;
};
