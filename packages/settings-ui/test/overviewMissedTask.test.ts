import { describe, expect, it } from 'vitest';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory.ts';
import { partialDouble } from '../../../test/helpers/partialDouble.ts';
import { resolveOverviewMissedTask } from '../src/ui/overviewMissedTask.ts';

const deadlineAtMs = Date.parse('2026-11-25T06:00:00Z');
const oneHourMs = 60 * 60 * 1000;
const entry = partialDouble<ResolvedDeferredObjectivePlanHistoryEntry>({
  id: 'miss-1',
  deviceId: 'charger',
  deviceName: 'Car',
  outcome: 'missed',
  objectiveKind: 'ev_soc',
  deadlineAtMs,
  startedAtMs: deadlineAtMs - 2 * oneHourMs,
  finalProgressValue: 54,
  targetValue: 80,
  deliveryExplanation: {
    kind: 'recorded',
    primary: { kind: 'blocked', cause: 'device_schedule' },
    contributors: ['capacity_limited'],
    intervals: [{ cause: 'capacity_limited', fromMs: deadlineAtMs - oneHourMs, toMs: deadlineAtMs }],
  },
});

describe('Overview missed task', () => {
  it('shows the archived blockers in past tense with a direct link to the run', () => {
    const notice = resolveOverviewMissedTask([entry], deadlineAtMs + oneHourMs);
    expect(notice).toMatchObject({
      result: 'Last recorded 54 % · Target 80 %',
      reason: 'The car delayed charging on its own schedule or smart charging.',
      href: './?page=deadline-plan&deviceId=charger&historyId=miss-1',
      checks: [
        { label: 'Target reached by the deadline', state: 'not_met', detail: 'The car delayed charging on its own schedule or smart charging.' },
        { label: 'Earlier delivery', state: 'held_back', detail: 'Not enough available power held delivery back.' },
      ],
    });
  });

  it('distinguishes unrecorded history from a run without a verified reason', () => {
    const now = deadlineAtMs + oneHourMs;
    expect(resolveOverviewMissedTask([{ ...entry, deliveryExplanation: { kind: 'legacy_unrecorded' } }], now))
      .toMatchObject({ checks: [{ state: 'not_recorded' }] });
    expect(resolveOverviewMissedTask([{
      ...entry, finalProgressValue: null,
      deliveryExplanation: { kind: 'recorded', primary: { kind: 'clear' }, contributors: [], intervals: [] },
    }], now)).toMatchObject({ result: null, checks: [{ state: 'unverified' }] });
  });

  it('skips a late-finalized older miss when a recent miss follows it', () => {
    const old = {
      ...entry, id: 'old-miss', startedAtMs: entry.startedAtMs - 24 * oneHourMs,
      deadlineAtMs: deadlineAtMs - 24 * oneHourMs,
    };
    expect(resolveOverviewMissedTask([old, entry], deadlineAtMs + oneHourMs)?.href)
      .toContain('historyId=miss-1');
  });

  it('clears the notice after a newer run for the same device ends', () => {
    const succeeded = {
      ...entry, id: 'new-run', outcome: 'met' as const, startedAtMs: deadlineAtMs,
    };
    expect(resolveOverviewMissedTask([succeeded, entry], deadlineAtMs + oneHourMs)).toBeNull();
  });

  it('drops the notice at 24 hours and ignores tasks with a different outcome', () => {
    expect(resolveOverviewMissedTask([entry], deadlineAtMs + 24 * oneHourMs)).toBeNull();
    expect(resolveOverviewMissedTask([{ ...entry, outcome: 'device_idle' }], deadlineAtMs + oneHourMs)).toBeNull();
  });
});
