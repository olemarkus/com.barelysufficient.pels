import { describe, expect, it } from 'vitest';
import {
  describePlanRebuildTrigger,
  PLAN_REBUILD_TRIGGERS,
  POWER_SAMPLE_REBUILD_TRIGGERS,
} from '../../lib/plan/planRebuildTrigger';

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

describe('the rebuild trigger set', () => {
  it('lists every power-sample trigger as a plan rebuild trigger', () => {
    for (const trigger of POWER_SAMPLE_REBUILD_TRIGGERS) {
      expect(PLAN_REBUILD_TRIGGERS).toContain(trigger);
    }
  });

  it('names each trigger exactly once', () => {
    expect(new Set(PLAN_REBUILD_TRIGGERS).size).toBe(PLAN_REBUILD_TRIGGERS.length);
  });
});
