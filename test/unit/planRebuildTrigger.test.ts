import { describe, expect, it } from 'vitest';
import {
  describePlanRebuildTrigger,
  PLAN_REBUILD_TRIGGERS,
  POWER_SAMPLE_REBUILD_TRIGGERS,
} from '../../lib/plan/planRebuildTrigger';
import { shouldLogPlanRebuildAtInfo } from '../../lib/plan/planRebuildMetrics';

describe('describePlanRebuildTrigger', () => {
  it('leaves a trigger that carries no detail exactly as it is named', () => {
    expect(describePlanRebuildTrigger('freshness_heartbeat')).toBe('freshness_heartbeat');
    expect(describePlanRebuildTrigger('startup_snapshot_bootstrap')).toBe('startup_snapshot_bootstrap');
  });

  // The labels below are what shipped before the trigger set was closed. They are
  // asserted literally because they are the searchable strings in production logs
  // (`reasonCode`, the `plan_rebuild(...)` span) — closing the SET must not move
  // what an operator greps for.
  it('composes the settings label the log has always carried', () => {
    expect(describePlanRebuildTrigger('settings', 'capacity_priorities'))
      .toBe('settings:capacity_priorities');
  });

});

// `shouldLogPlanRebuildAtInfo` matched `reason.startsWith('settings:')` before the set
// was closed and now matches `trigger === 'settings'`. It had no test at any tier,
// and it decides whether an operator sees the line at all.
describe('shouldLogPlanRebuildAtInfo', () => {
  const quietOutcome = {
    failed: false, appliedActions: false, actionChanged: false,
  } as Parameters<typeof shouldLogPlanRebuildAtInfo>[2];

  it('logs a settings rebuild at info however its detail is spelled', () => {
    expect(shouldLogPlanRebuildAtInfo('settings', 10, quietOutcome)).toBe(true);
  });

  it('keeps startup and the first build at info', () => {
    expect(shouldLogPlanRebuildAtInfo('initial', 10, quietOutcome)).toBe(true);
    expect(shouldLogPlanRebuildAtInfo('startup_snapshot_bootstrap', 10, quietOutcome)).toBe(true);
  });

  it('stays silent for an ordinary quiet power-sample rebuild', () => {
    expect(shouldLogPlanRebuildAtInfo('power_delta', 10, quietOutcome)).toBe(false);
  });
});

describe('the rebuild trigger set', () => {
  it('lists every power-sample trigger as a plan rebuild trigger', () => {
    for (const trigger of POWER_SAMPLE_REBUILD_TRIGGERS) {
      expect(PLAN_REBUILD_TRIGGERS).toContain(trigger);
    }
  });

  // The rule the module exists for, stated in its own docblock and previously
  // asserted nowhere: a device observation is not on the list. Anything matching
  // is either the trigger coming back or a name that reads as if it had.
  it('has no name for a device observation', () => {
    const observationish = (PLAN_REBUILD_TRIGGERS as readonly string[])
      .filter((trigger) => /observ|device_|realtime|external_off/.test(trigger));
    expect(observationish).toEqual([]);
  });

  it('names each trigger exactly once', () => {
    expect(new Set(PLAN_REBUILD_TRIGGERS).size).toBe(PLAN_REBUILD_TRIGGERS.length);
  });
});
