import { describe, expect, it } from 'vitest';
import { normalizeDeferredObjectiveRoster } from '../src/ui/deferredObjectiveRoster.ts';

const DEADLINE_MS = Date.UTC(2026, 0, 1, 7, 30, 0);
const evEntry = {
  enabled: true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80, deadlineAtMs: DEADLINE_MS,
} as const;

describe('normalizeDeferredObjectiveRoster', () => {
  it('reads a malformed payload as no tasks', () => {
    for (const raw of [undefined, null, 'tasks', [], {}, { objectivesByDeviceId: 'ev-1' }]) {
      expect(normalizeDeferredObjectiveRoster(raw)).toEqual({ objectivesByDeviceId: {} });
    }
  });

  it('keeps valid entries under trimmed ids and drops malformed ones', () => {
    expect(normalizeDeferredObjectiveRoster({
      objectivesByDeviceId: {
        ' ev-1 ': evEntry,
        bad: { ...evEntry, targetPercent: 120 },
        '  ': evEntry,
      },
    })).toEqual({ objectivesByDeviceId: { 'ev-1': evEntry } });
  });
});
