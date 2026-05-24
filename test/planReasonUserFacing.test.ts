import {
  PLAN_REASON_CODES,
  formatDeviceReasonUserFacing,
  formatShortfallReason,
  resolvePlanGenericReasonText,
  type DeviceReason,
} from '../packages/shared-domain/src/planReasonSemantics';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
  PLAN_STATE_HOURLY_BUDGET_STATUS,
} from '../packages/shared-domain/src/planStateLabels';

const BANNED = /\b(shed|restore|headroom|shortfall|backoff|invariant|soft limit|controlled|uncontrolled)\b/i;

describe('formatShortfallReason', () => {
  it('renders the user-facing label when need/headroom are present', () => {
    expect(formatShortfallReason({ needKw: 1.2, headroomKw: 0.15 }))
      .toBe('Manual action needed — needs 1.2 kW, 0.1 kW available');
  });

  it('clamps negative headroom to 0 kW available so users do not see minus signs', () => {
    expect(formatShortfallReason({ needKw: 1.2, headroomKw: -0.5 }))
      .toBe('Manual action needed — needs 1.2 kW, 0.0 kW available');
  });

  it('falls back to the bare label when need or headroom are unknown', () => {
    expect(formatShortfallReason({ needKw: null, headroomKw: null }))
      .toBe('Manual action needed — hard cap may be exceeded');
    expect(formatShortfallReason({ needKw: 1.2, headroomKw: null }))
      .toBe('Manual action needed — hard cap may be exceeded');
    expect(formatShortfallReason({ needKw: null, headroomKw: 0.15 }))
      .toBe('Manual action needed — hard cap may be exceeded');
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
      expected: 'Manual action needed — needs 1.2 kW, 0.1 kW available',
    },
    {
      label: 'shortfall reason without numbers maps to the bare label',
      reason: { code: PLAN_REASON_CODES.shortfall, needKw: null, headroomKw: null },
      expected: 'Manual action needed — hard cap may be exceeded',
    },
    {
      label: 'capacity shed maps to the hard-cap label',
      reason: { code: PLAN_REASON_CODES.capacity, detail: null },
      expected: PLAN_STATE_HELD_FALLBACK_STATUS,
    },
    {
      label: 'daily budget shed maps to the today\'s daily-budget label',
      reason: { code: PLAN_REASON_CODES.dailyBudget, detail: null },
      expected: PLAN_STATE_DAILY_BUDGET_STATUS,
    },
    {
      label: 'hourly budget shed maps to the hourly hard cap label',
      reason: { code: PLAN_REASON_CODES.hourlyBudget, detail: null },
      expected: PLAN_STATE_HOURLY_BUDGET_STATUS,
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
      label: 'headroom cooldown maps to the power-reading-stabilise label',
      reason: {
        code: PLAN_REASON_CODES.headroomCooldown,
        kind: 'recent_pels_shed',
        remainingSec: 30,
        fromKw: null,
        toKw: null,
      },
      expected: 'Waiting for power reading to stabilise',
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
      label: 'shed invariant maps to the safety-rule label',
      reason: {
        code: PLAN_REASON_CODES.shedInvariant,
        fromStep: 'low',
        toStep: 'off',
        shedDeviceCount: 1,
        maxStep: 'mid',
      },
      expected: 'Blocked by safety rule',
    },
    {
      label: 'insufficient headroom for restore maps to the not-enough-power label',
      reason: {
        code: PLAN_REASON_CODES.insufficientHeadroom,
        needKw: 2,
        availableKw: 1,
        postReserveMarginKw: null,
        minimumRequiredPostReserveMarginKw: null,
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
        swapTargetName: null,
      },
      expected: 'Not enough available power to resume — needs 2.0 kW, 1.0 kW available',
    },
    {
      label: 'insufficient headroom for swap names the target',
      reason: {
        code: PLAN_REASON_CODES.insufficientHeadroom,
        needKw: 2,
        availableKw: 1,
        postReserveMarginKw: null,
        minimumRequiredPostReserveMarginKw: null,
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
        swapTargetName: 'Water Heater',
      },
      expected: 'Not enough available power to make room for Water Heater — needs 2.0 kW, 1.0 kW available',
    },
    {
      label: 'startup stabilization maps to the waiting-after-startup label',
      reason: { code: PLAN_REASON_CODES.startupStabilization },
      expected: 'Waiting after startup',
    },
    {
      label: 'none reason yields an empty status string',
      reason: { code: PLAN_REASON_CODES.none },
      expected: '',
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
      label: 'shedding active maps to the currently-limiting label',
      reason: { code: PLAN_REASON_CODES.sheddingActive, detail: null },
      expected: 'Currently limiting devices',
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
    {
      label: 'set target names the new target',
      reason: { code: PLAN_REASON_CODES.setTarget, targetText: '21 °C' },
      expected: 'Changing target to 21 °C',
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

describe('resolvePlanGenericReasonText', () => {
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
      ? `Still reporting ${measured} kW after pause — ${detail}`
      : `Still reporting ${measured} kW after pause`;
  };

  it('renders the plain "Still reporting … kW after pause" sentence without a detail', () => {
    expect(resolvePlanGenericReasonText({ measuredPowerKw: 1.234, detail: null }))
      .toBe('Still reporting 1.2 kW after pause');
  });

  it('appends the trimmed detail with an em-dash separator when present', () => {
    expect(resolvePlanGenericReasonText({ measuredPowerKw: 7.2, detail: '  EV charger ignored pause  ' }))
      .toBe('Still reporting 7.2 kW after pause — EV charger ignored pause');
  });

  it('falls back to "–" when measuredPowerKw is missing or non-finite', () => {
    expect(resolvePlanGenericReasonText({ measuredPowerKw: undefined, detail: null }))
      .toBe('Still reporting – kW after pause');
    expect(resolvePlanGenericReasonText({ measuredPowerKw: Number.NaN, detail: null }))
      .toBe('Still reporting – kW after pause');
  });

  it('drops non-string and empty detail values silently', () => {
    expect(resolvePlanGenericReasonText({ measuredPowerKw: 2, detail: undefined }))
      .toBe('Still reporting 2.0 kW after pause');
    expect(resolvePlanGenericReasonText({ measuredPowerKw: 2, detail: '   ' }))
      .toBe('Still reporting 2.0 kW after pause');
    expect(resolvePlanGenericReasonText({ measuredPowerKw: 2, detail: 42 }))
      .toBe('Still reporting 2.0 kW after pause');
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
      expect(resolvePlanGenericReasonText(c)).toBe(referenceFormat(c.measuredPowerKw, c.detail));
    }
  });
});
