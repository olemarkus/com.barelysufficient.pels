import type { DevicePlan } from './planTypes';
import { getHourBucketKey } from '../utils/hourBuckets';

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

/**
 * The devices the plan in force treats as budget-exempt: the owner's static
 * setting AND a smart task's "may go over daily budget" claim, which only the
 * planner resolves (`buildAdmissionDecoration`). The sample path books an exempt
 * device's measured draw into the exempt kWh integral from these ids, so a task
 * the threshold exempts is not also counted as used.
 *
 * A task's claim belongs to the hour it was planned for, so a plan published in
 * an earlier tracker hour answers nothing (the static flag still applies on the
 * sample path), and neither does the absence of any published plan.
 */
export const resolvePublishedBudgetExemptDeviceIds = (
  published: PublishedPlan | null,
  nowMs: number,
): ReadonlySet<string> => {
  if (published === null || getHourBucketKey(published.publishedAtMs) !== getHourBucketKey(nowMs)) {
    return new Set();
  }
  return new Set(published.plan.devices.filter((device) => device.budgetExempt === true).map((device) => device.id));
};
