import {
  PLAN_REASON_CODES,
  formatDeviceReasonUserFacing,
  formatShortfallReason,
  readDeviceReasonDetail,
  resolveReportedLoadAfterPauseText,
  resolveSurplusHoldReportedLoadText,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_CAPACITY_STATUS,
  PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS,
} from '../../packages/shared-domain/src/planStateLabels';

const BANNED = /\b(shed|restore|headroom|shortfall|backoff|invariant|soft limit|controlled|uncontrolled)\b/i;

describe('formatShortfallReason', () => {
  it('renders the user-facing label when need/headroom are present', () => {
    expect(formatShortfallReason({ needKw: 1.2, headroomKw: 0.15 }))
      .toBe('Manual action needed. Needs 1.2 kW, 0.1 kW available.');
  });

  it('clamps negative headroom to 0 kW available so users do not see minus signs', () => {
    expect(formatShortfallReason({ needKw: 1.2, headroomKw: -0.5 }))
      .toBe('Manual action needed. Needs 1.2 kW, 0.0 kW available.');
  });

  it('falls back to the bare label when need or headroom are unknown', () => {
    expect(formatShortfallReason({ needKw: null, headroomKw: null }))
      .toBe('Manual action needed. Hard cap may be exceeded.');
    expect(formatShortfallReason({ needKw: 1.2, headroomKw: null }))
      .toBe('Manual action needed. Hard cap may be exceeded.');
    expect(formatShortfallReason({ needKw: null, headroomKw: 0.15 }))
      .toBe('Manual action needed. Hard cap may be exceeded.');
  });

  it('never leaks the internal "shortfall" or "headroom" terms', () => {
    const labels = [
      formatShortfallReason({ needKw: 1.2, headroomKw: 0.15 }),
      formatShortfallReason({ needKw: null, headroomKw: null }),
      formatShortfallReason({ needKw: 1.2, headroomKw: -0.5 }),
    ];
    for (const label of labels) {
      expect(label).not.toMatch(BANNED);
    }
  });
});

describe('formatDeviceReasonUserFacing — terminology guide alignment', () => {
  const cases: ReadonlyArray<{ label: string; reason: DeviceReason; expected: string }> = [
    {
      label: 'shortfall reason maps to the manual action label',
      reason: { code: PLAN_REASON_CODES.shortfall, needKw: 1.2, headroomKw: 0.15 },
      expected: 'Manual action needed. Needs 1.2 kW, 0.1 kW available.',
    },
    {
      label: 'shortfall reason without numbers maps to the bare label',
      reason: { code: PLAN_REASON_CODES.shortfall, needKw: null, headroomKw: null },
      expected: 'Manual action needed. Hard cap may be exceeded.',
    },
    {
      label: 'capacity shed maps to the hard-cap label',
      reason: { code: PLAN_REASON_CODES.capacity, detail: null },
      expected: PLAN_STATE_CAPACITY_STATUS,
    },
    {
      label: 'daily budget shed maps to the today\'s daily-budget label',
      reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null },
      expected: PLAN_STATE_DAILY_BUDGET_STATUS,
    },
    {
      label: 'hourly budget shed maps to the next-hour budget line',
      reason: { code: PLAN_REASON_CODES.hourlyBudget, detail: null },
      expected: PLAN_STATE_HOURLY_BUDGET_EXHAUSTED_STATUS,
    },
    {
      label: 'deferred objective avoid maps to the waiting-for-cheaper-hours label',
      reason: { code: PLAN_REASON_CODES.deferredObjectiveAvoid, detail: null },
      expected: PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
    },
    {
      label: 'cooldown restore maps to the waiting-to-resume label',
      reason: { code: PLAN_REASON_CODES.cooldownRestore, remainingSec: 30 },
      expected: 'Waiting before resuming (30s)',
    },
    {
      label: 'cooldown shedding maps to the waiting-after-limiting label',
      reason: { code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 30 },
      expected: 'Waiting after limiting device (30s)',
    },
    {
      label: 'meter settling maps to the meter-stabilise label',
      reason: { code: PLAN_REASON_CODES.meterSettling, remainingSec: 10 },
      expected: 'Waiting for power meter to stabilise (10s)',
    },
    {
      label: 'activation backoff maps to the delaying-restart label',
      reason: { code: PLAN_REASON_CODES.activationBackoff, remainingSec: 60 },
      expected: 'Delaying restart after recent failed attempt (60s)',
    },
    {
      label: 'restore pending maps to the resume-pending label',
      reason: { code: PLAN_REASON_CODES.restorePending, remainingSec: 5 },
      expected: 'Resume pending (5s)',
    },
    {
      label: 'restore throttled maps to the delaying-restart label',
      reason: { code: PLAN_REASON_CODES.restoreThrottled },
      expected: 'Delaying restart to avoid rapid cycling',
    },
    {
      label: 'swap pending names the target',
      reason: { code: PLAN_REASON_CODES.swapPending, targetName: 'Water Heater' },
      expected: 'Making room for higher-priority device (Water Heater)',
    },
    {
      label: 'swapped out names the target',
      reason: { code: PLAN_REASON_CODES.swappedOut, targetName: 'EV Charger' },
      expected: 'Limited so EV Charger can run',
    },
    {
      label: 'capacity control off maps to the power-limit label',
      reason: { code: PLAN_REASON_CODES.capacityControlOff },
      expected: 'Power-limit control off',
    },
    {
      // The stepped fairness rule names where the device IS and what would lift
      // the hold. It read "Blocked by safety rule" until 2026-08-02: jargon, not
      // a safety rule, and "blocked" overstates a rule that only refuses
      // increases.
      label: 'shed invariant names the device step, not the invariant cap',
      reason: {
        code: PLAN_REASON_CODES.shedInvariant,
        fromStep: 'low',
        toStep: 'high',
        shedDeviceCount: 1,
        // `maxStep` is the invariant's cap, NOT where the device is — prod
        // 2026-07-05 rendered it and claimed "Limited to Low" for a device
        // running at Medium. It must not appear in the sentence.
        maxStep: 'mid',
      },
      expected: 'Holding at Low — cannot increase while 1 device is limited',
    },
    {
      label: 'shed invariant pluralises the device count and formats ampere steps',
      reason: {
        code: PLAN_REASON_CODES.shedInvariant,
        fromStep: '6a',
        toStep: '16a',
        shedDeviceCount: 2,
        maxStep: '6a',
      },
      expected: 'Holding at 6 A — cannot increase while 2 devices are limited',
    },
    {
      label: 'shed invariant drops the step clause when the observed step is unknown',
      reason: {
        code: PLAN_REASON_CODES.shedInvariant,
        fromStep: 'unknown',
        toStep: '16a',
        shedDeviceCount: 3,
        maxStep: '6a',
      },
      expected: 'Holding — cannot increase while 3 devices are limited',
    },
    {
      // Production-shaped reason: the shortfall is admission-accurate,
      // `minimumRequired − postReserveMargin` (0.25 − (−0.75) = 1.0), NOT the
      // understated `need − available` (2.0 − 1.5 = 0.5). Prod 2026-08-01.
      label: 'insufficient headroom renders the admission-accurate shortfall when margins are present',
      reason: {
        code: PLAN_REASON_CODES.insufficientHeadroom,
        needKw: 2,
        availableKw: 1.5,
        postReserveMarginKw: -0.75,
        minimumRequiredPostReserveMarginKw: 0.25,
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
        swapTargetName: null,
      },
      expected: 'Not enough available power to resume — 1.0 kW more needed',
    },
    {
      label: 'insufficient headroom for swap names the target',
      reason: {
        code: PLAN_REASON_CODES.insufficientHeadroom,
        needKw: 2,
        availableKw: 1,
        postReserveMarginKw: -0.75,
        minimumRequiredPostReserveMarginKw: 0.25,
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
        swapTargetName: 'Water Heater',
      },
      expected: 'Not enough available power to make room for Water Heater — 1.0 kW more needed',
    },
    {
      label: 'startup stabilization maps to the waiting-after-startup label',
      reason: { code: PLAN_REASON_CODES.startupStabilization },
      expected: 'Waiting after startup',
    },
    {
      label: 'keep reason without detail yields an empty status string',
      reason: { code: PLAN_REASON_CODES.keep, detail: null },
      expected: '',
    },
    {
      label: 'keep reason with detail capitalises the detail',
      reason: { code: PLAN_REASON_CODES.keep, detail: 'recently restored' },
      expected: 'Recently restored',
    },
    {
      label: 'inactive reason adds the detail in parentheses',
      reason: { code: PLAN_REASON_CODES.inactive, detail: 'charger is unplugged' },
      expected: 'Off for now (charger is unplugged)',
    },
    {
      label: 'restore need without targets falls back to waiting copy with kW details',
      reason: {
        code: PLAN_REASON_CODES.restoreNeed,
        fromTarget: null,
        toTarget: null,
        needKw: 1.2,
        headroomKw: 0.3,
      },
      expected: 'Waiting to resume — needs 1.2 kW, 0.3 kW available',
    },
    {
      label: 'restore need with targets describes the transition',
      reason: {
        code: PLAN_REASON_CODES.restoreNeed,
        fromTarget: 'low',
        toTarget: 'high',
        needKw: 1.2,
        headroomKw: 0.3,
      },
      expected: 'Raising target low to high',
    },
    {
      label: 'waiting for other devices maps to the settle label',
      reason: { code: PLAN_REASON_CODES.waitingForOtherDevices },
      expected: 'Waiting for other devices to settle',
    },
    {
      label: 'neutral startup hold maps to the left-off label',
      reason: { code: PLAN_REASON_CODES.neutralStartupHold },
      expected: 'Left off after startup',
    },
  ];

  it.each(cases)('$label', ({ reason, expected }) => {
    expect(formatDeviceReasonUserFacing(reason)).toBe(expected);
  });

  it('never emits banned planner jargon for any reason code', () => {
    for (const { reason } of cases) {
      const text = formatDeviceReasonUserFacing(reason);
      expect(text).not.toMatch(BANNED);
    }
  });
});

describe('resolveReportedLoadAfterPauseText', () => {
  // Mirrors the pre-extraction inline formatter in
  // packages/settings-ui/src/ui/views/PlanDeviceCards.tsx so the test
  // anchors the helper's output to the wording the Overview generic card
  // shipped before the move into shared-domain.
  const referenceFormat = (measuredPowerKw: number | undefined, detailRaw: unknown): string => {
    const measured = typeof measuredPowerKw === 'number' && Number.isFinite(measuredPowerKw)
      ? measuredPowerKw.toFixed(1)
      : '–';
    const detail = typeof detailRaw === 'string' && detailRaw.trim().length > 0
      ? detailRaw.trim()
      : null;
    return detail
      ? `Still drawing ${measured} kW — ${detail}`
      : `Still drawing ${measured} kW — this still counts toward your usage`;
  };

  it('renders the plain "Still drawing … kW" sentence with the usage-consequence tail', () => {
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: 1.234, detail: null }))
      .toBe('Still drawing 1.2 kW — this still counts toward your usage');
  });

  it('appends the trimmed detail with an em-dash separator when present', () => {
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: 7.2, detail: '  EV charger ignored pause  ' }))
      .toBe('Still drawing 7.2 kW — EV charger ignored pause');
  });

  it('drops the phantom "after pause" framing in simulation mode (dryRun)', () => {
    // Simulation never actually paused the device, so the real-mode "after
    // pause" wording would assert an action that did not happen.
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: 2.1, detail: null, dryRun: true }))
      .toBe('Would still draw 2.1 kW — this still counts toward your usage (simulation)');
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: 2.1, detail: 'high household load', dryRun: true }))
      .toBe('Would still draw 2.1 kW — high household load (simulation)');
  });

  it('falls back to "–" when measuredPowerKw is missing or non-finite', () => {
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: undefined, detail: null }))
      .toBe('Still drawing – kW — this still counts toward your usage');
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: Number.NaN, detail: null }))
      .toBe('Still drawing – kW — this still counts toward your usage');
  });

  it('drops non-string and empty detail values silently', () => {
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: 2, detail: undefined }))
      .toBe('Still drawing 2.0 kW — this still counts toward your usage');
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: 2, detail: '   ' }))
      .toBe('Still drawing 2.0 kW — this still counts toward your usage');
    expect(resolveReportedLoadAfterPauseText({ measuredPowerKw: 2, detail: 42 }))
      .toBe('Still drawing 2.0 kW — this still counts toward your usage');
  });

  it('matches the pre-extraction inline formatter character-for-character', () => {
    const cases: ReadonlyArray<{ measuredPowerKw: number | undefined; detail: unknown }> = [
      { measuredPowerKw: 1.234, detail: null },
      { measuredPowerKw: 7.2, detail: '  EV charger ignored pause  ' },
      { measuredPowerKw: 0.06, detail: 'still drawing' },
      { measuredPowerKw: undefined, detail: 'unknown source' },
      { measuredPowerKw: Number.NaN, detail: null },
      { measuredPowerKw: 2, detail: '   ' },
    ];
    for (const c of cases) {
      expect(resolveReportedLoadAfterPauseText(c)).toBe(referenceFormat(c.measuredPowerKw, c.detail));
    }
  });
});

describe('resolveSurplusHoldReportedLoadText', () => {
  // Surplus-held dump load the user switched on by hand: names the reconcile,
  // NOT "after pause" (a baseline-off device was never paused).
  it('names the surplus reconcile with the measured draw', () => {
    expect(resolveSurplusHoldReportedLoadText({ measuredPowerKw: 1.0 }))
      .toBe('Still reporting 1.0 kW — switching off to wait for solar surplus');
  });

  it('never uses the "after pause" phrasing', () => {
    expect(resolveSurplusHoldReportedLoadText({ measuredPowerKw: 2.4 })).not.toContain('after pause');
  });

  it('falls back to "–" when the measured draw is missing or non-finite', () => {
    expect(resolveSurplusHoldReportedLoadText({ measuredPowerKw: undefined }))
      .toBe('Still reporting – kW — switching off to wait for solar surplus');
    expect(resolveSurplusHoldReportedLoadText({ measuredPowerKw: Number.NaN }))
      .toBe('Still reporting – kW — switching off to wait for solar surplus');
  });
});

describe('readDeviceReasonDetail', () => {
  // The cast at the PlanDeviceCards.tsx call site is now a published contract
  // between settings-ui and the shared-domain helper. This helper centralises
  // the narrowing so non-object values, nullish values, and objects without
  // `detail` all return `undefined` without an `as` cast leaking into callers.
  it('returns undefined for non-object inputs', () => {
    expect(readDeviceReasonDetail(undefined)).toBeUndefined();
    expect(readDeviceReasonDetail(null)).toBeUndefined();
    expect(readDeviceReasonDetail('string')).toBeUndefined();
    expect(readDeviceReasonDetail(42)).toBeUndefined();
    expect(readDeviceReasonDetail(true)).toBeUndefined();
  });

  it('returns undefined for objects without a `detail` property', () => {
    expect(readDeviceReasonDetail({ code: 'none' })).toBeUndefined();
    expect(readDeviceReasonDetail({})).toBeUndefined();
  });

  it('returns the raw `detail` value when present, including null and non-string', () => {
    expect(readDeviceReasonDetail({ code: 'keep', detail: 'recently restored' }))
      .toBe('recently restored');
    expect(readDeviceReasonDetail({ code: 'keep', detail: null })).toBeNull();
    // Non-string `detail` values are returned as-is; downstream consumers
    // (e.g. `resolveReportedLoadAfterPauseText`) decide whether to render them.
    expect(readDeviceReasonDetail({ code: 'other', detail: 42 })).toBe(42);
  });

  it('narrows a DeviceReason from the snapshot boundary without an `as` cast', () => {
    const reason: DeviceReason = { code: PLAN_REASON_CODES.capacity, detail: 'over budget' };
    // Treat `reason` as `unknown` to match the snapshot-boundary call site.
    expect(readDeviceReasonDetail(reason as unknown)).toBe('over budget');
  });
});
