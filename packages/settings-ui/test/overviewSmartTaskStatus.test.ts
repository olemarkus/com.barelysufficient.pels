import { describe, expect, it } from 'vitest';
import type {
  OverviewDeferredObjectiveActivePlan,
  OverviewDeferredObjectiveActivePlans,
} from '../../contracts/src/deferredObjectiveActivePlans.ts';
import type { DeferredObjectiveRoster } from '../../contracts/src/deferredObjectiveSettings.ts';
import type { SettingsUiPricesPayload } from '../../contracts/src/settingsUi/prices.ts';
import { deadlineLabels } from '../../shared-domain/src/smartTaskCopy/deadlineLabels.ts';
import { resolveOverviewSmartTaskStatuses } from '../src/ui/overviewSmartTaskStatus.ts';
import { partialDouble } from '../../../test/helpers/partialDouble.ts';

const nowMs = Date.parse('2026-11-17T12:00:00Z');
const deadlineAtMs = nowMs + 6 * 3_600_000;
const roster: DeferredObjectiveRoster = {
  objectivesByDeviceId: { ev: { enabled: true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80, deadlineAtMs } },
};
const devices = [{ id: 'ev', name: 'Charger' }];
const plan = (patch: Partial<OverviewDeferredObjectiveActivePlan> = {}): OverviewDeferredObjectiveActivePlan => ({
  pending: false,
  targetValue: 80,
  deviceName: 'Saved charger',
  deadlineAtMs,
  liveCompletion: { kind: 'unavailable' },
  latest: {
    revision: 1,
    revisedAtMs: nowMs,
    computedFromPricesUpTo: null,
    reason: 'flow_card',
    hours: [],
    energyNeededKWh: 4,
    planStatus: 'on_track',
  },
  ...patch,
});
const prices = (hasCurrentPrice: boolean, scheme = 'norway'): SettingsUiPricesPayload => (
  partialDouble<SettingsUiPricesPayload>({
    combinedPrices: {
      priceScheme: scheme,
      prices: hasCurrentPrice ? [{ startsAt: new Date(nowMs).toISOString(), total: 1 }] : [],
    },
  })
);
const resolve = (
  currentPlan: OverviewDeferredObjectiveActivePlan,
  currentPrices: SettingsUiPricesPayload | null = prices(true),
) => resolveOverviewSmartTaskStatuses(roster, { version: 2, plansByDeviceId: { ev: currentPlan } }, devices,
  currentPrices, nowMs);

describe('Overview current smart-task status', () => {
  it('omits a queued cached risk but shows its price-off blocker', () => {
    const current = plan();
    if (current.latest === null) throw new Error('fixture needs a revision');
    const queued = plan({
      latest: { ...current.latest, planStatus: 'at_risk' },
      diagnosticReasonCode: 'objective_waiting_for_plan',
      pendingReason: 'awaiting_horizon_plan',
    });
    expect(resolve(queued)).toEqual([]);
    expect(resolve({ ...queued, diagnosticReasonCode: 'objective_price_feature_disabled' }))
      .toEqual([expect.objectContaining({ tone: 'warn', headline: 'Respond to prices is off' })]);
  });

  it('explains price-off even when an old on-track revision and reached car limit remain', () => {
    const rows = resolve(plan({
      diagnosticReasonCode: 'objective_price_feature_disabled',
      carChargeLimit: { limitValue: 70, reached: true },
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceName: 'Charger', tone: 'warn', headline: 'Respond to prices is off',
      action: { targetTab: 'price-aware-devices' },
    });
    expect(resolve(plan())).toEqual([]);
  });

  it('shows ordinary tomorrow-price waiting without a warning', () => {
    const [row] = resolve(plan({ pending: true, latest: null, pendingReason: 'awaiting_horizon_plan' }));
    expect(row).toMatchObject({ tone: 'muted', headline: 'Waiting for tomorrow’s prices' });
    expect(row.action).toEqual({ label: 'View task', href: './?page=deadline-plan&deviceId=ev' });
  });

  it('distinguishes missing current prices from a normal future horizon wait', () => {
    const [row] = resolve(plan({ pending: true, latest: null, pendingReason: 'awaiting_horizon_plan' }), prices(false));
    expect(row).toMatchObject({
      tone: 'warn', headline: 'PELS has no electricity prices', action: { targetTab: 'electricity-prices' },
    });
  });

  it('keeps the existing source-aware Flow explanation without declaring it broken', () => {
    const [row] = resolve(
      plan({ pending: true, latest: null, pendingReason: 'awaiting_horizon_plan' }), prices(true, 'flow'),
    );
    expect(row.tone).toBe('muted');
    expect(row.headline).toBe('Waiting for tomorrow’s prices from your Flow');
    expect(row.body).toContain('Set external prices (tomorrow)');
  });

  it('does not mistake a prices read still loading for missing prices', () => {
    expect(resolve(plan({ pending: true, latest: null, pendingReason: 'awaiting_horizon_plan' }), null)).toEqual([]);
    expect(resolve(plan({ pending: true, latest: null, pendingReason: 'price_feature_disabled' }), null))
      .toHaveLength(1);
  });

  it.each(['objective_device_unmanaged', 'objective_device_in_sub_home'] as const)(
    'uses the current exclusion %s ahead of a cached plan and old pending reason', (diagnosticReasonCode) => {
      const [row] = resolve(plan({ diagnosticReasonCode, pendingReason: 'awaiting_horizon_plan' }));
      expect(row.tone).toBe('warn');
      expect(row.headline).not.toContain('prices');
    },
  );

  it('preserves the reached-car-limit explanation instead of saying to plug in', () => {
    const [row] = resolve(plan({
      diagnosticReasonCode: 'objective_invalid_session', carChargeLimit: { limitValue: 70, reached: true },
    }));
    expect(row.tone).toBe('warn');
    expect(row.body).toContain('charge limit');
    expect(row.body).not.toContain('Plug');
  });

  it('explains an unplugged car and missing device data through the existing task copy', () => {
    const [unplugged] = resolve(plan({ diagnosticReasonCode: 'objective_invalid_session' }));
    const [missingData] = resolve(plan({ pending: true, latest: null, pendingReason: 'device_data_missing' }));
    expect(unplugged.tone).toBe('warn');
    expect(unplugged.headline).toContain('paused');
    expect(missingData.tone).toBe('warn');
    expect(missingData.action).toMatchObject({ targetTab: 'overview', deviceId: 'ev' });
  });

  it('keeps a new lower car limit from hiding a live waiting-for-car reason', () => {
    const [row] = resolve(plan({ diagnosticReasonCode: 'objective_waiting_for_car' }));
    expect(row.headline).toBe('Waiting to identify the connected car');
  });

  it('reuses the detail reason for deadline risks and cannot-finish tasks', () => {
    const currentPlan = plan();
    if (currentPlan.latest === null) throw new Error('fixture needs a revision');
    const [row] = resolve(plan({ latest: {
      ...currentPlan.latest, planStatus: 'cannot_meet', floorShortfallCause: 'budget',
    } }));
    expect(row).toMatchObject({
      tone: 'alert', headline: 'Cannot finish', body: deadlineLabels('ev_soc').cannotMeetDailyBudgetExhausted,
    });
    expect(row.action).toMatchObject({ label: 'View task' });
  });

  it('does not show successful, normally queued, or transient tasks as blocked', () => {
    const currentPlan = plan();
    if (currentPlan.latest === null) throw new Error('fixture needs a revision');
    expect(resolve(currentPlan)).toEqual([]);
    expect(resolve(plan({ latest: { ...currentPlan.latest, planStatus: 'satisfied' } }))).toEqual([]);
    expect(resolve(plan({ latest: {
      ...currentPlan.latest, hours: [{ startsAtMs: nowMs + 1000, endsAtMs: deadlineAtMs, plannedKWh: 4 }],
    } }))).toEqual([]);
    expect(resolve(plan({ pending: true, latest: null, pendingReason: 'not_yet_planned' }))).toEqual([]);
  });

  it('filters disabled and expired objectives and tolerates a missing plan read', () => {
    const activePlans: OverviewDeferredObjectiveActivePlans = { version: 2, plansByDeviceId: { ev: plan({
      pending: true, latest: null, pendingReason: 'price_feature_disabled',
    }) } };
    for (const objective of [
      { ...roster.objectivesByDeviceId.ev, enabled: false },
      { ...roster.objectivesByDeviceId.ev, deadlineAtMs: nowMs },
    ]) {
      expect(resolveOverviewSmartTaskStatuses({ objectivesByDeviceId: { ev: objective } }, activePlans, devices,
        prices(true), nowMs)).toEqual([]);
    }
    expect(resolveOverviewSmartTaskStatuses(roster, null, devices, prices(true), nowMs)).toEqual([]);
  });

  it('uses a safe device label and keeps mixed waits below actionable warnings', () => {
    const secondRoster: DeferredObjectiveRoster = {
      objectivesByDeviceId: { ...roster.objectivesByDeviceId, other: roster.objectivesByDeviceId.ev },
    };
    const rows = resolveOverviewSmartTaskStatuses(secondRoster, { version: 2, plansByDeviceId: {
      ev: plan({ pending: true, latest: null, pendingReason: 'awaiting_horizon_plan' }),
      other: plan({ deviceName: undefined, pending: true, latest: null, pendingReason: 'price_feature_disabled' }),
    } }, devices, prices(true), nowMs);
    expect(rows.map((row) => row.tone)).toEqual(['warn', 'muted']);
    expect(rows[0].deviceName).toBe('Device');
  });
});
