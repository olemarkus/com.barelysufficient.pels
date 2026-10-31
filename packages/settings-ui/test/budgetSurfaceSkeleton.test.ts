import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The Budget panel ships a first-paint skeleton (`aria-busy` + a visually
// hidden "Loading budget…") in `public/index.html`. Once the budget read
// resolves, the surface must stop announcing itself as loading — including
// when Daily budget is off, where the rendered tree is a short "off" hero.

const INDEX_HTML_PATH = path.resolve(__dirname, '..', 'public', 'index.html');

const mountStaticBudgetSurface = (): void => {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const surface = parsed.querySelector('#budget-redesign-surface');
  if (!surface) throw new Error('index.html lost #budget-redesign-surface');
  const panel = document.createElement('section');
  panel.id = 'budget-panel';
  panel.append(document.importNode(surface, true));
  document.body.replaceChildren(panel);
};

describe('Budget surface first-paint skeleton', () => {
  beforeEach(() => {
    vi.resetModules();
    mountStaticBudgetSurface();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('stays busy until the read resolves', async () => {
    expect(document.body.textContent).toContain('Loading budget…');
    const { initBudgetRedesignHandlers } = await import('../src/ui/budgetRedesign.ts');
    initBudgetRedesignHandlers(() => {});
    expect(document.querySelector('#budget-redesign-surface[aria-busy="true"]')).not.toBeNull();
  });

  it('clears aria-busy and the loading text once the read resolves with Daily budget off', async () => {
    const { initBudgetRedesignHandlers, renderBudgetRedesign } = await import('../src/ui/budgetRedesign.ts');
    initBudgetRedesignHandlers(() => {});
    renderBudgetRedesign(null, 'today', { unit: 'kr', divisor: 100 });

    expect(document.querySelector('[aria-busy]')).toBeNull();
    expect(document.querySelector('[data-budget-skeleton]')).toBeNull();
    expect(document.querySelector('.pels-skeleton-stack')).toBeNull();
    expect(document.body.textContent).not.toContain('Loading budget…');
    // The real (off) page rendered in its place.
    expect(document.querySelector('#budget-redesign-surface')?.childElementCount).toBeGreaterThan(0);
  });
});
