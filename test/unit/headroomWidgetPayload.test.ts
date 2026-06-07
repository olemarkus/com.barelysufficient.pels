/**
 * @vitest-environment node
 */
import { buildHeadroomWidgetPayload, EMPTY_SUBTITLE_DEFAULT } from '../../widgets/headroom/src/headroomWidgetPayload';

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
      limitState: 'under',
      stale: false,
    });
  });

  test('reports at_pace (not danger) when draw reaches safe pace under the hard cap', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 0, hourlyLimitKw: 6.3, hardCapHeadroomKw: 1.7 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', currentKw: 6.3, limitState: 'at_pace' });
  });

  test('reports near when approaching but below the safe pace', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 0.5, hourlyLimitKw: 6 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', limitState: 'near' });
  });

  test('reports over_cap only when hard-cap headroom is negative', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 0, hourlyLimitKw: 6.3, hardCapHeadroomKw: -0.4 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', limitState: 'over_cap' });
  });

  test('exposes the over-cap overage as the positive magnitude of negative hard-cap headroom', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 0, hourlyLimitKw: 6.3, hardCapHeadroomKw: -1.4 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', limitState: 'over_cap', overageKw: 1.4 });
  });

  test('reports zero overage when under the hard cap', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 1, hourlyLimitKw: 6.3, hardCapHeadroomKw: 1.7 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', overageKw: 0 });
  });

  test('reports zero overage when hard-cap headroom is absent', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: 1, hourlyLimitKw: 6.3 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', overageKw: 0 });
  });

  test('does not escalate to over_cap when hard-cap headroom is absent', () => {
    const payload = buildHeadroomWidgetPayload({
      status: { headroomKw: -0.5, hourlyLimitKw: 6 },
      nowMs: NOW,
    });
    expect(payload).toMatchObject({ state: 'ready', limitState: 'at_pace' });
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
