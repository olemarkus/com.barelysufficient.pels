import { describe, expect, it } from 'vitest';
import {
  describePlanRebuildTrigger,
  PLAN_REBUILD_TRIGGERS,
  POWER_SAMPLE_REBUILD_TRIGGERS,
} from '../../lib/plan/planRebuildTrigger';
import { getPlanRebuildLogLevel } from '../../lib/plan/planRebuildMetrics';

describe('describePlanRebuildTrigger', () => {
  it('leaves a trigger that carries no detail exactly as it is named', () => {
    expect(describePlanRebuildTrigger('freshness_heartbeat')).toBe('freshness_heartbeat');
    expect(describePlanRebuildTrigger('startup_snapshot_bootstrap')).toBe('startup_snapshot_bootstrap');
  });

  // The labels below are what shipped before the trigger set was closed. They are
  // asserted literally because they are the searchable strings in production logs
  // (`reasonCode`, the `plan_rebuild(...)` span) — closing the SET must not move
  // what an operator greps for.
  it('composes the settings and flow-card labels the log has always carried', () => {
    expect(describePlanRebuildTrigger('settings', 'capacity_priorities'))
      .toBe('settings:capacity_priorities');
    expect(describePlanRebuildTrigger('flow_card', 'expected_power'))
      .toBe('flow_card:expected_power');
  });

  it('keeps the price label a sentence rather than a path', () => {
    expect(describePlanRebuildTrigger('price', 'cheap')).toBe('price optimization (cheap hour)');
    expect(describePlanRebuildTrigger('price', 'expensive')).toBe('price optimization (expensive hour)');
  });
});

// `getPlanRebuildLogLevel` matched `reason.startsWith('settings:')` before the set
// was closed and now matches `trigger === 'settings'`. It had no test at any tier,
// and it decides whether an operator sees the line at all.
describe('getPlanRebuildLogLevel', () => {
  const quietOutcome = {
    failed: false, appliedActions: false, actionChanged: false,
  } as Parameters<typeof getPlanRebuildLogLevel>[2];

  it('logs a settings rebuild at info however its detail is spelled', () => {
    expect(getPlanRebuildLogLevel('settings', 10, quietOutcome)).toBe('info');
  });

  it('keeps startup and the first build at info', () => {
    expect(getPlanRebuildLogLevel('initial', 10, quietOutcome)).toBe('info');
    expect(getPlanRebuildLogLevel('startup_snapshot_bootstrap', 10, quietOutcome)).toBe('info');
  });

  it('stays silent for an ordinary quiet power-sample rebuild', () => {
    expect(getPlanRebuildLogLevel('power_delta', 10, quietOutcome)).toBeNull();
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
