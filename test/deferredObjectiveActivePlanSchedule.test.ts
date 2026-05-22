import { shouldFireNotification } from '../lib/plan/deferredObjectives/activePlanSchedule';

describe('shouldFireNotification', () => {
  it('stays quiet when the planned-hour count is unchanged', () => {
    expect(shouldFireNotification(3, 3, 'cannot_meet')).toBe(false);
    expect(shouldFireNotification(0, 0, 'cannot_meet')).toBe(false);
  });

  it('fires whenever the schedule still has planned hours after a count change', () => {
    expect(shouldFireNotification(2, 3, 'on_track')).toBe(true);
    expect(shouldFireNotification(3, 1, 'satisfied')).toBe(true);
  });

  it('fires on an empty collapse for degraded statuses', () => {
    expect(shouldFireNotification(3, 0, 'cannot_meet')).toBe(true);
    expect(shouldFireNotification(3, 0, 'invalid')).toBe(true);
    // feasible_above_floor is the only at_risk that can reach an empty floor
    // schedule (reserve/policy at-risk always plan buckets); an empty floor
    // schedule is still a "plan blew up" event, so it must fire.
    expect(shouldFireNotification(3, 0, 'at_risk')).toBe(true);
  });

  it('suppresses an empty collapse when the target is already met', () => {
    expect(shouldFireNotification(3, 0, 'satisfied')).toBe(false);
    expect(shouldFireNotification(3, 0, 'on_track')).toBe(false);
  });
});
