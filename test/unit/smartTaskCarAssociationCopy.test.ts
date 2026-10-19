import { describe, expect, it } from 'vitest';
import {
  deadlineLabels,
  resolveSmartTaskListStatus,
  resolveSmartTaskPreviewUnavailableCopy,
  resolveSmartTaskWidgetDetailCopy,
} from '../../packages/shared-domain/src/deadlineLabels';

const waitingCopy = 'Waiting to identify the connected car';

describe('smart-task car association', () => {
  it('shares the identification reason across preview, task details, and widget', () => {
    expect(resolveSmartTaskPreviewUnavailableCopy('waiting_for_car')).toBe(waitingCopy);
    const hero = deadlineLabels('ev_soc').pendingHeroByReason.waiting_for_car({
      priceSource: 'managed', hasCurrentPrice: true, lastFetchedShort: null,
      deviceId: 'charger', deviceName: 'Driveway', deadlineTime: '07:00',
    });
    expect(hero.headline).toBe(waitingCopy);
    expect(hero.body).toContain('Confirm the connected car');
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'building_plan', pendingReason: 'waiting_for_car',
    }).whyLabel).toBe(waitingCopy);
    expect(resolveSmartTaskPreviewUnavailableCopy('progress_stale')).not.toBe(waitingCopy);
  });

  it('overrides a cached plan and car limit when the connected car is unidentified', () => {
    expect(resolveSmartTaskListStatus({
      liveCompletion: { kind: 'unavailable' }, pending: false,
      diagnosticReasonCode: 'objective_waiting_for_car',
      latest: { planStatus: 'on_track', hours: [{ startsAtMs: 1, plannedKWh: 1 }] },
      carChargeLimit: { limitValue: 50, reached: true }, targetValue: 80,
    }, 0)).toBe('building_plan');
    expect(resolveSmartTaskWidgetDetailCopy({
      statusId: 'building_plan', diagnosticReasonCode: 'objective_waiting_for_car',
      pendingReason: 'awaiting_horizon_plan',
    }).whyLabel).toBe(waitingCopy);
  });
});
