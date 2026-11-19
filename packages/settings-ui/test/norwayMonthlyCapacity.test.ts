import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import type { NorwayMonthlyCapacityRead } from '../../contracts/src/norwayMonthlyCapacity.ts';
import { classifyNorwayMonthlyCapacity } from '../src/ui/norwayMonthlyCapacityRead.ts';
import { MonthlyCapacityCard, MonthlyCapacityOverview } from '../src/ui/views/NorwayMonthlyCapacity.tsx';

type Ready = Extract<NorwayMonthlyCapacityRead, { state: 'ready' }>;
const ready = (patch: Partial<Ready> = {}): Ready => ({
  state: 'ready', monthKey: '2026-11', tariffIdentity: 'grid', coverage: 'complete',
  peaks: [{ dateKey: '2026-11-18', hourStartMs: Date.parse('2026-11-18T09:00:00Z'), kw: 5.01 }],
  average: { state: 'collecting', days: 1 }, tier: { lowerKw: 2, upperKw: 5 },
  targetBoundaryKw: 5, targetLost: false, remainingMonthCap: { state: 'bounded', limitKw: 4.9 },
  hardCapRecommendation: { state: 'set', limitKw: 4.9, marginKw: 0.2 },
  advice: { state: 'suggestion', limitKw: 4.9, version: 'v1', direction: 'lower', actionable: true },
  ...patch,
});
const mount = (): HTMLElement => {
  const node = document.createElement('div'); document.body.append(node); return node;
};
afterEach(() => { document.body.replaceChildren(); });

describe('monthly capacity presentation', () => {
  it('applies directly from Usage, disables a pending action, and shows the outcome', () => {
    const onApply = vi.fn();
    const read = ready({ coverage: 'partial', advice: { state: 'suggestion',
      limitKw: 4.8, version: 'lower', direction: 'lower', actionable: true } });
    const node = mount();
    render(h(MonthlyCapacityCard, { read, nowMs: 0, onApply }), node);
    const button = node.querySelector('md-filled-tonal-button');
    expect(button?.textContent).toContain('Use 4.8 kW this month');
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(node.textContent).toContain('Some hours are missing');
    expect(node.textContent).not.toContain('Recommended Hard cap:');
    render(h(MonthlyCapacityCard, { read, nowMs: 0, busy: true, onApply }), node);
    expect(node.querySelector('md-filled-tonal-button')?.hasAttribute('disabled')).toBe(true);
    render(h(MonthlyCapacityCard, { read, nowMs: 0, message: 'The advice changed.' }), node);
    expect(node.querySelector('[role="status"]')?.textContent).toBe('The advice changed.');
  });
  it('shows the accepted monthly cap, expiry, and a direct cancel action', () => {
    const onCancel = vi.fn();
    const read = ready({ advice: { state: 'none' } });
    const node = mount();
    render(h(MonthlyCapacityCard, { read, nowMs: 0, onCancel, choice: {
      state: 'active', normalLimitKw: 5,
      offer: { monthKey: '2026-11', tariffIdentity: 'grid', limitKw: 4.8, revision: 'lower' },
    } }), node);
    expect(node.textContent).toContain('4.8 kW Hard cap in use');
    expect(node.textContent).toContain('normal 5 kW Hard cap returns on 1 December');
    const cancel = node.querySelector('.monthly-capacity-choice md-text-button');
    cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps the remaining cap visible without a change suggestion and labels missing peak days', () => {
    const read = ready({
      coverage: 'partial', advice: { state: 'none' },
      peaks: [{ dateKey: '2026-11-18', hourStartMs: Date.parse('2026-11-18T15:00:00Z'),
        kw: 1.42, lowerBound: true }],
    });
    const node = mount(); render(h(MonthlyCapacityCard, { read, nowMs: Date.parse('2026-11-18T15:30:00Z') }), node);
    expect(node.textContent).toContain('Hourly cap this month');
    expect(node.textContent).toContain('≤ 4.9 kW');
    expect(node.textContent).toContain('Some hours are missing');
    expect(node.textContent).toContain('Three highest daily hours');
    expect(node.querySelectorAll('.monthly-capacity-peaks li')).toHaveLength(3);
    expect(node.textContent?.match(/Not recorded/g)).toHaveLength(2);
    expect(node.querySelector('md-filled-tonal-button')).toBeNull();
  });

  it('explains the recommended hourly cap, its expiry and where the margin is reserved', () => {
    const read = ready({ remainingMonthCap: { state: 'bounded', limitKw: 4.8 },
      hardCapRecommendation: { state: 'set', limitKw: 4.8, marginKw: 0.3 },
      advice: { state: 'suggestion', limitKw: 4.8, version: 'v1', direction: 'lower', actionable: true } });
    const node = mount(); render(h(MonthlyCapacityCard, { read, nowMs: 0 }), node);
    expect(node.textContent).toContain('≤ 4.8 kW');
    expect(node.textContent).toContain('Use 4.8 kW this month');
    expect(node.textContent).toContain('Normal cap resumes on 1 December');
    expect(node.textContent).toContain('reserves 0.3 kW below the Hard cap for unmanaged usage late in the hour');
    expect(node.querySelector('details')?.open).toBe(false);
    render(h(MonthlyCapacityCard, { read: { ...read,
      hardCapRecommendation: { state: 'keep', limitKw: 4.8, marginKw: 0.3 } }, nowMs: 0 }), node);
    expect(node.textContent).toContain('Keep Hard cap at 4.8 kW');
    expect(node.querySelector('[data-settings-target="limits"]')).toBeNull();
  });

  it('qualifies the keep-current cap when the hourly history is incomplete', () => {
    const read = ready({ coverage: 'partial', targetLost: true,
      remainingMonthCap: { state: 'keep_current', limitKw: 5 }, hardCapRecommendation: { state: 'none' }, advice: { state: 'none' } });
    const node = mount(); render(h(MonthlyCapacityCard, { read, nowMs: 0 }), node);
    const cap = node;
    expect(cap?.textContent).toContain('Keep the current Hard cap');
    expect(cap?.textContent).toContain('5 kW');
    expect(node.textContent).toContain('Some hours are missing');
    expect(cap?.textContent).not.toContain('protect');
  });

  it('explains how a new high day changes the recorded average before the user expands the details', () => {
    const read = ready({ monthKey: '2026-12', coverage: 'partial',
      average: { state: 'recorded', kw: 4.92 },
      peaks: [5.17, 4.94, 4.66].map((value, index) => ({ dateKey: `2026-12-${15 + index}`,
        hourStartMs: Date.UTC(2026, 11, 15 + index), kw: value })),
    });
    const node = mount(); render(h(MonthlyCapacityCard, { read, nowMs: 0 }), node);
    node.querySelector('details')?.remove();
    expect(node.textContent).toContain('top three daily peaks average 4.92 kW');
    expect(node.textContent).toContain('replace the 4.66 kW peak');
    expect(node.textContent).toContain('hourly cap helps keep that average below 5 kW');
    expect(node.textContent).toContain('Normal cap resumes on 1 January');
    const overview = mount();
    render(h(MonthlyCapacityOverview, { read }), overview);
    expect(overview.textContent).toContain('Lower this month’s Hard cap to 4.9 kW?');
    expect(overview.querySelector('[data-settings-target="usage"]')?.textContent).toBe('Review monthly cap');
  });

  it('rejects a missing or malformed remaining-cap read rather than inventing one', () => {
    for (const remainingMonthCap of [undefined, { state: 'bounded', limitKw: 0 },
      { state: 'bounded', limitKw: Number.NaN }, { state: 'unknown' }]) {
      expect(classifyNorwayMonthlyCapacity({ ...ready(), remainingMonthCap }))
        .toEqual({ state: 'unavailable', reason: 'tariff' });
    }
  });

  it('shows the counted unfinished hour as a lower bound alongside the raised tier', () => {
    const read = ready({
      peaks: [
        { dateKey: '2026-11-18', hourStartMs: Date.parse('2026-11-18T11:00:00Z'), kw: 6, lowerBound: true },
        { dateKey: '2026-11-17', hourStartMs: Date.parse('2026-11-17T11:00:00Z'), kw: 4.9 },
        { dateKey: '2026-11-16', hourStartMs: Date.parse('2026-11-16T11:00:00Z'), kw: 4.9 },
      ],
      average: { state: 'recorded', kw: 5.27 }, tier: { lowerKw: 5, upperKw: 10 }, targetLost: true,
      advice: { state: 'suggestion', limitKw: 9.9, version: 'v2', direction: 'raise', actionable: true },
    });
    const node = mount(); render(h(MonthlyCapacityCard, { read, nowMs: Date.parse('2026-11-18T11:30:00Z') }), node);
    expect(node.textContent).toContain('Estimated 5–10 kW tier');
    expect(node.textContent).toContain('average at least 5.27 kW');
    expect(node.textContent).toContain('≥ 6 kW');
    expect(node.textContent).toContain('partial hour');
    expect(classifyNorwayMonthlyCapacity(read).state).toBe('ready');
  });

  it('shows a valid unbounded tariff without inventing a capacity boundary', () => {
    const read = ready({ targetBoundaryKw: null, remainingMonthCap: { state: 'unbounded_tier' }, hardCapRecommendation: { state: 'none' },
      advice: { state: 'none' },
      tier: { lowerKw: 100, upperKw: null }, average: { state: 'recorded', kw: 105 } });
    const node = mount(); render(h(MonthlyCapacityCard, { read, nowMs: 0 }), node);
    expect(node.textContent).toContain('no upper tariff boundary');
    expect(node.textContent).toContain('100 kW and above');
    expect(node.textContent).not.toContain('unavailable');
    expect(classifyNorwayMonthlyCapacity(read).state).toBe('ready');
  });

  it('explains a recoverable overshoot without claiming a three-day average', () => {
    const node = mount();
    render(h(MonthlyCapacityCard, { read: ready(), nowMs: Date.parse('2026-11-18T11:00:00Z') }), node);
    expect(node.textContent).toContain('1 of 3 daily peaks recorded');
    expect(node.textContent).toContain('today');
    expect(node.textContent).toContain('≤ 4.9 kW');
    expect(node.textContent).not.toContain('Estimated 2–5');
    expect(node.querySelector('md-filled-tonal-button')?.textContent).toContain('Use 4.9 kW this month');
  });
  it('withholds direct and manual raise actions when hourly history is incomplete', () => {
    const read = ready({ coverage: 'partial', advice: { state: 'suggestion',
      limitKw: 9.9, version: 'v2', direction: 'raise', actionable: false } });
    const node = mount();
    render(h(MonthlyCapacityCard, { read, nowMs: 0 }), node);
    expect(node.textContent).toContain('Some hours are missing');
    expect(node.querySelector('[data-settings-target="limits"]')).toBeNull();
    expect(node.querySelector('md-filled-tonal-button')).toBeNull();
    expect(node.textContent).not.toContain('Use 9.9 kW this month');
    render(h(MonthlyCapacityOverview, { read }), node);
    expect(node.textContent).toBe('');
  });
  it('shows a proven loss before three days instead of only collection progress', () => {
    const read = ready({ targetLost: true });
    const node = mount(); render(h(MonthlyCapacityCard, { read, nowMs: 0 }), node);
    expect(node.textContent).toContain('tier below 5 kW is already out of reach');
    expect(node.textContent).toContain('1 of 3 daily peaks recorded');
  });
  it('links a missing grid company to price setup', () => {
    const node = mount();
    render(h(MonthlyCapacityCard, { read: { state: 'unavailable', reason: 'grid_company' }, nowMs: 0 }), node);
    expect(node.querySelector('[data-settings-target="electricity-prices"]')).not.toBeNull();
  });
  it('rejects poisoned numeric transport without rendering it', () => {
    const read = ready({ peaks: [{ dateKey: '2026-11-18', hourStartMs: 0, kw: Number.NaN }] });
    expect(classifyNorwayMonthlyCapacity(read)).toEqual({ state: 'unavailable', reason: 'tariff' });
    expect(classifyNorwayMonthlyCapacity(undefined)).toEqual({ state: 'hidden' });
  });
});
