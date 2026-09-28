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
  progressDirection: 'increasing' as const,
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
    expect(compareObjectiveSignatures(before, after)).toEqual({
      changed: true,
      directionOnly: false,
      rescueOnly: true,
    });
  });

  it('replaces the old upward trajectory when the device resolves to cooling', () => {
    const legacy = JSON.stringify(['temperature', 65, null, 1_000, 'soft']);
    const cooling = buildObjectiveSignature({ ...base, progressDirection: 'decreasing' });
    expect(compareObjectiveSignatures(legacy, cooling)).toEqual({
      changed: true,
      directionOnly: true,
      rescueOnly: false,
    });
  });

  it('keeps a committed trajectory while the device direction is temporarily unknown', () => {
    const cooling = buildObjectiveSignature({ ...base, progressDirection: 'decreasing' });
    const unknown = buildObjectiveSignature({ ...base, progressDirection: 'unknown' });
    expect(compareObjectiveSignatures(cooling, unknown)).toEqual({
      changed: false,
      directionOnly: false,
      rescueOnly: false,
    });
  });

  it('recognizes a repeated flow-card configuration without assuming its live direction', () => {
    const cooling = buildObjectiveSignature({ ...base, progressDirection: 'decreasing' });
    const pendingSeed = buildObjectiveSignature({ ...base, progressDirection: 'unknown' });
    expect(compareObjectiveSignatures(cooling, pendingSeed).changed).toBe(false);
    expect(compareObjectiveSignatures(
      cooling,
      buildObjectiveSignature({ ...base, targetTemperatureC: 66, progressDirection: 'unknown' }),
    ).changed).toBe(true);
  });

  it('detects a pause-only grant as a rescue change vs no rescue', () => {
    const none = buildObjectiveSignature({ ...base });
    const pauseOnly = buildObjectiveSignature({ ...base, rescue: { pauseLowerPriorityDevices: 'always' } });
    expect(compareObjectiveSignatures(none, pauseOnly)).toEqual({
      changed: true,
      directionOnly: false,
      rescueOnly: true,
    });
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
