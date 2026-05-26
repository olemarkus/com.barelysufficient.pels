/**
 * @vitest-environment node
 */
import { buildHeadroomWidgetPayload, EMPTY_SUBTITLE_DEFAULT } from '../widgets/headroom/src/headroomWidgetPayload';

const NOW = new Date('2026-03-19T10:00:00.000Z').getTime();

describe('buildHeadroomWidgetPayload', () => {
  test('returns empty payload when status missing', () => {
    const payload = buildHeadroomWidgetPayload({ status: null, nowMs: NOW });
    expect(payload).toEqual({ state: 'empty', subtitle: EMPTY_SUBTITLE_DEFAULT });
  });

  test('renders last-known data with stale flag when power not yet known', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { powerKnown: false, headroomKw: 1, hourlyLimitKw: 7, lastPowerUpdate: NOW - 5_000 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', currentKw: 6, hourBudgetKw: 7, stale: true });
  });

  test('derives current draw from hourly limit minus headroom', () => {
    const payload = buildHeadroomWidgetPayload({
      status: {
        headroomKw: 3.8,
        hourlyLimitKw: 7,
        devicesOff: 2,
        priceLevel: 'cheap',
        lastPowerUpdate: NOW - 5_000,
      },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({
      state: 'ready',
      currentKw: 3.2,
      hourBudgetKw: 7,
      headroomKw: 3.8,
      shedCount: 2,
      priceLevel: 'cheap',
      stale: false,
    });
  });

  test('clamps negative current to zero', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 8, hourlyLimitKw: 7 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', currentKw: 0 });
  });

  test('flags stale when last power update is older than 90s', () => {
    const payload = buildHeadroomWidgetPayload({
      status: {
        headroomKw: 1,
        hourlyLimitKw: 5,
        lastPowerUpdate: NOW - 120_000,
      },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', stale: true });
  });

  test('maps unknown price level to "unknown"', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 1, hourlyLimitKw: 5, priceLevel: undefined },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', priceLevel: 'unknown' });
  });
});
