import {
  formatConfidenceChipLabel,
  formatSmartTaskCurrentValueLine,
  SMART_TASK_HISTORY_EYEBROW,
  SMART_TASK_PAST_EMPTY_COPY,
} from '../packages/shared-domain/src/deadlineLabels';
import {
  formatPlanHistoryDeadlineLine,
  formatSmartTaskListDateTime,
} from '../packages/shared-domain/src/deferredPlanHistory';

describe('formatConfidenceChipLabel', () => {
  it('returns "Confidence low" / "Confidence medium" / "Confidence high" to match the live hero', () => {
    expect(formatConfidenceChipLabel('low')).toBe('Confidence low');
    expect(formatConfidenceChipLabel('medium')).toBe('Confidence medium');
    expect(formatConfidenceChipLabel('high')).toBe('Confidence high');
  });

  it('returns null when the band is missing so the chip is suppressed', () => {
    expect(formatConfidenceChipLabel(null)).toBeNull();
    expect(formatConfidenceChipLabel(undefined)).toBeNull();
  });
});

describe('formatSmartTaskCurrentValueLine', () => {
  it('formats temperature with one decimal place', () => {
    expect(formatSmartTaskCurrentValueLine({ kind: 'temperature', currentValue: 18 })).toBe('currently 18.0 °C');
    expect(formatSmartTaskCurrentValueLine({ kind: 'temperature', currentValue: 18.46 })).toBe('currently 18.5 °C');
  });

  it('formats EV state-of-charge as a rounded percent', () => {
    expect(formatSmartTaskCurrentValueLine({ kind: 'ev_soc', currentValue: 45 })).toBe('currently 45 %');
    expect(formatSmartTaskCurrentValueLine({ kind: 'ev_soc', currentValue: 45.7 })).toBe('currently 46 %');
  });

  it('returns null when the current value is unknown', () => {
    expect(formatSmartTaskCurrentValueLine({ kind: 'temperature', currentValue: null })).toBeNull();
    expect(formatSmartTaskCurrentValueLine({ kind: 'ev_soc', currentValue: null })).toBeNull();
  });
});

describe('formatSmartTaskListDateTime', () => {
  // Pin to a deterministic instant: Sat 16 May 2026 06:50 UTC.
  const SAT_16_MAY_06_50_UTC = Date.UTC(2026, 4, 16, 6, 50);

  it('renders date + 24h time with a single space and no comma', () => {
    expect(formatSmartTaskListDateTime(SAT_16_MAY_06_50_UTC, 'UTC')).toBe('Sat 16 May 06:50');
  });

  it('returns a stable fallback for invalid timestamps', () => {
    expect(formatSmartTaskListDateTime(Number.NaN, 'UTC')).toBe('unknown time');
  });

  it('produces the same shape as the past-tasks deadline line so the two surfaces stay aligned', () => {
    // The past-list helper now delegates to `formatSmartTaskListDateTime`;
    // assert the wrapper preserves the canonical shape so a future regression
    // can't reintroduce the comma drift.
    expect(formatPlanHistoryDeadlineLine({ deadlineAtMs: SAT_16_MAY_06_50_UTC }, 'UTC'))
      .toBe(formatSmartTaskListDateTime(SAT_16_MAY_06_50_UTC, 'UTC'));
  });
});

describe('smart-task history copy constants', () => {
  it('exports a Smart task eyebrow that does not leak the planner-noun', () => {
    expect(SMART_TASK_HISTORY_EYEBROW).toBe('Smart task');
    expect(SMART_TASK_HISTORY_EYEBROW.toLowerCase()).not.toContain('plan');
  });

  it('exports a past-tasks empty-state explanation', () => {
    expect(SMART_TASK_PAST_EMPTY_COPY).toBe(
      "No completed tasks yet — they'll appear here after a smart task finishes.",
    );
  });
});
