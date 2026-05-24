import {
  formatConfidenceChipLabel,
  formatEnergyEstimateKWh,
  formatSmartTaskCurrentValueLine,
  formatSmartTaskListConfidenceChipLabel,
  resolveSmartTaskLearning,
  SMART_TASK_HISTORY_EYEBROW,
  SMART_TASK_PAST_EMPTY_COPY,
} from '../packages/shared-domain/src/deadlineLabels';
import {
  formatPlanHistoryDeadlineLine,
  formatSmartTaskListDateTime,
} from '../packages/shared-domain/src/deferredPlanHistory';

describe('formatConfidenceChipLabel', () => {
  it('returns action-oriented low / medium chip copy to match the live hero', () => {
    expect(formatConfidenceChipLabel('low')).toBe('Estimating');
    expect(formatConfidenceChipLabel('medium')).toBe('Refining');
  });

  it('returns null when the band is high or missing so the chip is suppressed', () => {
    expect(formatConfidenceChipLabel('high')).toBeNull();
    expect(formatConfidenceChipLabel(null)).toBeNull();
    expect(formatConfidenceChipLabel(undefined)).toBeNull();
  });
});

describe('formatSmartTaskListConfidenceChipLabel', () => {
  it('suppresses confidence chips on cannot-finish cards', () => {
    expect(formatSmartTaskListConfidenceChipLabel({
      confidence: 'low',
      statusId: 'cannot_meet',
      learning: true,
    })).toBeNull();
  });

  it('keeps action-oriented confidence chips for recoverable list states while learning', () => {
    expect(formatSmartTaskListConfidenceChipLabel({
      confidence: 'medium',
      statusId: 'at_risk',
      learning: true,
    })).toBe('Refining');
  });

  it('stays silent on on_track even while learning', () => {
    expect(formatSmartTaskListConfidenceChipLabel({
      confidence: 'low',
      statusId: 'on_track',
      learning: true,
    })).toBeNull();
  });

  it('suppresses the chip for a learned (not cold-start) rate so a forever-low thermal band cannot nag', () => {
    expect(formatSmartTaskListConfidenceChipLabel({
      confidence: 'low',
      statusId: 'at_risk',
      learning: false,
    })).toBeNull();
  });
});

describe('resolveSmartTaskLearning', () => {
  const provenance = (overrides: Record<string, unknown> = {}) => ({
    source: 'learned' as const,
    kWhPerUnit: 0.4,
    acceptedSamples: 20,
    confidence: 'low' as const,
    lastAcceptedAtMs: 0,
    ...overrides,
  });

  it('is true for bootstrap-sourced rates', () => {
    expect(resolveSmartTaskLearning(provenance({ source: 'bootstrap', kWhPerUnit: null, acceptedSamples: 0 }))).toBe(true);
  });

  it('is true below the learned-sample floor and false at or above it', () => {
    expect(resolveSmartTaskLearning(provenance({ acceptedSamples: 3 }))).toBe(true);
    expect(resolveSmartTaskLearning(provenance({ acceptedSamples: 4 }))).toBe(false);
    expect(resolveSmartTaskLearning(provenance({ acceptedSamples: 200 }))).toBe(false);
  });

  it('is false when there is no provenance (legacy plan)', () => {
    expect(resolveSmartTaskLearning(undefined)).toBe(false);
  });
});

describe('formatEnergyEstimateKWh', () => {
  it('renders a range when planned exceeds expected', () => {
    expect(formatEnergyEstimateKWh({ energyPlannedKWh: 10, energyExpectedKWh: 8 })).toBe('8.0–10.0 kWh');
  });

  it('collapses to a single figure when the rounded endpoints match or no buffer', () => {
    expect(formatEnergyEstimateKWh({ energyPlannedKWh: 8.02, energyExpectedKWh: 8.01 })).toBe('8.0 kWh');
    expect(formatEnergyEstimateKWh({ energyPlannedKWh: 8, energyExpectedKWh: 8 })).toBe('8.0 kWh');
    expect(formatEnergyEstimateKWh({ energyPlannedKWh: 8 })).toBe('8.0 kWh');
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
