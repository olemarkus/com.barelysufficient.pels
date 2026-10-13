import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { PlanHistoryCard } from '../src/ui/views/DeadlinePlanHistory.tsx';
import { PlanCardShell } from '../src/ui/views/PlanDeviceCards.tsx';
import { uiDeviceFixture } from './helpers/deviceStatusFixture.ts';
import { planHistoryEntry } from './helpers/planHistoryEntry.ts';
import { STYLE_CSS, styleRule } from './helpers/primitiveStyles.ts';

const expectDecorativeEffects = (card: Element | null): void => {
  expect(card).not.toBeNull();
  for (const tag of ['md-ripple', 'md-elevation']) {
    expect(card?.querySelector(`:scope > ${tag}`)?.getAttribute('aria-hidden')).toBe('true');
  }
};

describe('card primitive', () => {
  it('owns the reusable surface geometry, elevation, and ripple tint', () => {
    const surface = styleRule('.pels-surface-card');
    for (const declaration of [
      'padding: var(--pels-card-padding)',
      'gap: var(--pels-card-gap)',
      'border: 1px solid var(--pels-surface-outline)',
      'border-radius: var(--pels-card-radius)',
      'background: var(--pels-surface-container-lowest)',
      '--md-elevation-level: 1',
      '--md-ripple-hover-color:',
      '--md-ripple-pressed-color:',
    ]) expect(surface).toContain(declaration);
  });

  it('keeps status colour on chips and only gives muted cards a neutral surface tone', () => {
    expect(styleRule('.pels-surface-card[data-tone="muted"]'))
      .toContain('background: var(--pels-surface-container-low)');
    for (const tone of ['good', 'warn', 'alert', 'info']) {
      expect(STYLE_CSS).not.toContain(`.pels-surface-card[data-tone="${tone}"]`);
    }
  });

  it.each(['.plan-history-card', '.deadline-list-card', '.detail-diagnostics-card'])(
    '%s base decorates the shared surface without redefining its shape',
    (selector) => {
      // Print rules deliberately replace the screen surface and shadow.
      const pattern = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`);
      const base = STYLE_CSS.match(pattern)?.[1] ?? '';
      const declarations = selector === '.deadline-list-card'
        ? base.replace(/background:\s*var\(--pels-surface-container-high\)\s*;?/g, '')
        : base;
      expect(declarations).not.toMatch(/(?:background|border|border-radius|padding|box-shadow)\s*:/);
    },
  );

  it('lets shared elevation own the interactive task-card surface', () => {
    expect(styleRule('.deadline-list-card:hover')).not.toMatch(/background\s*:/);
    expect(styleRule('.deadline-list-card:focus-visible')).not.toMatch(/background\s*:/);
  });

  it.each(['.pels-surface-card[data-interactive]', '.plan-card'])(
    '%s shares interactive elevation and keyboard focus',
    (selector) => {
      expect(styleRule(`${selector}:hover`)).toContain('--md-elevation-level: 3');
      expect(styleRule(`${selector}:active`)).toContain('--md-elevation-level: 2');
      expect(styleRule(`${selector}:focus-visible`)).toContain('outline: 2px solid var(--color-focus-ring)');
    },
  );

  it.each(['generic', 'temperature', 'stepped'] as const)(
    'renders a %s device card through the shared surface with decorative effects',
    (kind) => {
      const mount = document.createElement('div');
      render(h(PlanCardShell, {
        dev: uiDeviceFixture({ id: 'heater', name: 'Heater' }),
        dryRun: false, nowMs: 1_000, kind, leadingChip: null, children: null,
      }), mount);
      const card = mount.querySelector('.pels-surface-card.plan-card');
      expectDecorativeEffects(card);
      expect(card?.getAttribute('role')).toBe('button');
      expect(card?.getAttribute('tabindex')).toBe('0');
    },
  );

  it('renders past-task cards as interactive shared surfaces', () => {
    const mount = document.createElement('div');
    render(h(PlanHistoryCard, { entry: planHistoryEntry(), timeZone: 'UTC' }), mount);
    const card = mount.querySelector('a.pels-surface-card.plan-history-card[data-interactive]');
    expectDecorativeEffects(card);
  });

  it.each(['usage-card', 'budget-redesign-card'])('%s markup uses the shared surface', (decorator) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const cards = new DOMParser().parseFromString(html, 'text/html').querySelectorAll(`.${decorator}`);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card.classList.contains('pels-surface-card')).toBe(true);
  });
});
