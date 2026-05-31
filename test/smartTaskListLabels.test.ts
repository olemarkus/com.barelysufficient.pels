import {
  deadlineLabels,
  formatConfidenceChipLabel,
  formatEnergyEstimateKWh,
  formatSmartTaskCurrentValueLine,
  formatSmartTaskHitRateFragment,
  formatSmartTaskListConfidenceChipLabel,
  resolveBuildingPlanChipTone,
  resolvePausedUnpluggedChipTone,
  resolveSmartTaskLearning,
  resolveSmartTaskListReadyByStatusWord,
  resolveSmartTaskListReadyByTone,
  SMART_TASK_HISTORY_EYEBROW,
  SMART_TASK_LIST_EMPTY_COPY,
  SMART_TASK_LIST_LOAD_ERROR_COPY,
  SMART_TASK_LIST_ROW_LABELS,
  SMART_TASK_LIST_STATUS_CHIP_VARIANT,
  SMART_TASK_LIST_STATUS_LABELS,
  SMART_TASK_WIDGET_STATUS_LABELS,
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

describe('smart-task list card copy constants', () => {
  // Pins the row-label record + empty-state and load-error sentences to the
  // canonical shared-domain source so runtime log breadcrumbs and the UI
  // can't drift (per `feedback_ui_text_shared_with_logs.md`).
  it('exports the three list-card row labels (Target / Starts / Ready by)', () => {
    expect(SMART_TASK_LIST_ROW_LABELS).toStrictEqual({
      target: 'Target',
      starts: 'Starts',
      readyBy: 'Ready by',
    });
  });

  it('exports the empty-state fragments that assemble into the canonical sentence', () => {
    expect(SMART_TASK_LIST_EMPTY_COPY).toStrictEqual({
      intro: 'No smart tasks yet. Open the Flow editor and add the',
      heatingAction: 'Add heating task',
      actionWord: 'action',
      // User-outcome phrasing — no internal Flow-card field name ("Ready by").
      heatingExample: '(heat a device to a target temperature by a time)',
      conjunction: 'or the',
      chargingAction: 'Add charging task',
      chargingExample: '(charge a device to a target percent by a time)',
      outro: 'to schedule a device for a specific ready-by time.',
      widgetLead: 'You can also add the',
      widgetName: 'New smart task',
      widgetOutro: 'widget to a dashboard and create one there.',
    });
  });

  it('keeps the example fragments free of the internal "Ready by" Flow-card field name', () => {
    // The earlier examples read "(Heat … to … °C by Ready by)" — the trailing
    // "Ready by" was the literal Flow input label, which leaked an internal
    // field name into user-outcome copy. Guard against the regression.
    expect(SMART_TASK_LIST_EMPTY_COPY.heatingExample).not.toContain('Ready by');
    expect(SMART_TASK_LIST_EMPTY_COPY.chargingExample).not.toContain('Ready by');
    // Temperature copy must never say "charge"; EV copy uses "percent".
    expect(SMART_TASK_LIST_EMPTY_COPY.heatingExample.toLowerCase()).not.toContain('charge');
    expect(SMART_TASK_LIST_EMPTY_COPY.chargingExample).toContain('percent');
  });

  it('exports the load-error sentence', () => {
    expect(SMART_TASK_LIST_LOAD_ERROR_COPY).toBe('Could not load smart tasks. Try again later.');
  });
});

describe('formatSmartTaskHitRateFragment', () => {
  // The 7-day strip's percent excludes abandoned runs from its denominator,
  // so the bare "67% hit rate" form didn't reconcile with the counts beside
  // it. The legible fragment names the denominator ("of M finished") so the
  // percent is self-explanatory. The helper only phrases the already-computed
  // numbers — it never re-derives the percent.
  it('names the finished-run denominator so the percent reconciles', () => {
    // 8 succeeded of 11 finished (8 + 3 missed); the 1 abandoned run is not
    // part of the denominator and so does not appear here.
    expect(formatSmartTaskHitRateFragment(73, 11)).toBe('73% of 11 finished');
  });

  it('handles the all-succeeded and all-missed edges', () => {
    expect(formatSmartTaskHitRateFragment(100, 3)).toBe('100% of 3 finished');
    expect(formatSmartTaskHitRateFragment(0, 2)).toBe('0% of 2 finished');
  });
});

describe('pending-state chip tone (Building plan… / Paused — unplugged)', () => {
  // The Smart-tasks list card (`DeadlinesList.tsx`) and the plan-detail
  // pending hero (`DeadlinePlan.tsx` via `pendingChipTone` in
  // `deadlinePlanPending.ts`) must render the pending pill in the same tone.
  // Both call into `resolveBuildingPlanChipTone` / `resolvePausedUnpluggedChipTone`;
  // the list does so transitively via `SMART_TASK_LIST_STATUS_CHIP_VARIANT`.
  // The settings-ui sibling test exercises the consumer wiring; this test
  // pins the producer contract.
  it('returns the same tone for the list variant map and the shared helper', () => {
    expect(SMART_TASK_LIST_STATUS_CHIP_VARIANT.building_plan)
      .toBe(resolveBuildingPlanChipTone());
    expect(SMART_TASK_LIST_STATUS_CHIP_VARIANT.paused_unplugged)
      .toBe(resolvePausedUnpluggedChipTone());
  });

  it('resolves Building plan… to the low-key informative tone, not the easy-to-miss muted tone', () => {
    expect(resolveBuildingPlanChipTone()).toBe('info');
  });

  it('resolves Paused — unplugged to the call-to-action warn tone', () => {
    expect(resolvePausedUnpluggedChipTone()).toBe('warn');
  });
});

describe('resolveSmartTaskListReadyByTone', () => {
  // The hero gradient and status chip both already paint `cannot_meet` red.
  // Letting the "Ready by" timestamp also go red stacks three red surfaces
  // on one card — alarming and redundant. The resolver demotes the timestamp
  // to `warn` so the chip stays the definitive status signal while the
  // timestamp drops one tone.
  it('demotes cannot_meet to warn so the timestamp does not echo the chip', () => {
    expect(resolveSmartTaskListReadyByTone('cannot_meet')).toBe('warn');
  });

  it('keeps at_risk and paused_unplugged on warn', () => {
    expect(resolveSmartTaskListReadyByTone('at_risk')).toBe('warn');
    expect(resolveSmartTaskListReadyByTone('paused_unplugged')).toBe('warn');
  });

  it('returns the neutral tone for healthy / pending / queued / satisfied states', () => {
    expect(resolveSmartTaskListReadyByTone('on_track')).toBe('neutral');
    expect(resolveSmartTaskListReadyByTone('building_plan')).toBe('neutral');
    expect(resolveSmartTaskListReadyByTone('queued')).toBe('neutral');
    expect(resolveSmartTaskListReadyByTone('satisfied')).toBe('neutral');
  });
});

describe('resolveSmartTaskListReadyByStatusWord', () => {
  // The Ready-by line previously signalled non-healthy states with colour only
  // (`--warn`/`--alert`). A red-green-deficient user can't read that off the
  // timestamp, so the non-healthy states gain an inline status word; healthy /
  // pending / queued / satisfied stay null (the line is neutral with nothing
  // wrong to flag, and the chip already names "On track").
  it('returns null for healthy / pending / queued / satisfied states', () => {
    expect(resolveSmartTaskListReadyByStatusWord('on_track')).toBeNull();
    expect(resolveSmartTaskListReadyByStatusWord('building_plan')).toBeNull();
    expect(resolveSmartTaskListReadyByStatusWord('queued')).toBeNull();
    expect(resolveSmartTaskListReadyByStatusWord('satisfied')).toBeNull();
  });

  // The inline word reuses canonical shared-domain labels so the word and the
  // status chip can never drift apart (per `feedback_ui_text_shared_with_logs`).
  it('reuses the canonical chip label for at_risk / cannot_meet', () => {
    expect(resolveSmartTaskListReadyByStatusWord('at_risk'))
      .toBe(SMART_TASK_LIST_STATUS_LABELS.at_risk);
    expect(resolveSmartTaskListReadyByStatusWord('cannot_meet'))
      .toBe(SMART_TASK_LIST_STATUS_LABELS.cannot_meet);
  });

  // Paused uses the compressed widget label ('Unplugged') rather than the full
  // chip label ('Paused — unplugged'): the inline word is joined with an
  // em-dash separator, and the full label's own em-dash would render a
  // confusing double-dash on the Ready-by line. Still a sanctioned label.
  it('uses the compressed widget label for paused to avoid a double em-dash', () => {
    expect(resolveSmartTaskListReadyByStatusWord('paused_unplugged'))
      .toBe(SMART_TASK_WIDGET_STATUS_LABELS.paused_unplugged);
    expect(resolveSmartTaskListReadyByStatusWord('paused_unplugged'))
      .not.toContain('—');
  });
});

describe('at_risk vs cannot_meet chip labels', () => {
  // Pins the chip-text split: an `at_risk` plan must read "At risk" (recoverable
  // shortfall — amber rim), while a `cannot_meet` plan reads "Cannot finish"
  // (physical impossibility — red rim). Folding them back together at any
  // surface would erase the recoverability signal even though the hero rim and
  // chip tone already say something is different. Both labels live in
  // shared-domain (per `feedback_ui_text_shared_with_logs.md`) so runtime
  // breadcrumbs and the UI render identical text.
  it('exposes distinct strings for at_risk and cannot_meet on every kind', () => {
    const tempLabels = deadlineLabels('temperature');
    const evLabels = deadlineLabels('ev_soc');
    expect(tempLabels.atRiskChipLabel).toBe('At risk');
    expect(tempLabels.cannotMeetChipLabel).toBe('Cannot finish');
    expect(evLabels.atRiskChipLabel).toBe('At risk');
    expect(evLabels.cannotMeetChipLabel).toBe('Cannot finish');
    expect(tempLabels.atRiskChipLabel).not.toBe(tempLabels.cannotMeetChipLabel);
    expect(evLabels.atRiskChipLabel).not.toBe(evLabels.cannotMeetChipLabel);
  });

  it('mirrors the smart-task list status labels so detail and list never drift', () => {
    expect(deadlineLabels('temperature').atRiskChipLabel)
      .toBe(SMART_TASK_LIST_STATUS_LABELS.at_risk);
    expect(deadlineLabels('ev_soc').atRiskChipLabel)
      .toBe(SMART_TASK_LIST_STATUS_LABELS.at_risk);
  });
});
