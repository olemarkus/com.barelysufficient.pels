import { afterEach, describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { DeadlinePlanHistoryDetail } from '../src/ui/views/DeadlinePlanHistoryDetail.tsx';
import type { ResolvedDeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory.ts';
import { planHistoryEntry } from './helpers/planHistoryEntry.ts';
import { STYLE_CSS, styleRule } from './helpers/primitiveStyles.ts';

const mounts: HTMLElement[] = [];
const renderHistory = (entry: ResolvedDeferredObjectivePlanHistoryEntry): HTMLElement => {
  const mount = document.createElement('div');
  mounts.push(mount);
  render(h(DeadlinePlanHistoryDetail, { entry, timeZone: 'UTC' }), mount);
  return mount;
};

afterEach(() => {
  for (const mount of mounts.splice(0)) render(null, mount);
});

describe('native button primitive', () => {
  // The scoped rule must also win against Homey's host button stylesheet.
  it.each(['.pels-button', '#deadline-plan-panel button.pels-button.pels-button'])(
    '%s preserves touch targets, keyboard focus, and disabled state',
    (selector) => {
      expect(styleRule(selector)).toMatch(/min-height:\s*var\(--pels-touch-target-min\)/);
      expect(styleRule(`${selector}:focus-visible`)).toMatch(/outline:\s*2px\s+solid\s+var\(--accent\)/);
      expect(styleRule(`${selector}:disabled`)).toMatch(/opacity:\s*var\(--opacity-disabled\)/);
      expect(styleRule(`${selector}:disabled`)).toMatch(/cursor:\s*not-allowed/);
    },
  );

  it.each([
    '.plan-history-detail__chart-toggle.plan-history-detail__chart-toggle',
    '#deadline-plan-panel button.plan-history-detail__chart-toggle.plan-history-detail__chart-toggle',
  ])('%s keeps the chart disclosure quiet and leaves room for its title', (selector) => {
    const declarations = styleRule(selector);
    expect(declarations).toMatch(/background:\s*transparent/);
    expect(declarations).toMatch(/width:\s*auto/);
    expect(declarations).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('puts the scoped chart decorator after the equally specific filled-button rule', () => {
    const button = STYLE_CSS.indexOf('#deadline-plan-panel button.pels-button.pels-button {');
    const toggle = STYLE_CSS.indexOf(
      '#deadline-plan-panel button.plan-history-detail__chart-toggle.plan-history-detail__chart-toggle {',
    );
    expect(button).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(button);
  });

  it('binds history recourse to the shared shell and delegated destination', () => {
    const mount = renderHistory({
      ...planHistoryEntry(), outcome: 'missed', finalProgressValue: 58, metAtMs: null,
    });
    expect(mount.querySelector('button.pels-button[data-deadline-recourse-tab="overview"]')).not.toBeNull();
  });

  it('gives the chart disclosure the shared shell and expanded-state semantics', () => {
    const entry = planHistoryEntry();
    entry.originalPlan = {
      hours: [], energyNeededKWh: 22.5, planStatus: 'on_track', revisedAtMs: entry.startedAtMs,
    };
    const toggle = renderHistory(entry).querySelector('button.pels-button.plan-history-detail__chart-toggle');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  });
});
