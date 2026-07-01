import { describe, expect, it } from 'vitest';
import {
  buildObjectiveSignature,
  compareObjectiveSignatures,
} from '../../lib/objectives/deferredObjectives/activePlanSignature';

const base = {
  objectiveKind: 'temperature' as const,
  targetTemperatureC: 65,
  targetPercent: null,
  deadlineAtMs: 1_000,
  enforcement: 'soft' as const,
};

describe('activePlanSignature — pause permission', () => {
  it('re-versions (rescueOnly) when only pauseLowerPriorityDevices toggles on a committed task', () => {
    // Regression: pause must be in the rescue signature so a Flow that toggles only pause
    // re-versions the active plan immediately (flow_permission_changed), not on some later replan.
    const before = buildObjectiveSignature({ ...base, rescue: { exemptFromBudget: 'always' } });
    const after = buildObjectiveSignature({
      ...base,
      rescue: { exemptFromBudget: 'always', pauseLowerPriorityDevices: 'always' },
    });
    expect(after).not.toBe(before);
    expect(compareObjectiveSignatures(before, after)).toEqual({ changed: true, rescueOnly: true });
  });

  it('detects a pause-only grant as a rescue change vs no rescue', () => {
    const none = buildObjectiveSignature({ ...base });
    const pauseOnly = buildObjectiveSignature({ ...base, rescue: { pauseLowerPriorityDevices: 'always' } });
    expect(compareObjectiveSignatures(none, pauseOnly)).toEqual({ changed: true, rescueOnly: true });
  });

  it('keeps the shipped 3-tuple form (no deploy churn) for exempt/limit-only tasks', () => {
    // Back-compat: a task that never sets pause serializes exactly as before pause existed, so
    // existing committed tasks do not churn a spurious flow_permission_changed revision on deploy.
    const sig = buildObjectiveSignature({
      ...base,
      rescue: { exemptFromBudget: 'always', limitLowerPriorityDevices: 'always' },
    });
    expect(sig).toContain('["rescue","always","always"]'); // 3-tuple, no appended pause slot
  });
});
